/**
 * Time limits of the card-payment pipeline. It is an object, not bare constants, so a test can
 * shorten them without waiting out the real figures.
 *
 * - `repeatWindowMs`: a request counts as a repeat of an earlier logged payment when it carries
 *   the same fingerprint and was received within this many milliseconds of it.
 * - `aiWaitBudgetMs`: how long a request waits for the AI to categorize a row that is still in the
 *   default category before it answers "categorizing…". The wait is short because the shortcut
 *   waits for the answer.
 * - `aiPollIntervalMs`: how often the row is read while waiting.
 * - `interruptedAfterMs`: a `received` request older than this is taken to have lost its processing
 *   pass (the process died mid-way), so Settings offers it for retry; a younger one is in flight.
 */
export const cardPaymentTimings = {
  repeatWindowMs: 120_000,
  aiWaitBudgetMs: 8_000,
  aiPollIntervalMs: 250,
  interruptedAfterMs: 60_000,
};

/** `externalReference` is `<source>:<idempotency key>`: at most 32 + 1 + 128 characters. */
export const buildExternalReference = ({ source, idempotencyKey }: { source: string; idempotencyKey: string }) =>
  `${source}:${idempotencyKey}`;
