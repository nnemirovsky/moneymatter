/**
 * The amount gate: the test that decides whether a notification shows a payment amount at all.
 *
 * It runs twice with the same patterns. The iOS 27 shortcut applies it on the device (Match Text,
 * then If) so a chat or an OTP never leaves the phone; the server applies it again before it stores
 * anything.
 *
 * The patterns use only syntax that both ICU (Shortcuts' Match Text) and JavaScript read the same
 * way: groups, classes, `\p{L}`/`\p{N}`, lookarounds of a single class, and `(?i:...)` for the
 * words that may be written in any case. Compile them with the `u` flag. Currency codes are
 * case-sensitive on purpose: `[A-Z]{3}` alone would take "PIN 1234" and "Use 123" for a payment.
 */

/** `strict`: an ISO code or a currency symbol next to the number. `standard` adds local currency words with a code, symbol or word up to 3 characters away. `loose` adds a two-decimal number with no currency. */
export const GATE_STRICTNESS_LEVELS = ['strict', 'standard', 'loose'] as const;

export type GateStrictness = (typeof GATE_STRICTNESS_LEVELS)[number];

export const DEFAULT_GATE_STRICTNESS: GateStrictness = 'standard';

/** Longest matched text kept for display (the inbox card). */
export const AMOUNT_GATE_MATCH_MAX_LENGTH = 32;

/** Flags to compile a gate pattern with in JavaScript. */
export const AMOUNT_GATE_REGEX_FLAGS = 'u';

// Active ISO 4217 codes, minus the ones that read as an ordinary uppercase word before a number
// (ALL, TOP, MOP, SOS, CUP).
const ISO_CURRENCY_CODES = [
  'AED AFN AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD',
  'CAD CDF CHF CLP CNY COP CRC CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD',
  'GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD',
  'KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK',
  'NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SRD',
  'SSP STN SYP SZL THB TJS TMT TND TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF',
  'XPF YER ZAR ZMW ZWL',
]
  .join(' ')
  .split(' ');

const NOT_PART_OF_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const NOT_PART_OF_WORD_AFTER = String.raw`(?![\p{L}\p{N}])`;
// A code may follow the number with no space (`43.60EUR`), so only a letter before it makes it part of a word.
const NOT_AFTER_LETTER = String.raw`(?<!\p{L})`;

const CODE = `${NOT_AFTER_LETTER}(?:${ISO_CURRENCY_CODES.join('|')})${NOT_PART_OF_WORD_AFTER}`;

// Symbols that are not letters stand alone; the letter symbols need word boundaries.
const SYMBOL = String.raw`[₾€£₴₽₺₹₸₪₩₫₦₱₼֏฿$¥]|${NOT_PART_OF_WORD_BEFORE}(?i:zł|kč|kr)${NOT_PART_OF_WORD_AFTER}`;

// Currency names in Latin, Cyrillic and Georgian script. The endings of the Cyrillic and Georgian
// stems are open (`\p{L}*`) because the words inflect.
const WORD = [
  `${NOT_PART_OF_WORD_BEFORE}(?i:`,
  [
    'lari',
    'ლარ\\p{L}*',
    'ლ',
    'лари',
    'лар',
    'руб\\p{L}*',
    'грн',
    'гривн\\p{L}*',
    'гривен\\p{L}*',
    'dollars?',
    'доллар\\p{L}*',
    'долар\\p{L}*',
    'долл',
    'euros?',
    'евро',
    'євро',
    'pounds?',
    'lira',
    'лир\\p{L}*',
    'лір\\p{L}*',
    'manat',
    'манат\\p{L}*',
    'tenge',
    'тенге',
    'zloty',
    'злот\\p{L}*',
    'dram',
    'драм\\p{L}*',
    'rubles?',
    'roubles?',
    'hryvnias?',
  ].join('|'),
  `)${NOT_PART_OF_WORD_AFTER}`,
].join('');

// A number as written in the common locales: `43.60`, `43,60`, `1 234,56`, `1,234.56`, `1'234.56`.
const NUMBER = String.raw`(?<!\d)\d+(?:[,.'’   ]\d{3})*(?:[.,]\d{1,8})?(?!\d)`;

const STRICT_MARK = `(?:${CODE}|${SYMBOL})`;
const STANDARD_MARK = `(?:${CODE}|${SYMBOL}|${WORD})`;

const STRICT = `${STRICT_MARK}\\s?${NUMBER}|${NUMBER}\\s?${STRICT_MARK}`;
const STANDARD = `${STRICT}|${STANDARD_MARK}\\D{0,3}${NUMBER}|${NUMBER}\\D{0,3}${STANDARD_MARK}`;

// A number with exactly two decimals and nothing around it that makes it a date, a version or part
// of a longer number (`20.10.2026` and `1.2.3` do not qualify).
const BARE_AMOUNT = String.raw`(?<![\d.,])\d+(?:[,.'’   ]\d{3})*[.,]\d{2}(?![\d]|[.,]\d)`;
const LOOSE = `${STANDARD}|${BARE_AMOUNT}`;

/** The pattern (ICU and JavaScript syntax) for each level. */
export const AMOUNT_GATE_PATTERNS: Readonly<Record<GateStrictness, string>> = {
  strict: STRICT,
  standard: STANDARD,
  loose: LOOSE,
};

/** The pattern of a level as a JavaScript `RegExp`. */
export const buildAmountGateRegex = ({ strictness }: { strictness: GateStrictness }): RegExp =>
  new RegExp(AMOUNT_GATE_PATTERNS[strictness], AMOUNT_GATE_REGEX_FLAGS);

/**
 * The part of `text` that shows an amount at this level, cut to `AMOUNT_GATE_MATCH_MAX_LENGTH`
 * characters, or `null` when nothing does. `text` is the title, subtitle and body joined.
 */
export const matchAmountGate = ({ text, strictness }: { text: string; strictness: GateStrictness }): string | null => {
  const match = buildAmountGateRegex({ strictness }).exec(text);

  return match ? match[0].trim().slice(0, AMOUNT_GATE_MATCH_MAX_LENGTH) : null;
};

/**
 * One sample for the gate's tests, shared by the server's unit test and the shortcut's spec.
 * `minLevel` is the loosest-needed level: the sample matches at that level and every looser one, and
 * `null` means it never matches.
 */
export interface AmountGateSample {
  text: string;
  minLevel: GateStrictness | null;
}

export const AMOUNT_GATE_SAMPLES: readonly AmountGateSample[] = [
  // Matches at every level.
  { text: 'Example Bank\nWolt\nGEL 43.60', minLevel: 'strict' },
  { text: 'Purchase 43.60 GEL at Wolt', minLevel: 'strict' },
  { text: 'Card *1234: 1 234,56 EUR', minLevel: 'strict' },
  { text: 'You paid ₾43.60', minLevel: 'strict' },
  { text: 'Списание $ 1,234.50 Amazon', minLevel: 'strict' },
  { text: 'Оплата 250 zł Żabka', minLevel: 'strict' },
  { text: 'Received USD 1000 from John', minLevel: 'strict' },
  { text: 'Payment\n43.60EUR\nExample Store', minLevel: 'strict' },
  // Local currency words and a little punctuation between the number and the mark.
  { text: 'გადახდა: 43.60 ლარი', minLevel: 'standard' },
  { text: 'Оплата 120 рублей в магазине', minLevel: 'standard' },
  { text: 'Списання 250 грн, Сільпо', minLevel: 'standard' },
  { text: 'Paid 12.50 dollars', minLevel: 'standard' },
  { text: 'Total: (GEL) 43.60', minLevel: 'standard' },
  // A two-decimal number with no currency.
  { text: 'Purchase at Wolt 43.60', minLevel: 'loose' },
  { text: 'Balance: 1 234,56', minLevel: 'loose' },
  // Never.
  { text: 'Your verification code is 123456', minLevel: null },
  { text: 'PIN 1234 for your card', minLevel: null },
  { text: 'OTP 654321 expires in 5 minutes', minLevel: null },
  { text: 'Call me back on +995 555 12 34 56', minLevel: null },
  { text: 'See you on 20.10.2026 at 14:30', minLevel: null },
  { text: 'Version 1.2.3 is out', minLevel: null },
  { text: 'Order #4521 has shipped', minLevel: null },
  { text: 'Hey, are we still on for dinner tonight?', minLevel: null },
  { text: 'Привіт! Як справи?', minLevel: null },
];
