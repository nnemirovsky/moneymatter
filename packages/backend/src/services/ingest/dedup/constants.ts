import { CARD_PAYMENT_AMOUNT_TOLERANCE } from '@services/transactions/planned-matching/card-payment-tolerance';

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
 * - `judgeWindowMs`: the AI judge looks for a duplicate this far from the new row, either way.
 * - `judgeSameSlotWindowMs`: two rows that hold the same source slot are two payments by the slot
 *   model (two coffees), so the judge only sees them as a pair when they are this close: a double fire
 *   where one run was held back past the tap fold window.
 * - `judgeMaxCandidates`: rows put to the judge for one new row.
 * - `judgeAmountTolerance`: a candidate's amount may differ from the new row's by this share (a tip,
 *   a rounded conversion); an equal charged amount qualifies whatever the amounts say.
 * - `scanMaxRows`: rows of one sync or import the scan job puts to the judge (the newest first); a
 *   first pull of a long history does not judge every row.
 * - `resolvedSuggestionRetentionDays`: a `merged` or `stale` suggestion is deleted this long after it
 *   was settled; a `dismissed` one is kept so the pair is never raised again.
 */
export const dedupConfig = {
  twinWindowMs: 30 * 60_000,
  settlementWindowMs: 7 * 24 * 60 * 60_000,
  conversionPairWindowMs: 60 * 60_000,
  conversionRateTolerance: '0.03',
  judgeWindowMs: 72 * 60 * 60_000,
  judgeSameSlotWindowMs: 30_000,
  judgeMaxCandidates: 5,
  judgeAmountTolerance: CARD_PAYMENT_AMOUNT_TOLERANCE,
  scanMaxRows: 100,
  resolvedSuggestionRetentionDays: 90,
};
