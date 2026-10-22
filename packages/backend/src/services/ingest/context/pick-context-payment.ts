import type Transactions from '@models/transactions.model';

/** What `pickContextPayment` decided for a context notification. */
export type ContextPick =
  | { kind: 'none' }
  /** One open payment and no competing context: a certain match. */
  | { kind: 'sure'; transaction: Transactions }
  /** Several payments or competing contexts: the model weighs them, the nearest in time stands in. */
  | { kind: 'ambiguous'; candidates: Transactions[] };

/**
 * Whether the match is certain. Time is the only signal the bank text leaves (it says "Wolt" for both
 * of two orders), so a match is certain only with exactly one open payment and no other context of the
 * service waiting for one.
 */
export const pickContextPayment = ({
  open,
  competingContexts,
}: {
  open: readonly Transactions[];
  competingContexts: number;
}): ContextPick => {
  if (open.length === 0) return { kind: 'none' };
  if (open.length === 1 && competingContexts === 0) return { kind: 'sure', transaction: open[0]! };

  return { kind: 'ambiguous', candidates: [...open] };
};

/** The candidate nearest in time to `time`; the earlier one on a tie. */
export const nearestInTime = ({
  candidates,
  time,
}: {
  candidates: readonly Transactions[];
  time: Date;
}): Transactions =>
  candidates.reduce((best, candidate) => {
    const distance = Math.abs(candidate.time.getTime() - time.getTime());
    const bestDistance = Math.abs(best.time.getTime() - time.getTime());

    return distance < bestDistance || (distance === bestDistance && candidate.time < best.time) ? candidate : best;
  });
