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
 */
export const notificationTimings = {
  waitBudgetMs: 10_000,
  pollIntervalMs: 250,
  foldMs: 5_000,
  retryBackoffMs: 5_000,
};

/** Per-user caps on stored notifications. Dropped notifications do not count. An object so a test can lower them. */
export const notificationLimits = {
  perHour: 120,
  perDay: 1000,
};

/** How many times the processing job runs before the request is parked as `processingFailed`. */
export const NOTIFICATION_JOB_ATTEMPTS = 4;
