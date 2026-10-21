/**
 * Limits of the hold-and-release rule. It is an object, not bare constants, so a test can shorten a
 * window without waiting out the real figure.
 *
 * - `windowMs`: a payment cancels out the opposite one only when the two are at most this far apart.
 * - `reversalWindowMs`: the window when the later notification announces itself as a reversal
 *   ("Reversal: 1.00 GEL"): a bank reverses a hold long after it was placed.
 */
export const holdReleaseConfig = {
  windowMs: 10 * 60_000,
  reversalWindowMs: 24 * 60 * 60_000,
};
