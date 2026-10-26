import { CARD_LAST_DIGITS_PATTERN, type NotificationIgnoreReason, type NotificationParkReason } from '@bt/shared/types';
import { z } from 'zod';

import { cleanText } from '../card-payment/clean-text';
import { parseAmount } from '../card-payment/parse-amount';
import { isOwnCardLabel } from '../conversion/conversion-rule';
import type { NotificationText } from './notification-text';

/**
 * What a notification says it is. `debit` and `credit` are payments; the rest are read and dropped
 * (`declined`, `security`, `promo`, `info`, `other` are also the ignore reasons of the request).
 */
const NOTIFICATION_KINDS = ['debit', 'credit', 'declined', 'security', 'promo', 'info', 'other'] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Where a notification sits in a payment's life at the bank: `authorization` is the hold, `settlement`
 * is the bank posting that hold, `payment` is a single notice that reports the whole payment. The
 * dedup slot of a bank notification is `bank:<sourceKey>:<stage>`.
 */
const NOTIFICATION_STAGES = ['authorization', 'settlement', 'payment'] as const;

type NotificationStage = (typeof NOTIFICATION_STAGES)[number];

/**
 * What a stated balance covers: `account` is this account or card in its own currency, `total` is the
 * sum over the bank's accounts or currencies, `unknown` is anything the text does not settle.
 */
export const BALANCE_SCOPE_HINTS = ['account', 'total', 'unknown'] as const;

export type BalanceScopeHint = (typeof BALANCE_SCOPE_HINTS)[number];

/** A payment read with less confidence than this waits for the user instead of being logged. */
export const NOTIFICATION_MIN_CONFIDENCE = 0.6;

/** Banks print ISO 4217 codes; a custom currency code never appears in a notification. */
const ISO_CURRENCY_CODE = /^[A-Z]{3}$/u;

const MERCHANT_MAX_LENGTH = 200;
const CARD_NAME_MAX_LENGTH = 100;

/**
 * The object `notificationParsing` answers with (`notification_parse`). Every field is required and
 * nullable, the shape structured-output providers accept. Only the enums are strict; every other
 * field is checked, and dropped when invalid, by `classifyNotification`.
 */
export const notificationParseSchema = z.object({
  kind: z.enum(NOTIFICATION_KINDS),
  stage: z.enum(NOTIFICATION_STAGES),
  isOwnAccountTransfer: z.boolean(),
  amount: z.string().nullable(),
  currency: z.string().nullable(),
  originalAmount: z.string().nullable(),
  originalCurrency: z.string().nullable(),
  merchant: z.string().nullable(),
  payee: z.object({ candidateId: z.string().nullable(), newName: z.string().nullable() }).nullable(),
  cardName: z.string().nullable(),
  cardLastDigits: z.string().nullable(),
  balanceAfter: z
    .object({ amount: z.string(), currency: z.string().nullable(), scopeHint: z.enum(BALANCE_SCOPE_HINTS) })
    .nullable(),
  occurredAt: z.string().nullable(),
  confidence: z.number(),
});

export type NotificationParseOutput = z.infer<typeof notificationParseSchema>;

/** The payee the parser picked: an existing one from the candidate list, or a clean name for a new one. */
type ParsedPayeeChoice = { type: 'candidate'; payeeId: string } | { type: 'new'; name: string };

/** The balance a notification states after the payment. `amount` is a signed decimal string. */
export interface ParsedBalanceAfter {
  amount: string;
  currencyCode: string;
  scopeHint: BalanceScopeHint;
}

/** A payment as a parser read it. Amounts are decimal strings, ready for `Money.fromDecimal`. */
export interface ParsedPayment {
  kind: 'debit' | 'credit';
  stage: NotificationStage;
  /** Positive. */
  amount: string;
  /** Null when the text states no currency; the account's currency settles it. */
  currencyCode: string | null;
  originalAmount: string | null;
  originalCurrencyCode: string | null;
  /** The merchant or counterparty exactly as the notification prints it. */
  merchant: string | null;
  payee: ParsedPayeeChoice | null;
  cardName: string | null;
  cardLastDigits: string | null;
  balanceAfter: ParsedBalanceAfter | null;
  /** The time the text states for the payment, when it states one. */
  occurredAt: Date | null;
}

/**
 * The verdict on one notification:
 *
 * - `payment`: log it;
 * - `park`: a payment that needs the user (`ownTransfer`, `lowConfidence`, `unverifiedParse`). `payment` is what was read,
 *   so a forced retry can still log it; null when no usable amount was read;
 * - `ignore`: read, not a payment.
 *
 * `parser` says which reader produced it and `kind` what the notification is, so a non-payment can be
 * stored as `{ parser, kind, confidence }` and nothing else.
 */
export type ClassifiedNotification = {
  parser: 'wallet' | 'ai' | 'rules';
  kind: NotificationKind;
  confidence: number;
} & (
  | { verdict: 'payment'; payment: ParsedPayment }
  | {
      verdict: 'park';
      reason: Extract<NotificationParkReason, 'ownTransfer' | 'lowConfidence' | 'unverifiedParse'>;
      payment: ParsedPayment | null;
    }
  | { verdict: 'ignore'; reason: NotificationIgnoreReason }
);

const clampConfidence = ({ value }: { value: number }): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

const readText = ({ value, maxLength }: { value: string | null | undefined; maxLength: number }): string | null => {
  const cleaned = typeof value === 'string' ? cleanText({ value }).slice(0, maxLength).trim() : '';

  return cleaned || null;
};

const readCurrency = ({ value }: { value: string | null | undefined }): string | null => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';

  return ISO_CURRENCY_CODE.test(code) ? code : null;
};

const PLAIN_DECIMAL = /^(\d{1,15})(?:\.(\d{1,8}))?$/u;

/**
 * The prompt asks for a plain decimal with a `.` and no grouping, so a string of exactly that shape is
 * read as written: `1.500` is one and a half, not fifteen hundred. Anything else is a human-written
 * amount and goes through `parseAmount`.
 */
const readDecimal = ({
  value,
}: {
  value: string;
}): { amount: string; isZero: boolean; currencyCode: string | null } | null => {
  const plain = PLAIN_DECIMAL.exec(value.trim());

  if (plain) {
    const integer = plain[1]!.replace(/^0+(?=\d)/u, '');
    const fraction = (plain[2] ?? '').replace(/0+$/u, '');

    return {
      amount: fraction ? `${integer}.${fraction}` : integer,
      isZero: /^0*$/u.test(integer + fraction),
      currencyCode: null,
    };
  }

  const parsed = parseAmount({ input: value });
  if (parsed.ok) return { amount: parsed.amount, isZero: false, currencyCode: parsed.currencyCode };

  return parsed.reason === 'zero' ? { amount: '0', isZero: true, currencyCode: null } : null;
};

/** A positive amount, with the currency its text carries (`"43.60 EUR"`) when it carries one. */
const readPositiveAmount = ({ value }: { value: string | null | undefined }) => {
  if (typeof value !== 'string') return null;

  const read = readDecimal({ value });

  return read && !read.isZero ? { amount: read.amount, currencyCode: read.currencyCode } : null;
};

/** A balance may be zero or negative (an overdraft), unlike a payment. */
const readBalanceAmount = ({ value }: { value: string }): { amount: string; currencyCode: string | null } | null => {
  const negative = /[-−–(]/u.test(value);
  const read = readDecimal({ value: value.replace(/[-−–()]/gu, ' ') });
  if (!read) return null;

  return { amount: negative && !read.isZero ? `-${read.amount}` : read.amount, currencyCode: read.currencyCode };
};

const readBalanceAfter = ({
  balance,
}: {
  balance: NotificationParseOutput['balanceAfter'];
}): ParsedBalanceAfter | null => {
  if (!balance) return null;

  const read = readBalanceAmount({ value: balance.amount });
  const currencyCode = readCurrency({ value: balance.currency }) ?? read?.currencyCode ?? null;
  if (!read || !currencyCode) return null;

  return { amount: read.amount, currencyCode, scopeHint: balance.scopeHint };
};

/** A date with a time of day; a date alone, or a date at exactly midnight, is how a model writes "the text names only a day". */
const TIME_OF_DAY = /^\d{4}-\d{2}-\d{2}[T ](?!00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?$)\d{2}:\d{2}/u;

const readOccurredAt = ({ value }: { value: string | null }): Date | null => {
  if (!value || !TIME_OF_DAY.test(value.trim())) return null;

  const date = new Date(value.trim());

  return Number.isNaN(date.getTime()) ? null : date;
};

/** The merchant as printed, or null when the text prints only the name of the user's own card ("EXAMPLE CARD"). */
const readMerchant = ({
  merchant,
  cardName,
  appName,
}: {
  merchant: string | null;
  cardName: string | null;
  appName: string | null;
}): string | null => {
  const text = readText({ value: merchant, maxLength: MERCHANT_MAX_LENGTH });

  return text !== null &&
    isOwnCardLabel({
      merchant: text,
      cardName: readText({ value: cardName, maxLength: CARD_NAME_MAX_LENGTH }),
      appName,
    })
    ? null
    : text;
};

const readPayee = ({
  payee,
  candidateIds,
}: {
  payee: NotificationParseOutput['payee'];
  candidateIds: ReadonlyMap<string, string>;
}): ParsedPayeeChoice | null => {
  if (!payee) return null;

  // An alias the model was never shown resolves to nothing, so an invented id cannot name a payee.
  const payeeId = payee.candidateId ? candidateIds.get(payee.candidateId.trim()) : undefined;
  if (payeeId) return { type: 'candidate', payeeId };

  const name = readText({ value: payee.newName, maxLength: MERCHANT_MAX_LENGTH });

  return name ? { type: 'new', name } : null;
};

const readCardLastDigits = ({ value, text }: { value: string | null; text: string | null }): string | null => {
  const digits = typeof value === 'string' ? value.replace(/\D/gu, '') : '';
  if (!CARD_LAST_DIGITS_PATTERN.test(digits)) return null;

  // Digits the text does not print are the model's invention (a phone number, a balance, a guess).
  return text === null || printsCardDigits({ text, digits }) ? digits : null;
};

/** The text the model read: title, subtitle and body, or the device's own rendering when all are empty. */
const readableTextOf = ({ text }: { text: NotificationText }): string => {
  const fields = [text.title, text.subtitle, text.body].filter(Boolean).join('\n');

  return fields || text.raw || '';
};

/** Characters a bank masks the rest of a card number with: `*1258`, `•1258`, `**** 1258`. */
const MASK_BEFORE = /(?:[*•·…]+[ \u00a0]*|[xX×]+)$/u;
/** A digit right before or after, past at most one separator: the run is part of a longer number. */
const DIGIT_BEFORE = /\d[ \u00a0\u202f.,'’-]?$/u;
const DIGIT_AFTER = /^[ \u00a0\u202f.,'’-]?\d/u;

/**
 * Whether the text prints `digits` as a card's digits: the exact run of digits, after a mask, or on its
 * own. A run that is a piece of a longer number (a phone number, a balance, a date, a reference) does
 * not count, so the model cannot pass off such digits as the card's.
 */
const printsCardDigits = ({ text, digits }: { text: string; digits: string }): boolean => {
  for (const match of text.matchAll(/\d+/gu)) {
    if (match[0] !== digits) continue;

    const before = text.slice(0, match.index);
    const after = text.slice(match.index + digits.length);
    if (MASK_BEFORE.test(before)) return true;
    if (!DIGIT_BEFORE.test(before) && !DIGIT_AFTER.test(after)) return true;
  }

  return false;
};

/** `1500`, `1500.5`: a decimal without trailing zeros, so differently written equal amounts compare equal. */
const canonicalDecimal = ({ value }: { value: string }): string => {
  const [integer = '0', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/u, '');
  const whole = integer.replace(/^0+(?=\d)/u, '');

  return trimmed ? `${whole}.${trimmed}` : whole;
};

/**
 * The values a number written in a notification may stand for, as canonical decimals. Spaces and
 * apostrophes group thousands; with both `.` and `,` the last one is the decimal point; a lone `,` or
 * `.` is a decimal point before one or two digits, a thousands separator before groups of three, and
 * either before exactly three (`1.500`).
 */
const readingsOf = ({ token }: { token: string }): string[] => {
  const compact = token.replace(/[ \u00a0\u202f'’]/gu, '');
  const lastDot = compact.lastIndexOf('.');
  const lastComma = compact.lastIndexOf(',');

  if (lastDot >= 0 && lastComma >= 0) {
    const decimalAt = Math.max(lastDot, lastComma);
    const integer = compact.slice(0, decimalAt).replace(/[.,]/gu, '');

    return [canonicalDecimal({ value: `${integer}.${compact.slice(decimalAt + 1)}` })];
  }

  const separator = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : null;
  if (!separator) return [canonicalDecimal({ value: compact })];

  const parts = compact.split(separator);
  const grouped = canonicalDecimal({ value: parts.join('') });
  if (parts.length > 2) return parts.slice(1).every((part) => part.length === 3) ? [grouped] : [];

  const fraction = parts[1]!;
  const decimal = canonicalDecimal({ value: `${parts[0]}.${fraction}` });
  if (fraction.length === 3) return [grouped, decimal];

  return [decimal];
};

/** Whether some number the text prints equals `amount` once its separators are read. */
const printsAmount = ({ text, amount }: { text: string; amount: string }): boolean => {
  const wanted = canonicalDecimal({ value: amount });
  const tokens = text.match(/\d(?:[\d.,'’ \u00a0\u202f]*\d)?/gu) ?? [];

  return tokens.some((token) => {
    // "*1258 3 000,00" is several numbers as well as one: every run of its space-separated pieces is read.
    const pieces = token.split(/[ \u00a0\u202f]+/u);

    return pieces.some((_, start) =>
      pieces
        .slice(start)
        .some((__, length) =>
          readingsOf({ token: pieces.slice(start, start + length + 1).join(' ') }).includes(wanted),
        ),
    );
  });
};

const readPayment = ({
  output,
  kind,
  candidateIds,
  text,
  appName,
}: {
  output: NotificationParseOutput;
  kind: 'debit' | 'credit';
  candidateIds: ReadonlyMap<string, string>;
  text: string | null;
  appName: string | null;
}): ParsedPayment | null => {
  const amount = readPositiveAmount({ value: output.amount });
  if (!amount) return null;

  const currencyCode = readCurrency({ value: output.currency }) ?? readCurrency({ value: amount.currencyCode });
  const original = readPositiveAmount({ value: output.originalAmount });
  const originalCurrencyCode =
    readCurrency({ value: output.originalCurrency }) ?? readCurrency({ value: original?.currencyCode });
  // Both halves or neither; the same currency on both sides is no conversion at all.
  const hasOriginal = original !== null && originalCurrencyCode !== null && originalCurrencyCode !== currencyCode;

  return {
    kind,
    stage: output.stage,
    amount: amount.amount,
    currencyCode,
    originalAmount: hasOriginal ? original.amount : null,
    originalCurrencyCode: hasOriginal ? originalCurrencyCode : null,
    merchant: readMerchant({ merchant: output.merchant, cardName: output.cardName, appName }),
    payee: readPayee({ payee: output.payee, candidateIds }),
    cardName: readText({ value: output.cardName, maxLength: CARD_NAME_MAX_LENGTH }),
    cardLastDigits: readCardLastDigits({ value: output.cardLastDigits, text }),
    balanceAfter: readBalanceAfter({ balance: output.balanceAfter }),
    occurredAt: readOccurredAt({ value: output.occurredAt }),
  };
};

/**
 * Turns the model's answer into a verdict. Nothing the model says is trusted as it is:
 *
 * - a kind that is not a payment is ignored under its own name;
 * - a payment with no readable amount, an own-account transfer, or a confidence under
 *   `NOTIFICATION_MIN_CONFIDENCE` is parked, never logged. Only payments are held to the confidence
 *   bar: a non-payment has nothing to log, and the amount gate already let its text through;
 * - with the notification `text`, what the model copied out of it is checked against it: card digits
 *   the text does not print (on their own or after a mask, not inside a longer number) are dropped,
 *   and a payment whose amount no number in the text equals is parked as `unverifiedParse`;
 * - every other field is read defensively and dropped when invalid (currency codes, digits, the
 *   time), a `candidateId` outside `candidateIds` included.
 *
 * `candidateIds` maps the short ids shown in the prompt to payee ids.
 */
export const classifyNotification = ({
  output,
  candidateIds,
  text,
  appName,
}: {
  output: NotificationParseOutput;
  candidateIds: ReadonlyMap<string, string>;
  /** The notification the model read; without it nothing is checked against the text. */
  text?: NotificationText;
  /** The app the notification came from, so its brand followed by "card" is read as the card, not a merchant. */
  appName?: string | null;
}): ClassifiedNotification => {
  const confidence = clampConfidence({ value: output.confidence });
  const base = { parser: 'ai', kind: output.kind, confidence } as const;

  if (output.kind !== 'debit' && output.kind !== 'credit') {
    return { ...base, verdict: 'ignore', reason: output.kind };
  }

  const readable = text ? readableTextOf({ text }) : null;
  const payment = readPayment({ output, kind: output.kind, candidateIds, text: readable, appName: appName ?? null });

  if (!payment) return { ...base, verdict: 'park', reason: 'lowConfidence', payment: null };
  if (readable !== null && !printsAmount({ text: readable, amount: payment.amount })) {
    return { ...base, verdict: 'park', reason: 'unverifiedParse', payment };
  }
  if (output.isOwnAccountTransfer) return { ...base, verdict: 'park', reason: 'ownTransfer', payment };
  if (confidence < NOTIFICATION_MIN_CONFIDENCE) return { ...base, verdict: 'park', reason: 'lowConfidence', payment };

  return { ...base, verdict: 'payment', payment };
};
