import { getSymbolCandidates } from './resolve-currency';

/** What a Wallet amount text could be read as. */
type ParseAmountResult =
  | {
      ok: true;
      /** A positive decimal string with a `.` separator, safe for `Money.fromDecimal`. */
      amount: string;
      /** An upper-cased 3-letter code written next to the number (`GEL 47`), or `null`. */
      currencyCode: string | null;
      /** A known currency symbol written next to the number (`₾47`), as written, or `null`. */
      symbol: string | null;
    }
  | { ok: false; reason: 'negative' | 'zero' | 'invalid' };

const MAX_INPUT_LENGTH = 64;
const MAX_INTEGER_DIGITS = 15;
const MAX_FRACTION_DIGITS = 8;

const INVISIBLE_MARKS = /[​-‏‪-‮⁠-⁩﻿]/gu;
const MINUS_SIGNS = /[-−–‐‑]/gu;
const GROUP_MARKS = /[ ']/;
const NUMERIC_RUN = /[0-9][0-9.,' ]*[0-9]|[0-9]|[.,][0-9]+/gu;
// Groups of three (`1,234,567`) or the Indian grouping (`12,34,567`).
const groupedIntegerPattern = ({ separator }: { separator: string }): RegExp => {
  const escaped = separator.replace(/[.]/g, '\\.');

  return new RegExp(`^(?:\\d{1,3}(?:${escaped}\\d{3})+|\\d{1,2}(?:${escaped}\\d{2})*${escaped}\\d{3})$`);
};

// Arabic-Indic and Persian digits, and the Arabic decimal and thousands separators.
const normalizeScript = ({ text }: { text: string }): string =>
  text
    .normalize('NFKC')
    .replace(INVISIBLE_MARKS, '')
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/٫/gu, '.')
    .replace(/٬/gu, ',')
    .replace(/[’ʼ]/gu, "'")
    .replace(/\s+/gu, ' ');

const count = ({ text, char }: { text: string; char: string }): number => text.split(char).length - 1;

/**
 * Reads the digits of a number written with any of the separators Wallet and the locales use.
 * Returns the integer and fraction digits, or `null` for a malformed number.
 *
 * Separator rules:
 * - a space or an apostrophe is always a group separator (`1 234,56`, `1'234.56`);
 * - with both `.` and `,` present, the last one is the decimal separator and the other groups
 *   thousands (`1.234,56`, `1,234.56`);
 * - one kind of separator repeated (`1,234,567`) groups thousands;
 * - one separator, once, is a thousands separator only when exactly 3 digits follow it, the part
 *   before it is 1-3 digits without a leading zero and no space or apostrophe appears (`1,234`
 *   is 1234, `1,23` is 1.23, `0,500` is 0.5, `1234,567` is 1234.567, `1 234,567` is 1234.567).
 *   Every other single separator is decimal.
 */
const readDigits = ({ text }: { text: string }): { integer: string; fraction: string } | null => {
  const leadingSeparator = /^[.,](\d+)$/.exec(text);
  if (leadingSeparator) return { integer: '0', fraction: leadingSeparator[1]! };

  const dots = count({ text, char: '.' });
  const commas = count({ text, char: ',' });
  let decimalSeparator: '.' | ',' | null = null;

  if (dots > 0 && commas > 0) {
    decimalSeparator = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ',';
    if (count({ text, char: decimalSeparator }) !== 1) return null;
  } else if (dots + commas === 1) {
    const separator = dots === 1 ? '.' : ',';
    const index = text.indexOf(separator);
    const before = text.slice(0, index);
    const after = text.slice(index + 1);
    const isThousands = after.length === 3 && !GROUP_MARKS.test(before) && /^[1-9]\d{0,2}$/.test(before);

    decimalSeparator = isThousands ? null : separator;
  }

  const decimalIndex = decimalSeparator === null ? -1 : text.indexOf(decimalSeparator);
  const integerText = decimalIndex === -1 ? text : text.slice(0, decimalIndex);
  const fraction = decimalIndex === -1 ? '' : text.slice(decimalIndex + 1);

  if (decimalIndex !== -1 && !/^\d+$/.test(fraction)) return null;

  const separators = new Set(integerText.replace(/\d/g, '').split('').filter(Boolean));
  let integer = integerText;

  if (separators.size > 1) return null;
  if (separators.size === 1) {
    const [separator] = [...separators] as [string];

    if (!groupedIntegerPattern({ separator }).test(integerText)) return null;
    integer = integerText.split(separator).join('');
  }

  return { integer, fraction };
};

/**
 * Splits what is left of the text once the number is cut out into the sign, an optional currency
 * symbol and an optional 3-letter code. Anything else makes the text unreadable.
 */
const readAffixes = ({
  text,
}: {
  text: string;
}): { negative: boolean; symbol: string | null; currencyCode: string | null } | null => {
  let rest = text;
  let negative = false;

  const hasOpen = rest.includes('(');
  const hasClose = rest.includes(')');
  if (hasOpen !== hasClose || count({ text: rest, char: '(' }) > 1 || count({ text: rest, char: ')' }) > 1) return null;
  if (hasOpen) {
    negative = true;
    rest = rest.replace(/[()]/g, ' ');
  }

  const minuses = rest.match(MINUS_SIGNS)?.length ?? 0;
  if (minuses > 1) return null;
  if (minuses === 1) {
    negative = true;
    rest = rest.replace(MINUS_SIGNS, ' ');
  }

  if (count({ text: rest, char: '+' }) > 1) return null;
  rest = rest.replace(/\+/g, ' ');

  let symbol: string | null = null;
  let currencyCode: string | null = null;

  for (const token of rest.split(' ').filter(Boolean)) {
    if (getSymbolCandidates({ symbol: token })) {
      if (symbol !== null) return null;
      symbol = token;
    } else if (/^[A-Za-z]{3}$/.test(token)) {
      if (currencyCode !== null) return null;
      currencyCode = token.toUpperCase();
    } else {
      return null;
    }
  }

  return { negative, symbol, currencyCode };
};

// A JSON number is written with a `.` and no grouping, so it needs no separator inference.
const readPlainDecimal = ({ text }: { text: string }): { integer: string; fraction: string } | null => {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);

  return match ? { integer: match[1]!, fraction: match[2] ?? '' } : null;
};

/**
 * The text of an amount field as sent: a string stays as it is, a JSON number is written without
 * an exponent, anything else has no text.
 */
export const amountInputToText = ({ input }: { input: unknown }): string | null => {
  if (typeof input === 'string') return input;
  if (typeof input !== 'number' || !Number.isFinite(input)) return null;

  return new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 20 }).format(input);
};

/**
 * Reads the amount a Wallet transaction hands to the shortcut. The text form is undocumented, so
 * the reader is defensive: a JSON number, or text with a currency symbol or ISO code on either
 * side, any of the usual thousands and decimal separators (including non-breaking and narrow
 * spaces and Arabic-Indic digits), a minus sign or accounting parentheses.
 *
 * A JSON number is a plain decimal (`1.234` is one and 234 thousandths); in a string a lone `.` or
 * `,` followed by three digits is a thousands separator.
 *
 * `negative`, `zero` and `invalid` come back as failures, never as a throw: the iOS glitch that
 * sends `0` or an empty amount is a rejected payment, not a crash. See `readDigits` for how a lone
 * `,` or `.` is read.
 */
export const parseAmount = ({ input }: { input: unknown }): ParseAmountResult => {
  const raw = amountInputToText({ input });
  if (raw === null || raw.length > MAX_INPUT_LENGTH) return { ok: false, reason: 'invalid' };

  const text = normalizeScript({ text: raw }).trim();
  const runs = [...text.matchAll(NUMERIC_RUN)];
  if (runs.length !== 1) return { ok: false, reason: 'invalid' };

  const run = runs[0]!;
  const affixes = readAffixes({ text: `${text.slice(0, run.index)} ${text.slice(run.index + run[0].length)}` });
  // `1.234` as a JSON number is 1.234 (KWD has three decimals); only a string needs the heuristic.
  const digits = typeof input === 'number' ? readPlainDecimal({ text: run[0] }) : readDigits({ text: run[0] });
  if (!affixes || !digits) return { ok: false, reason: 'invalid' };

  const integer = digits.integer.replace(/^0+(?=\d)/, '');
  const fraction = digits.fraction.replace(/0+$/, '');
  if (integer.length > MAX_INTEGER_DIGITS || fraction.length > MAX_FRACTION_DIGITS) {
    return { ok: false, reason: 'invalid' };
  }

  if (/^0*$/.test(integer + fraction)) return { ok: false, reason: 'zero' };
  if (affixes.negative) return { ok: false, reason: 'negative' };

  return {
    ok: true,
    amount: fraction ? `${integer}.${fraction}` : integer,
    currencyCode: affixes.currencyCode,
    symbol: affixes.symbol,
  };
};
