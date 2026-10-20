import { AI_FEATURE, hasServerAiEntitlement, type NotificationParkReason } from '@bt/shared/types';
import { AI_MAX_OUTPUT_TOKENS, aiCallGuards, createAIClient } from '@services/ai';
import { isWithinAiAllowance } from '@services/ai/ai-allowance';
import { createShortIds } from '@services/ai/short-ids';
import { trackAiUsage } from '@services/ai/track-ai-usage';
import { getEntitlementsByUserId } from '@services/entitlements/resolve-entitlements.service';
import { resolveAiExtractionFailure } from '@services/import-export/core/ai-extraction-failure';
import { markConnectionValid } from '@services/user-settings/ai-connections';
import { Output, generateText } from 'ai';

import { takeIngestAiCall } from './ai-daily-limit';
import {
  type ClassifiedNotification,
  type NotificationParseOutput,
  classifyNotification,
  notificationParseSchema,
} from './classify-notification';
import {
  type PromptNotificationSource,
  buildNotificationSystemPrompt,
  buildNotificationUserMessage,
} from './notification-prompt';
import type { NotificationText } from './notification-text';
import type { PayeeCandidate } from './payee-candidates';

/** Why no AI call was made: the reasons a notification parks without being read. */
type AiUnavailableReason = Extract<NotificationParkReason, 'aiUnavailable' | 'aiCapReached' | 'aiLimitReached'>;

/** @public consumed by the processing job. */
export type NotificationAiResult =
  | { status: 'parsed'; classified: ClassifiedNotification }
  | { status: 'unavailable'; reason: AiUnavailableReason };

/**
 * No client means the user has no model that can answer. When the cause is the plan's monthly AI
 * allowance (the server model is the only one and it is spent), the reason is `aiCapReached`, which
 * clears itself when the month turns; otherwise nothing is set up and the reason is `aiUnavailable`.
 */
const describeMissingClient = async ({ userId }: { userId: number }): Promise<AiUnavailableReason> => {
  const entitlements = await getEntitlementsByUserId({ userId });
  const feature = AI_FEATURE.notificationParsing;

  if (hasServerAiEntitlement({ entitlements, feature }) && !(await isWithinAiAllowance({ userId, entitlements }))) {
    return 'aiCapReached';
  }

  return 'aiUnavailable';
};

/**
 * Reads one notification with the `notificationParsing` model.
 *
 * - No client → `unavailable` (`aiCapReached` when the monthly allowance is spent, else
 *   `aiUnavailable`); the daily limit is spent → `aiLimitReached`, with no call made.
 * - The call has no tools and gets the text as untrusted data. Its answer is validated by
 *   `classifyNotification`; a candidate id the model was not shown resolves to nothing.
 * - A failed call throws (after `resolveAiExtractionFailure` has flagged a dead connection), so the
 *   job retries it; the request parks as `processingFailed` once the attempts are used.
 *
 * `candidates` and `nonZeroCurrencies` are loaded by the caller: the payees the model may pick, and the
 * currencies the user holds money in at this bank.
 */
export const parseNotificationWithAi = async ({
  userId,
  text,
  source,
  candidates,
  nonZeroCurrencies,
}: {
  userId: number;
  text: NotificationText;
  source: PromptNotificationSource;
  candidates: readonly PayeeCandidate[];
  nonZeroCurrencies: readonly string[];
}): Promise<NotificationAiResult> => {
  const aiClient = await createAIClient({ userId, feature: AI_FEATURE.notificationParsing });
  if (!aiClient) return { status: 'unavailable', reason: await describeMissingClient({ userId }) };

  if (!(await takeIngestAiCall({ userId }))) return { status: 'unavailable', reason: 'aiLimitReached' };

  const shortIds = createShortIds({ ids: candidates.map((candidate) => candidate.payeeId), prefix: 'p' });
  const prompt = buildNotificationUserMessage({
    text,
    source,
    nonZeroCurrencies,
    candidates: candidates.map((candidate) => ({
      alias: shortIds.aliasOf({ id: candidate.payeeId }) ?? '',
      name: candidate.name,
      aliases: candidate.aliases,
    })),
  });

  let output: NotificationParseOutput;
  let usage: Awaited<ReturnType<typeof generateText>>['usage'];
  try {
    const { abortSignal, maxRetries } = aiCallGuards({ provider: aiClient.provider });
    const result = await generateText({
      model: aiClient.model,
      output: Output.object({ schema: notificationParseSchema, name: 'notification_parse' }),
      system: buildNotificationSystemPrompt(),
      prompt,
      abortSignal,
      maxRetries,
      maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    });
    output = result.output;
    usage = result.usage;
  } catch (error) {
    const failure = await resolveAiExtractionFailure({
      userId,
      aiClient,
      error,
      logPrefix: '[Notification Parse]',
    });
    throw new Error(failure.error.message, { cause: error });
  }

  await trackAiUsage({ userId, feature: AI_FEATURE.notificationParsing, aiClient, usage });
  if (aiClient.connectionId) await markConnectionValid({ userId, connectionId: aiClient.connectionId });

  return {
    status: 'parsed',
    classified: classifyNotification({ output, candidateIds: shortIds.idByAlias }),
  };
};
