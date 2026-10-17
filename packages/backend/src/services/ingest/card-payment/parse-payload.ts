import type { CardPaymentRejectionReason } from '@bt/shared/types';

import { cleanText } from './clean-text';
import { amountInputToText, parseAmount } from './parse-amount';

export const CARD_PAYMENT_DEFAULT_SOURCE = 'card-payment';
export const CARD_PAYMENT_MERCHANT_MAX_LENGTH = 200;
export const CARD_PAYMENT_CARD_MAX_LENGTH = 100;
export const CARD_PAYMENT_NAME_MAX_LENGTH = 200;
/** A payment time may be this far after the request was received (clock skew). */
export const CARD_PAYMENT_TIME_AHEAD_MS = 5 * 60 * 1000;
/** A payment time may be this far before the request was received (a shortcut that ran late). */
export const CARD_PAYMENT_TIME_BEHIND_MS = 30 * 24 * 60 * 60 * 1000;

// Printable ASCII without spaces: a 64-character SHA-256 hex or a UUID fits.
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,128}$/;
const SOURCE_PATTERN = /^[a-z0-9-]{1,32}$/;
// ISO 8601 date and time with an offset (`Z`, `+04:00`, `+0400` or `+04`).
const TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)$/i;

/** A card payment that passed every check that needs no database. */
export interface ParsedCardPayment {
  kind: 'payment';
  idempotencyKey: string;
  source: string;
  /** A positive decimal string, safe for `Money.fromDecimal`. */
  amount: string;
  /** The amount field as sent, kept for the transaction's `externalData`. */
  rawAmount: string;
  /** A 3-letter code written in the amount text, upper-cased. */
  amountCurrencyCode: string | null;
  /** A currency symbol written in the amount text. */
  amountSymbol: string | null;
  /** The request's `currency` field, upper-cased; its shape is checked by `resolveCurrency`. */
  explicitCurrency: string | null;
  merchant: string;
  card: string;
  name: string | null;
  /** The payment time: the request's own when it sent one, the receive time otherwise. */
  time: Date;
  timeProvided: boolean;
}

/** A dry run only asks whether the connection and a card link work; nothing is validated or written. */
export interface ParsedDryRun {
  kind: 'dryRun';
  /** The card to look up, or `null` when none (usable) was sent. */
  card: string | null;
}

export type ParsePayloadResult =
  | ({ ok: true } & (ParsedCardPayment | ParsedDryRun))
  | { ok: false; reason: CardPaymentRejectionReason; field: string };

const reject = ({ reason, field }: { reason: CardPaymentRejectionReason; field: string }): ParsePayloadResult => ({
  ok: false,
  reason,
  field,
});

const isBlank = ({ value }: { value: unknown }): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * Reads an ISO 8601 timestamp with an offset. `Date.parse` is not used: it rolls `02-30` over to
 * March and accepts offset-less local times, and both would store a wrong payment time.
 */
const parseTime = ({ value }: { value: string }): Date | null => {
  const match = TIME_PATTERN.exec(value.trim());
  if (!match) return null;

  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  const second = Number(match[6] ?? 0);
  const millisecond = Number((match[7] ?? '').slice(0, 3).padEnd(3, '0'));
  const offset = match[8]!.toUpperCase();

  let offsetMinutes = 0;
  if (offset !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    const offsetHours = Number(digits.slice(0, 2));
    const offsetRest = Number(digits.slice(2) || 0);

    if (offsetHours > 23 || offsetRest > 59) return null;
    offsetMinutes = (offsetHours * 60 + offsetRest) * (offset.startsWith('-') ? -1 : 1);
  }

  const wallClock = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  const isRealDate =
    month >= 1 &&
    month <= 12 &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    wallClock.getUTCFullYear() === year &&
    wallClock.getUTCMonth() === month - 1 &&
    wallClock.getUTCDate() === day;

  return isRealDate ? new Date(wallClock.getTime() - offsetMinutes * 60_000) : null;
};

const readDryRunCard = ({ value }: { value: unknown }): string | null => {
  if (typeof value !== 'string') return null;

  const card = cleanText({ value });

  return card && card.length <= CARD_PAYMENT_CARD_MAX_LENGTH ? card : null;
};

/**
 * Validates a card-payment request body. Pure: everything that needs the database (the card
 * mapping, the currency lookup, the account) happens later.
 *
 * - `dryRun: true` makes every other field optional and only reads `card`.
 * - Text fields lose invisible and control characters and have their whitespace collapsed.
 * - The payment time and its window are measured from `receivedAt`, never from now, so a retry
 *   weeks later passes the same checks it passed on receipt.
 * - Unknown keys are ignored, so a newer shortcut keeps working against an older server.
 *
 * The first problem found is returned, in the order key, source, amount, currency, merchant,
 * card, name, time.
 */
export const parsePayload = ({ body, receivedAt }: { body: unknown; receivedAt: Date }): ParsePayloadResult => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return reject({ reason: 'invalidBody', field: 'body' });
  }

  const fields = body as Record<string, unknown>;

  if (fields.dryRun === true) return { ok: true, kind: 'dryRun', card: readDryRunCard({ value: fields.card }) };

  const idempotencyKey = fields.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return reject({ reason: 'invalidIdempotencyKey', field: 'idempotencyKey' });
  }

  const source = fields.source === undefined || fields.source === null ? CARD_PAYMENT_DEFAULT_SOURCE : fields.source;
  if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) {
    return reject({ reason: 'invalidSource', field: 'source' });
  }

  const parsedAmount = parseAmount({ input: fields.amount });
  if (!parsedAmount.ok) {
    const reasons = { invalid: 'invalidAmount', zero: 'zeroAmount', negative: 'negativeAmount' } as const;

    return reject({ reason: reasons[parsedAmount.reason], field: 'amount' });
  }

  let explicitCurrency: string | null = null;
  if (!isBlank({ value: fields.currency })) {
    if (typeof fields.currency !== 'string') return reject({ reason: 'invalidCurrency', field: 'currency' });
    explicitCurrency = fields.currency.trim().toUpperCase();
  }

  const merchant = typeof fields.merchant === 'string' ? cleanText({ value: fields.merchant }) : '';
  if (!merchant) return reject({ reason: 'blankMerchant', field: 'merchant' });
  if (merchant.length > CARD_PAYMENT_MERCHANT_MAX_LENGTH)
    return reject({ reason: 'merchantTooLong', field: 'merchant' });

  const card = typeof fields.card === 'string' ? cleanText({ value: fields.card }) : '';
  if (!card) return reject({ reason: 'blankCard', field: 'card' });
  if (card.length > CARD_PAYMENT_CARD_MAX_LENGTH) return reject({ reason: 'cardTooLong', field: 'card' });

  const name = typeof fields.name === 'string' ? cleanText({ value: fields.name }) : '';
  if (name.length > CARD_PAYMENT_NAME_MAX_LENGTH) return reject({ reason: 'nameTooLong', field: 'name' });

  let time = receivedAt;
  const timeProvided = !isBlank({ value: fields.time });
  if (timeProvided) {
    const parsedTime = typeof fields.time === 'string' ? parseTime({ value: fields.time }) : null;
    if (!parsedTime) return reject({ reason: 'invalidTime', field: 'time' });
    if (parsedTime.getTime() - receivedAt.getTime() > CARD_PAYMENT_TIME_AHEAD_MS) {
      return reject({ reason: 'timeInFuture', field: 'time' });
    }
    if (receivedAt.getTime() - parsedTime.getTime() > CARD_PAYMENT_TIME_BEHIND_MS) {
      return reject({ reason: 'timeTooOld', field: 'time' });
    }
    time = parsedTime;
  }

  return {
    ok: true,
    kind: 'payment',
    idempotencyKey,
    source,
    amount: parsedAmount.amount,
    rawAmount: cleanText({ value: amountInputToText({ input: fields.amount }) ?? '' }),
    amountCurrencyCode: parsedAmount.currencyCode,
    amountSymbol: parsedAmount.symbol,
    explicitCurrency,
    merchant,
    card,
    name: name || null,
    time,
    timeProvided,
  };
};
