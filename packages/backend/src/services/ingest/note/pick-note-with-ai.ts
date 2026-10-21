import { AI_FEATURE } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { AI_MAX_OUTPUT_TOKENS, aiCallGuards, createAIClient } from '@services/ai';
import { trackAiUsage } from '@services/ai/track-ai-usage';
import { Output, generateText } from 'ai';

import { takeIngestAiCall } from '../event/ai-daily-limit';
import type { NoteCandidate } from './note-history';
import { buildNotePickSystemPrompt, buildNotePickUserMessage, notePickSchema } from './note-pick-prompt';

/**
 * Asks the `notificationParsing` model which of the owner's past notes at a payee fits a new payment,
 * from when and for how much each was used. The answer is one of `candidates`, verbatim, or `null`:
 * the model chooses, it never writes a note. No AI client or a spent daily limit makes no call; a
 * failed call is logged. Either way the note stays empty for the owner to write.
 */
export const pickNoteWithAi = async ({
  userId,
  payment,
  candidates,
  offsetMinutes,
}: {
  userId: number;
  payment: { amount: number; currencyCode: string; time: Date };
  candidates: readonly NoteCandidate[];
  offsetMinutes: number;
}): Promise<string | null> => {
  if (!candidates.length) return null;

  try {
    const aiClient = await createAIClient({ userId, feature: AI_FEATURE.notificationParsing });
    if (!aiClient) return null;
    if (!(await takeIngestAiCall({ userId }))) return null;

    const byAlias = new Map(candidates.map((candidate, index) => [`n${index + 1}`, candidate.note]));

    const { abortSignal, maxRetries } = aiCallGuards({ provider: aiClient.provider });
    const result = await generateText({
      model: aiClient.model,
      output: Output.object({ schema: notePickSchema, name: 'note_pick' }),
      system: buildNotePickSystemPrompt(),
      prompt: buildNotePickUserMessage({
        payment,
        offsetMinutes,
        candidates: candidates.map((candidate, index) => ({ ...candidate, alias: `n${index + 1}` })),
      }),
      abortSignal,
      maxRetries,
      maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    });
    await trackAiUsage({ userId, feature: AI_FEATURE.notificationParsing, aiClient, usage: result.usage });

    const candidateId = result.output.candidateId;

    return candidateId ? (byAlias.get(candidateId) ?? null) : null;
  } catch (error) {
    logger.error({ message: 'Failed to ask the AI for the note of a logged payment', error: error as Error });

    return null;
  }
};
