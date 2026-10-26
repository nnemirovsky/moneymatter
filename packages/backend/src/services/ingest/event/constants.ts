/**
 * Time limits of the notification pipeline. It is an object, not bare constants, so a test can
 * shorten them without waiting out the real figures.
 *
 * - `waitBudgetMs`: how long the endpoint waits for the processing job before it answers "queued".
 *   The wait is short because the shortcut waits for the answer.
 * - `pollIntervalMs`: how often the request row is read while waiting.
 * - `foldMs`: two notifications with the same text count as one when they were received within this
 *   many milliseconds of each other (the same notification on two devices, or a double fire).
 * - `retryBackoffMs`: the delay before the second attempt of a failed processing job; it doubles with
 *   every further attempt.
 * - `lockRetryDelayMs`: how long a job waits before it looks again while a base-currency change holds
 *   the user's lock. The wait uses no attempt.
 * - `categorizeWaitMs`: how long a logged payment waits for the AI to categorize it before the banner
 *   says "categorizing…". Shorter than the tap's wait, because the notification's own wait is shared
 *   with parsing.
 * - `interruptedAfterMs`: a `received` notification older than this lost its processing job and is
 *   offered for retry; a younger one is in flight.
 * - `unclassifiedTextTtlMs`: how long the text of a notification that was never classified is kept.
 * - `ignoredTtlMs`: how long a request that was read and is not a payment is kept.
 * - `aiRetryScheduleMs`: the waits between tries while the AI model is out of reach (a used-up quota, a rate limit, an
 *   overload): the delay before the first retry, the second and so on. Once the steps are spent the request waits for
 *   the owner. A reset time the provider reports pushes a step later (never earlier) when it is within a day and a half.
 * - `pendingSourceTtlMs`: a source nobody approved is deleted with what it holds after this long.
 */
export const notificationTimings = {
  waitBudgetMs: 10_000,
  pollIntervalMs: 250,
  foldMs: 5_000,
  retryBackoffMs: 5_000,
  lockRetryDelayMs: 60_000,
  categorizeWaitMs: 3_000,
  interruptedAfterMs: 30 * 60_000,
  unclassifiedTextTtlMs: 7 * 24 * 60 * 60_000,
  ignoredTtlMs: 7 * 24 * 60 * 60_000,
  pendingSourceTtlMs: 30 * 24 * 60 * 60_000,
  aiRetryScheduleMs: [5, 15, 60, 3 * 60, 6 * 60, 12 * 60, 12 * 60].map((minutes) => minutes * 60_000),
};

/**
 * Whether a plain bank push is read by its layout (`parseBankPushByRules`) before the AI is asked. An object so a test
 * of the AI reading can turn the rules off and keep feeding the model plain texts.
 */
export const notificationRules = {
  enabled: true,
};

/** Per-user caps on stored notifications. Dropped notifications do not count. An object so a test can lower them. */
export const notificationLimits = {
  perHour: 120,
  perDay: 1000,
};

/** How many times the processing job runs before the request is parked as `processingFailed`. */
export const NOTIFICATION_JOB_ATTEMPTS = 4;
