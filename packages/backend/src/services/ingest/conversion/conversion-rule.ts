import type { RecordId } from '@bt/shared/types';

import type { StoredPayment } from '../event/stored-parse';

/** How far apart in time the two notices of one exchange may arrive: a bank sends them within seconds or minutes. */
export const CONVERSION_WINDOW_MS = 10 * 60 * 1000;

/**
 * What a bank prints in place of a merchant on the notice of a currency exchange, as `comparableLabel` reads it.
 * The bank's own words for the movement, never a business the owner paid.
 */
const GENERIC_LABELS: readonly string[] = [
  'money transfer',
  'deposit money',
  'conversion',
  'currency conversion',
  'exchange',
  'currency exchange',
  'fx',
];

const comparableLabel = ({ value }: { value: string }): string =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Whether the merchant is the name of the user's own card, not a business: the card's name as printed, a bare "card",
 * or the app's brand followed by "card" ("EXAMPLE CARD" in a push of the "Example Bank" app).
 */
export const isOwnCardLabel = ({
  merchant,
  cardName,
  appName,
}: {
  merchant: string;
  cardName: string | null;
  appName: string | null;
}): boolean => {
  const label = comparableLabel({ value: merchant });
  if (!label || label === 'card') return true;
  if (cardName !== null && comparableLabel({ value: cardName }) === label) return true;

  const brand = appName ? comparableLabel({ value: appName }).split(' ')[0] : null;

  return Boolean(brand) && label === `${brand} card`;
};

/**
 * Whether a payment names no business: no merchant at all, one of the bank's own words for a movement
 * ("Money Transfer", "Deposit Money"), or the name of the user's own card ("EXAMPLE CARD").
 */
export const hasNoMerchant = ({ merchant, cardName }: { merchant: string | null; cardName: string | null }): boolean =>
  !merchant ||
  GENERIC_LABELS.includes(comparableLabel({ value: merchant })) ||
  // The notices are paired on far more than the label, so any "... card" is enough here.
  /(?:^| )card$/u.test(comparableLabel({ value: merchant })) ||
  isOwnCardLabel({ merchant, cardName, appName: null });

/** One notice of a possible exchange: the payment it reported, when it arrived, and the source it came from. */
export interface ConversionLeg {
  payment: StoredPayment;
  time: Date;
  sourceId: RecordId | null;
}

/** The notices tell of one exchange when they are the two sides of it: money out in one currency, money in another. */
export const isConversionPair = ({
  left,
  right,
  windowMs = CONVERSION_WINDOW_MS,
}: {
  left: ConversionLeg;
  right: ConversionLeg;
  windowMs?: number;
}): boolean => {
  if (!left.sourceId || left.sourceId !== right.sourceId) return false;
  if (left.payment.kind === right.payment.kind) return false;

  const { currencyCode: leftCurrency } = left.payment;
  const { currencyCode: rightCurrency } = right.payment;
  if (!leftCurrency || !rightCurrency || leftCurrency === rightCurrency) return false;

  if (!hasNoMerchant(left.payment) || !hasNoMerchant(right.payment)) return false;

  return Math.abs(left.time.getTime() - right.time.getTime()) <= windowMs;
};

/** The two sides of an exchange: what left the owner and what arrived. */
export const sidesOf = <T extends { payment: StoredPayment }>({
  left,
  right,
}: {
  left: T;
  right: T;
}): { debit: T; credit: T } =>
  left.payment.kind === 'debit' ? { debit: left, credit: right } : { debit: right, credit: left };

/** The rate the bank gave: units of the incoming currency per one unit of the outgoing one, to four decimals. */
export const impliedRate = ({ debit, credit }: { debit: StoredPayment; credit: StoredPayment }): number | null => {
  const out = Number(debit.amount);
  const incoming = Number(credit.amount);
  if (!Number.isFinite(out) || !Number.isFinite(incoming) || out <= 0) return null;

  return Math.round((incoming / out) * 10_000) / 10_000;
};
