/**
 * Limits of the hold-and-release rule. It is an object, not a bare constant, so a test can shorten
 * the window without waiting out the real figure.
 *
 * - `windowMs`: a payment cancels out the opposite one only when the two are at most this far apart.
 */
export const holdReleaseConfig = {
  windowMs: 10 * 60_000,
};
