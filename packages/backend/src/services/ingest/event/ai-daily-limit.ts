import { RateLimitService } from '@services/common/rate-limit.service';

/** Calls a user may spend on notification parsing and duplicate judging in a day, unless the operator sets another figure. */
export const DEFAULT_INGEST_AI_DAILY_LIMIT = 300;

const WINDOW_SECONDS = 86_400;

/** `INGEST_AI_DAILY_LIMIT`, read on every call so an operator change and a test take effect at once. */
export const getIngestAiDailyLimit = (): number => {
  const parsed = Number(process.env.INGEST_AI_DAILY_LIMIT);

  return Number.isInteger(parsed) && parsed >= 0 && process.env.INGEST_AI_DAILY_LIMIT
    ? parsed
    : DEFAULT_INGEST_AI_DAILY_LIMIT;
};

/**
 * Counts one AI call of the ingest pipeline against the user's daily limit and says whether it may
 * go ahead. Parsing and the duplicate judge share the counter, so a flood of notifications cannot
 * run up the AI bill however many sources send them. A refused call is not counted again; a Redis
 * outage lets the call through, as every rate limit in the app does.
 */
export const takeIngestAiCall = async ({ userId }: { userId: number }): Promise<boolean> => {
  const limit = getIngestAiDailyLimit();
  if (limit === 0) return false;

  const result = await RateLimitService.checkRateLimit(`ingest-ai:d:${userId}`, WINDOW_SECONDS, limit);

  return result.allowed;
};
