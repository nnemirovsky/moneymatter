import type { RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';

/** A payment is looked at as a settlement candidate from a day after it was notified: a hold settles later. */
export const SETTLEMENT_MIN_AGE_MS = 24 * 60 * 60_000;

/** And until ten days after: past that, a difference is more likely a movement of its own than a settlement. */
export const SETTLEMENT_MAX_AGE_MS = 10 * 24 * 60 * 60_000;

/** A hold settles within a few percent of its amount (the card network's rate moves, not the price). */
export const SETTLEMENT_MAX_SHARE = 0.05;

/** A payment in a foreign currency that is still at the amount its notice stated. */
export interface SettlementCandidate {
  id: RecordId;
  kind: 'debit' | 'credit';
  /** The amount booked on the account. */
  amount: Money;
  time: Date;
  /** The correction was proposed to the owner already. */
  proposed: boolean;
}

/**
 * Whether the gap between a stated balance and the account's own is the settlement of one earlier payment: the payment
 * was booked at a hold amount, and the bank settled it at another. The balance that is higher than ours means a debit
 * settled lower (or a credit higher), and the reverse for a lower one.
 *
 * Exactly one candidate must explain the gap: aged between a day and ten days at the time of the balance, and the gap
 * within 5% of its amount, leaving a positive amount. Two or none are no answer: the gap stays a missing transaction.
 */
export const pickSettlement = ({
  gap,
  candidates,
  at,
}: {
  /** The stated balance minus the account's own: positive when the account holds less than the bank says. */
  gap: Money;
  candidates: readonly SettlementCandidate[];
  /** When the balance was stated. */
  at: Date;
}): { candidate: SettlementCandidate; amount: Money } | null => {
  const fits = candidates.flatMap((candidate) => {
    const age = at.getTime() - candidate.time.getTime();
    if (age < SETTLEMENT_MIN_AGE_MS || age > SETTLEMENT_MAX_AGE_MS) return [];
    if (gap.abs().greaterThan(candidate.amount.multiply(SETTLEMENT_MAX_SHARE))) return [];

    const amount = candidate.kind === 'debit' ? candidate.amount.subtract(gap) : candidate.amount.add(gap);

    return amount.isPositive() ? [{ candidate, amount }] : [];
  });

  return fits.length === 1 ? fits[0]! : null;
};
