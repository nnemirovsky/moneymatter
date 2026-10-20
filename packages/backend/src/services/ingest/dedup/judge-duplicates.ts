import { AI_FEATURE, type RecordId } from '@bt/shared/types';
import { AI_MAX_OUTPUT_TOKENS, aiCallGuards, createAIClient } from '@services/ai';
import { createShortIds } from '@services/ai/short-ids';
import { trackAiUsage } from '@services/ai/track-ai-usage';
import { Output, generateText } from 'ai';

import { takeIngestAiCall } from '../event/ai-daily-limit';
import {
  buildJudgeSystemPrompt,
  buildJudgeUserMessage,
  judgeOutputSchema,
  readJudgement,
  type JudgedMatch,
  type JudgeSubject,
} from './judge-prompt';

/** A candidate row to put to the judge: its id and what the judge reads of it. */
export interface JudgeCandidateRow extends JudgeSubject {
  id: RecordId;
}

/**
 * Asks the `duplicateMatching` connection which candidates record the same payment as the new row.
 * It only reads: the matches come back best first, with no threshold applied, and nothing is stored.
 *
 * - No AI client (no connection, a spent monthly cap) or a spent daily limit answers `[]` without a
 *   call.
 * - A failed call throws, so the caller decides what a failure means. The call has no tools and the
 *   payment texts go in as untrusted data.
 */
export const judgeDuplicates = async ({
  userId,
  payment,
  candidates,
  locale,
}: {
  userId: number;
  payment: JudgeSubject;
  candidates: readonly JudgeCandidateRow[];
  locale: string;
}): Promise<JudgedMatch[]> => {
  if (!candidates.length) return [];

  const aiClient = await createAIClient({ userId, feature: AI_FEATURE.duplicateMatching });
  if (!aiClient) return [];
  if (!(await takeIngestAiCall({ userId }))) return [];

  const shortIds = createShortIds({ ids: candidates.map((candidate) => candidate.id), prefix: 'c' });
  const prompt = buildJudgeUserMessage({
    payment,
    locale,
    candidates: candidates.map((candidate) => ({ ...candidate, alias: shortIds.aliasOf({ id: candidate.id }) ?? '' })),
  });

  const { abortSignal, maxRetries } = aiCallGuards({ provider: aiClient.provider });
  const result = await generateText({
    model: aiClient.model,
    output: Output.object({ schema: judgeOutputSchema, name: 'duplicate_judgement' }),
    system: buildJudgeSystemPrompt(),
    prompt,
    abortSignal,
    maxRetries,
    maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
  });
  await trackAiUsage({ userId, feature: AI_FEATURE.duplicateMatching, aiClient, usage: result.usage });

  return readJudgement({ output: result.output, idByAlias: shortIds.idByAlias });
};
