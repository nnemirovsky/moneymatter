import type { ParsedPayment } from './classify-notification';
import type { NotificationText } from './notification-text';
import { findAmounts, linesOf, wordsPattern } from './parse-bank-push-by-rules';

/** One bank notice that reports a whole currency exchange: what was sold, what was bought, and usually the rate. */
export interface ConversionNotice {
  /** The money that left, in the first currency. */
  debit: ParsedPayment;
  /** The money that arrived, in the second currency. */
  credit: ParsedPayment;
}

const MAX_TEXT_LENGTH = 400;
/** The printed rate may differ from the ratio of the two amounts by this share (rounding in the bank's figures). */
const RATE_TOLERANCE = 0.01;

/** Words (several languages) that say a notice is about an exchange or its rate. */
const EXCHANGE_WORDS = wordsPattern({
  words: 'conver\\p{L}*|exchang\\p{L}*|rate|fx|курс\\p{L}*|обмен\\p{L}*|обмін\\p{L}*|конверт\\p{L}*',
});

/** Words of a notice that is not a finished exchange, or that makes the direction uncertain. */
const NOT_A_FINISHED_EXCHANGE = wordsPattern({
  words:
    'declin\\p{L}*|refus\\p{L}*|reject\\p{L}*|fail\\p{L}*|pending|cancel\\p{L}*|hold|received|credited|отказ\\p{L}*|отклон\\p{L}*|получен\\p{L}*|зачислен\\p{L}*|відмов\\p{L}*|отримано|зараховано',
});

const NUMBER = /(?<![\p{L}\p{N}.,])\d+(?:[.,]\d+)?(?![\p{L}\p{N}])/gu;

const toNumber = ({ value }: { value: string }): number => Number(value.replace(',', '.'));

/** Whether a bare number in the text is the rate of the two amounts, in either direction. */
const printsRate = ({ text, first, second }: { text: string; first: number; second: number }): boolean => {
  if (first <= 0 || second <= 0) return false;

  const ratios = [second / first, first / second];

  return (text.match(NUMBER) ?? []).some((token) => {
    const value = toNumber({ value: token });

    return value > 0 && ratios.some((ratio) => Math.abs(value - ratio) / ratio <= RATE_TOLERANCE);
  });
};

const paymentOf = ({
  kind,
  amount,
  currencyCode,
}: {
  kind: 'debit' | 'credit';
  amount: string;
  currencyCode: string;
}): ParsedPayment => ({
  kind,
  stage: 'payment',
  amount,
  currencyCode,
  originalAmount: null,
  originalCurrencyCode: null,
  merchant: null,
  payee: null,
  cardName: null,
  cardLastDigits: null,
  balanceAfter: null,
  occurredAt: null,
});

/**
 * Reads a notice that holds both sides of a currency exchange, by its structure and not by any bank's wording: exactly
 * two amounts in two different currencies, and evidence that they are one exchange, either a rate printed in the text
 * that matches the ratio of the amounts, or exchange wording. The first amount is the money that left and the second
 * the money that arrived, as the notice lists them. A notice that says money was received, or a refusal, a hold or
 * a cancellation, is left to the AI, as is anything with a third amount (a balance).
 *
 * The notice carries a date at most, so the payments have no time of their own; the request's received time stands.
 */
export const parseConversionNotice = ({ text }: { text: NotificationText }): ConversionNotice | null => {
  const lines = linesOf({ text });
  const whole = lines.join('\n');
  if (!lines.length || whole.length > MAX_TEXT_LENGTH || NOT_A_FINISHED_EXCHANGE.test(whole)) return null;

  const amounts = lines.flatMap((line) => findAmounts({ line, numberMayFollow: true }) ?? []);
  // A line that findAmounts doubts (spaced digits, a lone separator before three digits) leaves the notice to the AI.
  if (lines.some((line) => findAmounts({ line, numberMayFollow: true }) === null)) return null;
  if (amounts.length !== 2) return null;

  const [first, second] = amounts as [(typeof amounts)[number], (typeof amounts)[number]];
  if (!first.currencyCode || !second.currencyCode || first.currencyCode === second.currencyCode) return null;
  if (first.sign || second.sign) return null;

  const evidence =
    EXCHANGE_WORDS.test(whole) ||
    printsRate({
      text: whole.replace(/\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{2}-\d{2}/gu, ' '),
      first: toNumber({ value: first.amount }),
      second: toNumber({ value: second.amount }),
    });
  if (!evidence) return null;

  return {
    debit: paymentOf({ kind: 'debit', amount: first.amount, currencyCode: first.currencyCode }),
    credit: paymentOf({ kind: 'credit', amount: second.amount, currencyCode: second.currencyCode }),
  };
};
