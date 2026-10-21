import { AI_FEATURE } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import PayeeAliases from '@models/payee-aliases.model';
import Payees from '@models/payees.model';
import { AI_MAX_OUTPUT_TOKENS, aiCallGuards, createAIClient } from '@services/ai';
import { createShortIds } from '@services/ai/short-ids';
import { trackAiUsage } from '@services/ai/track-ai-usage';
import { Output, generateText } from 'ai';

import { takeIngestAiCall } from '../event/ai-daily-limit';
import type { MerchantCoreCandidate } from './merchant-core';
import { buildPayeePickSystemPrompt, buildPayeePickUserMessage, payeePickSchema } from './payee-pick-prompt';
import { loadUsualCategoryNames } from './usual-categories';

/**
 * Asks the `notificationParsing` model which of the payees a merchant is equally close to is the
 * same business. The prompt shows each candidate's known spellings and usual categories, so the
 * kind of business can decide between similar names.
 *
 * Returns the chosen payee, or `null` when the model chose none. No AI client or a spent daily
 * limit makes no call; a failed call is logged. Either way the payment goes on without a payee and
 * the owner picks one on its confirm card.
 */
export const pickPayeeWithAi = async ({
  userId,
  merchant,
  candidates,
}: {
  userId: number;
  merchant: string;
  candidates: readonly MerchantCoreCandidate[];
}): Promise<string | null> => {
  if (candidates.length < 2) return null;

  try {
    const aiClient = await createAIClient({ userId, feature: AI_FEATURE.notificationParsing });
    if (!aiClient) return null;
    if (!(await takeIngestAiCall({ userId }))) return null;

    const ids = candidates.map((candidate) => candidate.payeeId);
    const [payees, usualCategories] = await Promise.all([
      Payees.findAll({
        where: { id: ids, userId },
        attributes: ['id', 'name'],
        include: [{ model: PayeeAliases, as: 'aliases', attributes: ['rawName'] }],
      }),
      loadUsualCategoryNames({ ownerUserId: userId, payeeIds: ids }),
    ]);
    const shortIds = createShortIds({ ids: payees.map((payee) => payee.id), prefix: 'p' });

    const { abortSignal, maxRetries } = aiCallGuards({ provider: aiClient.provider });
    const result = await generateText({
      model: aiClient.model,
      output: Output.object({ schema: payeePickSchema, name: 'payee_pick' }),
      system: buildPayeePickSystemPrompt(),
      prompt: buildPayeePickUserMessage({
        merchant,
        candidates: payees.map((payee) => ({
          alias: shortIds.aliasOf({ id: payee.id }) ?? '',
          name: payee.name,
          aliases: (payee.aliases ?? []).map((alias) => alias.rawName),
          usualCategories: usualCategories.get(payee.id) ?? [],
        })),
      }),
      abortSignal,
      maxRetries,
      maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    });
    await trackAiUsage({ userId, feature: AI_FEATURE.notificationParsing, aiClient, usage: result.usage });

    const candidateId = result.output.candidateId;

    return candidateId ? (shortIds.idByAlias.get(candidateId) ?? null) : null;
  } catch (error) {
    logger.error({
      message: 'Failed to ask the AI which payee a card payment belongs to; logging it without one',
      error: error as Error,
    });

    return null;
  }
};
