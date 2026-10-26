import { APICallError } from 'ai';

/** The AI failures that pass by themselves: a used-up quota or usage window, a rate limit, an overloaded provider. */
export type AiTransientKind = 'quota-exhausted' | 'rate-limited' | 'temporary';

/**
 * A notification could not be read now, and reading it later is expected to work. It is not a failure of the
 * request: the request waits and the job runs again at `retryAt` (or at the next step of the backoff schedule).
 */
export class AiTransientError extends Error {
  constructor(
    public readonly params: {
      kind: AiTransientKind;
      /** When the provider said the limit resets, if it said. */
      resetAt: Date | null;
      /** The AI connection the call ran on (`null`: the included server model). */
      connectionId: string | null;
      /** A name the owner knows the connection by. */
      connectionName: string;
      cause: Error;
    },
  ) {
    super(params.cause.message, { cause: params.cause });
    this.name = 'AiTransientError';
  }
}

export const isAiTransientKind = (kind: string): kind is AiTransientKind =>
  kind === 'quota-exhausted' || kind === 'rate-limited' || kind === 'temporary';

const MAX_RESET_WAIT_MS = 36 * 60 * 60_000;
const MIN_RESET_WAIT_MS = 60_000;

/** When the provider says the limit lifts: a CLI's `resetsAt`, or a `Retry-After` header (seconds or an HTTP date). */
export const readResetAt = ({ cause, now = new Date() }: { cause: Error; now?: Date }): Date | null => {
  if (!(cause instanceof APICallError)) return null;

  const data = cause.data as { resetsAt?: unknown } | undefined;
  if (typeof data?.resetsAt === 'string') {
    const date = new Date(data.resetsAt);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const header = cause.responseHeaders?.['retry-after'];
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return new Date(now.getTime() + seconds * 1000);

  const date = new Date(header);

  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * When the job runs again after the `attempt`-th transient failure (1-based): the reset time the provider reported,
 * kept between a minute and a day and a half from now, else the next step of `schedule`. `null` once the schedule is
 * spent, whatever the provider says, and the request waits for the owner.
 */
export const nextAiRetryAt = ({
  attempt,
  resetAt,
  schedule,
  now = new Date(),
}: {
  attempt: number;
  resetAt: Date | null;
  schedule: readonly number[];
  now?: Date;
}): Date | null => {
  if (attempt > schedule.length) return null;

  if (resetAt) {
    const wait = resetAt.getTime() - now.getTime();
    // A reset a few seconds away is about to pass: wait a minute, which is also what a past time becomes.
    if (wait <= MAX_RESET_WAIT_MS) return new Date(now.getTime() + Math.max(wait, MIN_RESET_WAIT_MS));
  }

  const delay = schedule[attempt - 1];

  return delay === undefined ? null : new Date(now.getTime() + delay);
};

/** What the request keeps between two tries, in its payload. */
export interface AiRetryState {
  /** How many times in a row the model was out of reach. */
  count: number;
  /** When the next try is due (ISO). */
  at: string | null;
  kind: AiTransientKind;
  connectionName: string;
  connectionId: string | null;
}

export const readAiRetry = ({ payload }: { payload: Record<string, unknown> }): AiRetryState | null => {
  const value = payload.aiRetry as Partial<AiRetryState> | undefined;
  if (!value || typeof value.count !== 'number') return null;

  return {
    count: value.count,
    at: typeof value.at === 'string' ? value.at : null,
    kind: value.kind ?? 'temporary',
    connectionName: typeof value.connectionName === 'string' ? value.connectionName : '',
    connectionId: typeof value.connectionId === 'string' ? value.connectionId : null,
  };
};

/** The time of the next try as the owner reads it: the clock time in their zone, with the day when it is not today. */
export const formatNextTry = ({
  at,
  timeZone,
  locale,
  now = new Date(),
}: {
  at: Date;
  timeZone: string;
  locale: string;
  now?: Date;
}): string => {
  const day = (date: Date) => date.toLocaleDateString('en-CA', { timeZone });
  const options: Intl.DateTimeFormatOptions =
    day(at) === day(now)
      ? { hour: '2-digit', minute: '2-digit', timeZone }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone };

  try {
    return new Intl.DateTimeFormat(locale, options).format(at);
  } catch {
    return at.toISOString();
  }
};
