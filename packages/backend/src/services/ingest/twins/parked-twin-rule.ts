import { Money } from '@common/types/money';

import type { StoredPayment } from '../event/stored-parse';
import { merchantCoreName } from '../payee/merchant-core';

/** A parked payment as the twin rule reads it. */
export interface TwinProbe {
  payment: StoredPayment;
  /** When the notification was received. */
  time: Date;
  /** The dedup slot of the source that told of it (`wallet-notification`, `bank:<source>:<stage>`). */
  slot: string;
}

interface Figure {
  amount: Money;
  currencyCode: string | null;
}

const figuresOf = ({ payment }: { payment: StoredPayment }): Figure[] => [
  { amount: Money.fromDecimal(payment.amount), currencyCode: payment.currencyCode },
  ...(payment.originalAmount
    ? [{ amount: Money.fromDecimal(payment.originalAmount), currencyCode: payment.originalCurrencyCode }]
    : []),
];

/** The same amount, in the same currency when both state one. */
const sharesFigure = ({ left, right }: { left: StoredPayment; right: StoredPayment }): boolean =>
  figuresOf({ payment: left }).some((one) =>
    figuresOf({ payment: right }).some(
      (other) =>
        one.amount.equals(other.amount) &&
        (one.currencyCode === null || other.currencyCode === null || one.currencyCode === other.currencyCode),
    ),
  );

const wordsOf = ({ merchant }: { merchant: string }): string[] =>
  merchantCoreName({ raw: merchant }).split(' ').filter(Boolean);

/**
 * Whether two merchant texts name one business: equal cores, or the words of one stand whole inside
 * the other ("Temu" and "TEMU.COM LU"). Neither empty.
 */
export const isSameMerchant = ({ left, right }: { left: string | null; right: string | null }): boolean => {
  if (!left || !right) return false;

  const one = wordsOf({ merchant: left });
  const other = wordsOf({ merchant: right });
  if (!one.length || !other.length) return false;

  const [short, long] = one.length <= other.length ? [one, other] : [other, one];

  return short.every((word) => long.includes(word)) && short.join(' ').length >= 3;
};

/**
 * Two parked payments that are one payment told by two sources (Wallet's notification and the bank's
 * push of an online Apple Pay): the same direction, the same amount (in the same currency when both
 * state one), one business, within `windowMs`, and two different sources. The same source twice is two
 * payments (two coffees), exactly as the dedup slots of logged rows read it.
 */
export const isParkedTwin = ({
  left,
  right,
  windowMs,
}: {
  left: TwinProbe;
  right: TwinProbe;
  windowMs: number;
}): boolean =>
  left.slot !== right.slot &&
  left.payment.kind === right.payment.kind &&
  Math.abs(left.time.getTime() - right.time.getTime()) <= windowMs &&
  sharesFigure({ left: left.payment, right: right.payment }) &&
  isSameMerchant({ left: left.payment.merchant, right: right.payment.merchant });
