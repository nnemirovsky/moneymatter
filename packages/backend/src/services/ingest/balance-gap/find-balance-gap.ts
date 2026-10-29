import { Money } from '@common/types/money';

/** A balance a bank states can differ from ours by rounding or by a small unlogged movement: up to this share of it. */
const TOLERANCE_SHARE = 0.01;
const TOLERANCE_FLOOR = Money.fromDecimal('0.5');

/**
 * What the balance a notification states says that the account's own balance does not: the stated balance minus the
 * balance the account holds with the payment booked. Positive when money arrived that is not logged, negative when
 * money left. `null` when the two agree within the tolerance.
 */
export const findBalanceGap = ({
  stated,
  held,
  tolerance: given,
}: {
  stated: Money;
  held: Money;
  /** Replaces the default tolerance: a settlement shifts a balance by cents, which the default would pass over. */
  tolerance?: Money;
}): Money | null => {
  const gap = stated.subtract(held);
  const share = stated.abs().multiply(TOLERANCE_SHARE);
  const tolerance = given ?? (share.greaterThan(TOLERANCE_FLOOR) ? share : TOLERANCE_FLOOR);

  return gap.abs().greaterThan(tolerance) ? gap : null;
};
