import type { AI_FEATURE } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { AI_MAX_OUTPUT_TOKENS, aiCallGuards, createAIClient } from '@services/ai';
import { trackAiUsage } from '@services/ai/track-ai-usage';
import { resolveAiExtractionFailure } from '@services/import-export/core/ai-extraction-failure';
import { markConnectionValid } from '@services/user-settings/ai-connections';
import { Output, generateText } from 'ai';
import type { z } from 'zod';

import { takeIngestAiCall } from '../event/ai-daily-limit';

type ContextModelResult<Schema extends z.ZodType> =
  | { status: 'ok'; output: z.infer<Schema> }
  | { status: 'unavailable' };

/**
 * One structured call of the context pipeline on the owner's own model. Every refusal and failure
 * comes back as `unavailable`: a context notification is an extra, so a missing model, a spent daily
 * limit or a failed call never retries the job or parks anything; the caller falls back.
 */
export const runContextModel = async <Schema extends z.ZodType>({
  userId,
  feature,
  schema,
  name,
  system,
  prompt,
}: {
  userId: number;
  feature: AI_FEATURE;
  schema: Schema;
  name: string;
  system: string;
  prompt: string;
}): Promise<ContextModelResult<Schema>> => {
  const aiClient = await createAIClient({ userId, feature });
  if (!aiClient) return { status: 'unavailable' };
  if (!(await takeIngestAiCall({ userId }))) return { status: 'unavailable' };

  try {
    const { abortSignal, maxRetries } = aiCallGuards({ provider: aiClient.provider });
    const result = await generateText({
      model: aiClient.model,
      output: Output.object({ schema, name }),
      system,
      prompt,
      abortSignal,
      maxRetries,
      maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    });

    await trackAiUsage({ userId, feature, aiClient, usage: result.usage });
    if (aiClient.connectionId) await markConnectionValid({ userId, connectionId: aiClient.connectionId });

    return { status: 'ok', output: result.output as z.infer<Schema> };
  } catch (error) {
    try {
      await resolveAiExtractionFailure({ userId, aiClient, error, logPrefix: `[Context ${name}]` });
    } catch (failure) {
      logger.error({ message: `Context model call ${name} failed`, error: failure as Error });
    }

    return { status: 'unavailable' };
  }
};
