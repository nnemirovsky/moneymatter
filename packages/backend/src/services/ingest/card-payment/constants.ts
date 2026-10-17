/**
 * A request counts as a repeat of an earlier logged payment when it carries the same fingerprint
 * and was received within this many milliseconds of it. It is an object, not a bare constant, so
 * a test can shorten the window without waiting two minutes.
 */
export const cardPaymentTimings = {
  repeatWindowMs: 120_000,
};

/** `externalReference` is `<source>:<idempotency key>`: at most 32 + 1 + 128 characters. */
export const buildExternalReference = ({ source, idempotencyKey }: { source: string; idempotencyKey: string }) =>
  `${source}:${idempotencyKey}`;
