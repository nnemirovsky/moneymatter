/**
 * Limits of the deterministic dedup rules. It is an object, not bare constants, so a test can
 * shorten a window without waiting out the real figure.
 *
 * - `twinWindowMs`: two sources are one payment only when they are at most this far apart.
 * - `settlementWindowMs`: a bank posts a hold within this long, so a settlement looks for its
 *   authorization this far back.
 * - `conversionPairWindowMs`: the two legs of a currency conversion (money out of one own account,
 *   the converted money into another) land within this long of each other.
 * - `conversionRateTolerance`: the legs' implied rate may differ from the day's rate by this share.
 */
export const dedupConfig = {
  twinWindowMs: 30 * 60_000,
  settlementWindowMs: 7 * 24 * 60 * 60_000,
  conversionPairWindowMs: 60 * 60_000,
  conversionRateTolerance: '0.03',
};
