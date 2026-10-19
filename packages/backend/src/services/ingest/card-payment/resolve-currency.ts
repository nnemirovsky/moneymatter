import { CURRENCY_CODE_PATTERN, type CardPaymentRejectionReason } from '@bt/shared/types';

/**
 * Currency symbols a Wallet amount can carry, with the currencies each one can stand for. A symbol
 * with one candidate names that currency whoever the user is; a shared one (`$`, `¥`, `kr`) needs
 * the user's own currencies to pick. Keys are lower-case; the lookup is case-insensitive.
 */
const CURRENCY_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  '₾': ['GEL'],
  '€': ['EUR'],
  '£': ['GBP'],
  '₴': ['UAH'],
  '₽': ['RUB'],
  '₺': ['TRY'],
  '₹': ['INR'],
  '₸': ['KZT'],
  '₪': ['ILS'],
  '₩': ['KRW'],
  '₫': ['VND'],
  '₦': ['NGN'],
  '₱': ['PHP'],
  '₼': ['AZN'],
  '֏': ['AMD'],
  '฿': ['THB'],
  zł: ['PLN'],
  kč: ['CZK'],
  r$: ['BRL'],
  us$: ['USD'],
  ca$: ['CAD'],
  c$: ['CAD'],
  au$: ['AUD'],
  a$: ['AUD'],
  nz$: ['NZD'],
  hk$: ['HKD'],
  s$: ['SGD'],
  $: ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN', 'ARS', 'CLP', 'COP'],
  '¥': ['JPY', 'CNY'],
  kr: ['SEK', 'NOK', 'DKK', 'ISK'],
};

/** The currencies a symbol can stand for, or `undefined` for text that is not a known symbol. */
export const getSymbolCandidates = ({ symbol }: { symbol: string }): readonly string[] | undefined => {
  const key = symbol.toLowerCase();

  return Object.hasOwn(CURRENCY_SYMBOLS, key) ? CURRENCY_SYMBOLS[key] : undefined;
};

type CurrencySource = 'explicit' | 'text-code' | 'symbol' | 'account';

type ResolveCurrencyResult =
  | { ok: true; currencyCode: string; source: CurrencySource }
  | { ok: false; reason: Extract<CardPaymentRejectionReason, 'invalidCurrency' | 'currencyConflict'> };

/**
 * The currency of a card payment, in this order:
 *
 * 1. the request's explicit `currency`;
 * 2. a code in the amount text (`47.00 GEL`);
 * 3. the symbol in the amount text (`₾47`), when it names one currency: either it has a single
 *    candidate, or exactly one candidate is a currency the user holds (`$` with USD only);
 * 4. the mapped account's currency, which also settles a shared symbol the user's currencies do not
 *    narrow down (`$` with two dollar currencies).
 *
 * A code in the text that the symbol in the same text cannot stand for (`€47 USD`) is an error:
 * guessing either would file the payment in the wrong currency.
 *
 * The result is only checked for shape. Whether the code exists is up to the caller's lookup.
 */
export const resolveCurrency = ({
  explicitCurrency,
  textCode,
  textSymbol,
  userCurrencyCodes,
  accountCurrencyCode,
}: {
  explicitCurrency: string | null;
  textCode: string | null;
  textSymbol: string | null;
  userCurrencyCodes: readonly string[];
  accountCurrencyCode: string;
}): ResolveCurrencyResult => {
  const symbolCandidates = textSymbol === null ? null : (getSymbolCandidates({ symbol: textSymbol }) ?? null);

  if (explicitCurrency !== null) {
    const code = explicitCurrency.trim().toUpperCase();

    return CURRENCY_CODE_PATTERN.test(code)
      ? { ok: true, currencyCode: code, source: 'explicit' }
      : { ok: false, reason: 'invalidCurrency' };
  }

  if (textCode !== null) {
    const code = textCode.toUpperCase();

    if (symbolCandidates && !symbolCandidates.includes(code)) {
      return { ok: false, reason: 'currencyConflict' };
    }

    return { ok: true, currencyCode: code, source: 'text-code' };
  }

  if (symbolCandidates) {
    const held = symbolCandidates.filter((code) => userCurrencyCodes.includes(code));

    if (held.length === 1) return { ok: true, currencyCode: held[0]!, source: 'symbol' };
    if (symbolCandidates.length === 1) return { ok: true, currencyCode: symbolCandidates[0]!, source: 'symbol' };
  }

  return { ok: true, currencyCode: accountCurrencyCode, source: 'account' };
};
