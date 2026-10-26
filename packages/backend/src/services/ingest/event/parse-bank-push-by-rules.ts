import { parseAmount } from '../card-payment/parse-amount';
import type { ParsedPayment } from './classify-notification';
import type { ClassifiedNotification } from './classify-notification';
import type { NotificationText } from './notification-text';

/** A plain card payment read by its layout; the same shape the Wallet reader returns. */
export interface RulesPayment {
  classified: Extract<ClassifiedNotification, { verdict: 'payment' }>;
  /** A currency symbol written next to the amount, as written; only the user's own currencies can settle a shared one. */
  symbol: string | null;
}

const escapeRegExp = ({ value }: { value: string }) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const KNOWN_CURRENCY_CODES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

const MAX_MERCHANT_WORDS = 6;
/** Function words in any case: a name that holds one is part of a sentence, so it goes to the AI. */
const PREPOSITION =
  /(?<![\p{L}\p{N}])(?:for|at|in|on|to|from|with|by|of|за|для|в|у|на|от|до|з|із|від)(?![\p{L}\p{N}])/iu;

const MAX_TEXT_LENGTH = 400;
const MAX_LINES = 8;
const RULES_CONFIDENCE = 0.9;

/** A list of words as one pattern; the boundaries are letters and digits of any script, which `\b` does not see. */
const wordsPattern = ({ words }: { words: string }): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})(?![\\p{L}\\p{N}])`, 'iu');

/** Words (several languages) of a message that is not a plain card payment: a refusal, a hold, a transfer, a fee. */
const NOT_PLAIN_PAYMENT = wordsPattern({
  words:
    'declin\\p{L}*|refus\\p{L}*|reject\\p{L}*|fail\\p{L}*|insufficient|limit|code|otp|hold|pending|authori[sz]\\p{L}*|reserv\\p{L}*|transfer\\p{L}*|exchange\\p{L}*|conver\\p{L}*|cashback|bonus|fee|commission|installment|loan|overdraft|reversal|cancel\\p{L}*|unsuccess\\p{L}*|revers\\p{L}*|return\\p{L}*|error|not completed|deni\\p{L}*|скасов\\p{L}*|отмен\\p{L}*|заблок\\p{L}*|холд|резерв\\p{L}*|зарезерв\\p{L}*|неусп\\p{L}*|held|pre-?auth\\p{L}*|revert\\p{L}*|chargeback|account|a/c|рахунок|рахунк\\p{L}*|счет|счёт|block\\p{L}*|void\\p{L}*|suspend\\p{L}*|unauthori[sz]\\p{L}*|attempt\\p{L}*|due|request\\p{L}*|upcoming|scheduled|expected|will|tomorrow|invoice|bill|statement|not|no|не|ні|нет|remind\\p{L}*|from|to|ошибк\\p{L}*|не прошл\\p{L}*|не прош\\p{L}*|не вдал\\p{L}*|помилк\\p{L}*|від|от|до|отказ\\p{L}*|отклон\\p{L}*|недостаточно|лимит|код|блокир\\p{L}*|перевод\\p{L}*|обмен\\p{L}*|конверт\\p{L}*|комисс\\p{L}*|кэшбэк|бонус|кредит\\p{L}*|відмов\\p{L}*|відхил\\p{L}*|недостатньо|ліміт|переказ\\p{L}*|обмін\\p{L}*|комісі\\p{L}*|кешбек',
});

const DEBIT_WORDS = wordsPattern({
  words: 'purchase\\p{L}*|spent|debit\\p{L}*|charged?|withdraw\\p{L}*|покупк\\p{L}*|списани\\p{L}*|списано|списання',
});
const CREDIT_WORDS = wordsPattern({
  words:
    'received|credit\\p{L}*|deposit\\p{L}*|refund\\p{L}*|income|salary|пополнени\\p{L}*|зачислени\\p{L}*|поступлени\\p{L}*|возврат|поповнення|зарахуванн\\p{L}*|повернення',
});

const globally = ({ pattern }: { pattern: RegExp }): RegExp => new RegExp(pattern.source, 'giu');

const BALANCE_WORDS = wordsPattern({ words: 'balance|bal|avail\\p{L}*|остаток|баланс|залишок|доступно' });

/** A masked card number or "ending 1234": the digits are the card's, not an amount. */
const CARD_MASK =
  /(?:(?<![\p{L}\p{N}])[*•·x×]+[ \u00a0]?|(?:ending|ends|card|карт\p{L}*)[ \u00a0]*(?:in|on|на)?[ \u00a0]*[*•·x×#№]*[ \u00a0]?)(\d{4,8})\b/iu;

/** The word "card" alone on a line of words ("Card payment") names no merchant. */
const CARD_WORD = wordsPattern({ words: 'card|карта|карт\\p{L}*' });

const CARD_KIND = wordsPattern({
  words: '(?:credit|debit|кредитн\\p{L}*|дебетов\\p{L}*)[ \\u00a0]+(?:card|карта|картка|карт\\p{L}*)',
});
const CARD_LABEL = /(?<![\p{L}\p{N}])[\p{L}\p{N}]+[ \u00a0]+(?:card|карта|картка)(?![\p{L}\p{N}])/iu;

const DATE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./](?:\d{4}|\d{2}))\b/gu;
const TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\b/gu;

/** A signed amount with a currency code or symbol on either side. */
const MONEY =
  /(?:(?<![^\s])([-+−–])(?=[A-Z$€£¥₴₽₾₺₹\d]))?[ \u00a0]*(?:(?<![A-Za-z])([A-Z]{3})(?![A-Za-z])[ \u00a0]*)?([$€£¥₴₽₾₺₹])?[ \u00a0]*(\d[\d .,'\u00a0\u202f]*\d|\d)(?:[ \u00a0]*(?<![A-Za-z])([A-Z]{3})(?![A-Za-z]))?/gu;

interface Found {
  amount: string;
  currencyCode: string | null;
  symbol: string | null;
  sign: '-' | '+' | null;
  /** The text of the line without the amount. */
  rest: string;
}

/**
 * The text as lines. The stored fields have their line breaks collapsed, so the device's own rendering (`raw`) is used
 * for the line structure when it has one; otherwise each field is a line, the title (usually the bank) first.
 */
const linesOf = ({ text }: { text: NotificationText }): string[] => {
  const source = text.raw?.includes('\n') ? [text.raw] : [text.title, text.subtitle, text.body];

  return source
    .flatMap((field) => field.split(/\r?\n/u))
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
};

/**
 * The amounts a line carries (with a currency), and the line without them (an amount leaves a `|` between the words
 * around it). `null` when a number is in doubt: a space inside the digits may join a store number and the amount.
 */
const findAmounts = ({ line: original }: { line: string }): Found[] | null => {
  const found: Found[] = [];
  let doubtful = false;
  // A date or a time sits next to an amount in some layouts; its digits are never part of the number.
  const line = original.replace(DATE, ' | ').replace(TIME, ' | ');
  const rest = line.replace(
    MONEY,
    (
      token,
      sign: string | undefined,
      before: string | undefined,
      symbol: string | undefined,
      digits: string,
      after: string | undefined,
      offset: number,
    ) => {
      // A code is a known ISO code written in capitals; a symbol in front of the number settles the currency by itself.
      const written = after ?? (symbol ? undefined : before);
      const code = written && KNOWN_CURRENCY_CODES.has(written) ? written : null;
      const parsed = parseAmount({ input: `${code ?? ''} ${symbol ?? ''}${digits}`.trim() });
      if (!parsed.ok || (!parsed.currencyCode && !parsed.symbol && !code && !symbol)) return token;
      // Doubt, left to the AI: a space inside the digits (a store number may be joined to the amount), a lone separator
      // before exactly three digits ("1.250" is one and a quarter or twelve hundred and fifty), a code on each side.
      const followedByNumber = after !== undefined && /^[ \u00a0]*\d/u.test(line.slice(offset + token.length));
      // A symbol on each side, a symbol after the number, a symbol with a code beside it, or a number in front of a symbol
      // amount all leave the currency or the amount in doubt.
      const symbolTrouble =
        /^[ \u00a0]*[$€£¥₴₽₾₺₹]/u.test(line.slice(offset + token.length)) ||
        (symbol !== undefined && (before !== undefined || after !== undefined)) ||
        (symbol !== undefined && /\d[ \u00a0]*$/u.test(line.slice(0, offset)));
      const bothCodes = before && after && KNOWN_CURRENCY_CODES.has(before) && KNOWN_CURRENCY_CODES.has(after);
      if (
        followedByNumber ||
        symbolTrouble ||
        /[ \u00a0\u202f]/u.test(digits) ||
        /^\d+[.,]\d{3}$/u.test(digits) ||
        (bothCodes && before !== after)
      ) {
        doubtful = true;

        return token;
      }

      found.push({
        amount: parsed.amount,
        currencyCode: parsed.currencyCode ?? code,
        symbol: parsed.symbol ?? symbol ?? null,
        sign: sign ? (/[-−–]/u.test(sign) ? '-' : '+') : null,
        rest: '',
      });

      return ' | ';
    },
  );
  if (doubtful) return null;

  return found.map((item) => ({ ...item, rest: rest.replace(/\s+/gu, ' ').trim() }));
};

const readOccurredAt = ({ text }: { text: string }): Date | null => {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})\b/u.exec(text);
  const dotted = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})[ ,]+(\d{1,2}):(\d{2})\b/u.exec(text);
  const parts = iso
    ? { y: iso[1]!, m: iso[2]!, d: iso[3]!, h: iso[4]!, min: iso[5]! }
    : dotted
      ? { y: dotted[3]!, m: dotted[2]!, d: dotted[1]!, h: dotted[4]!, min: dotted[5]! }
      : null;
  if (!parts) return null;

  const date = new Date(
    `${parts.y}-${parts.m.padStart(2, '0')}-${parts.d.padStart(2, '0')}T${parts.h.padStart(2, '0')}:${parts.min}:00`,
  );

  return Number.isNaN(date.getTime()) ? null : date;
};

/** Network and generic words that name a card in front of its masked digits ("Visa *1234"). */
const CARD_NETWORK =
  /(?<![\p{L}\p{N}])(?:visa|mastercard|master card|maestro|amex|american express|mir|unionpay|card|debit card|credit card|карта|картка)[ \u00a0]*$/iu;

interface LineReading {
  amounts: Found[];
  balance: Found | null;
  card: { digits: string; name: string | null } | null;
  direction: 'debit' | 'credit' | null;
  pieces: string[];
}

/** Takes a line apart: its amounts, balance, card, direction words, and what is left as pieces for a merchant. */
const readLine = ({ line }: { line: string }): LineReading | null => {
  let rest = line;
  let balance: Found | null = null;

  const balanceAt = rest.search(BALANCE_WORDS);
  if (balanceAt >= 0) {
    const clause = rest.slice(balanceAt);
    const found = findAmounts({ line: clause });
    if (found?.length !== 1) return null;

    balance = found[0]!;
    rest = rest.slice(0, balanceAt);
  }

  const amounts = findAmounts({ line: rest });
  if (!amounts) return null;
  rest = amounts[0]?.rest ?? rest;

  // "Credit card" and "debit card" name a card, not a direction.
  rest = rest.replace(CARD_KIND, ' | ');

  let card: LineReading['card'] = null;
  const mask = CARD_MASK.exec(rest);
  if (mask) {
    const before = rest.slice(0, mask.index);
    const network = CARD_NETWORK.exec(before);
    // A word in front of the digits that is no card network ("Gold Card *1234") is a card label, which the AI reads.
    const lead = before
      .replace(globally({ pattern: DEBIT_WORDS }), ' ')
      .replace(globally({ pattern: CREDIT_WORDS }), ' ');
    if (!network && /[\p{L}\p{N}][ \u00a0]*$/u.test(lead)) return null;
    card = { digits: mask[1]!, name: network ? network[0].trim() : null };
    rest = `${network ? before.slice(0, network.index) : before} | ${rest.slice(mask.index + mask[0].length)}`;
  }

  // A card's own label ("Gold Card") is the AI's to read, with the card of the account it belongs to.
  if (CARD_LABEL.test(rest)) return null;

  const debitWord = DEBIT_WORDS.test(rest);
  const creditWord = CREDIT_WORDS.test(rest);
  if (debitWord && creditWord) return null;

  const pieces = rest
    .replace(DATE, ' | ')
    .replace(TIME, ' | ')
    .replace(globally({ pattern: DEBIT_WORDS }), ' | ')
    .replace(globally({ pattern: CREDIT_WORDS }), ' | ')
    .replace(globally({ pattern: CARD_WORD }), ' | ')
    .split(/\s*[|;,]\s*|\s+-\s+/u)
    .map((piece) =>
      piece
        .replace(/^(?:at|in|в|у|на)\s+/iu, '')
        .replace(/^[\s:·•\-–—]+|[\s·•\-–—]+$/gu, '')
        .trim(),
    )
    .filter((piece) => piece && /\p{L}/u.test(piece));

  return { amounts, balance, card, direction: debitWord ? 'debit' : creditWord ? 'credit' : null, pieces };
};

/**
 * Reads a plain bank card-payment push by its layout, with no AI: an amount with its currency, a word or sign that says
 * whether money left or arrived, a merchant, and optionally a masked card, a date and time and a balance, one per line
 * or run together. It answers only when nothing is in doubt: one payment amount, a direction the text states, at most
 * one piece of text left over for the merchant, and none of the words of a refusal, a hold, a transfer, an exchange or
 * a fee. Anything else is `null` and goes to the AI. The amount is printed in the text by construction, and the payee
 * is resolved from the merchant by the caller, as for a Wallet payment.
 */
export const parseBankPushByRules = ({
  text,
  appName,
  sender = null,
}: {
  text: NotificationText;
  appName: string | null;
  /** The sender of a messaging or mail notification: a name, like the app's, that is not the merchant. */
  sender?: string | null;
}): RulesPayment | null => {
  const lines = linesOf({ text });
  const whole = lines.join('\n');
  if (!lines.length || lines.length > MAX_LINES || whole.length > MAX_TEXT_LENGTH) return null;
  if (NOT_PLAIN_PAYMENT.test(whole)) return null;

  let payment: Found | null = null;
  let balance: Found | null = null;
  let card: LineReading['card'] = null;
  let direction: 'debit' | 'credit' | null = null;
  const pieces: string[] = [];

  for (const line of lines) {
    const read = readLine({ line });
    if (!read) return null;

    if (read.amounts.length > 1) return null;
    if (read.amounts.length === 1) {
      if (payment) return null;
      payment = read.amounts[0]!;
    }
    if (read.balance) {
      if (balance) return null;
      balance = read.balance;
    }
    if (read.card) {
      if (card) return null;
      card = read.card;
    }
    if (read.direction) {
      if (direction && direction !== read.direction) return null;
      direction = read.direction;
    }
    pieces.push(...read.pieces);
  }

  if (!payment) return null;
  const signed = payment.sign ? (payment.sign === '-' ? 'debit' : 'credit') : null;
  // A sign and a word that disagree ("+25.00 EUR purchase") are in doubt.
  if (signed && direction && signed !== direction) return null;
  direction ??= signed;
  if (!direction) return null;

  // A piece that ends in a colon is a bank's own label ("Deposit Money:"), which the AI reads.
  // The bank's own name (the app's name, or its first word) is not the merchant, wherever it stands in the text.
  const bankNames = [
    (appName ?? '').trim(),
    (appName ?? '').trim().split(/\s+/u)[0] ?? '',
    (sender ?? '').trim(),
  ].filter(Boolean);
  const withoutBrand = pieces.map((piece) =>
    bankNames
      .reduce(
        (acc, name) =>
          acc.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp({ value: name })}(?![\\p{L}\\p{N}])`, 'giu'), ' '),
        piece,
      )
      .replace(/\s+/gu, ' ')
      .trim(),
  );
  const named = [...new Set(withoutBrand.filter((piece) => /\p{L}/u.test(piece)))];
  if (named.some((piece) => /:\s*$/u.test(piece))) return null;
  if (named.length > 1) return null;
  // A short name, not a sentence: banks print a merchant in capitals or title case, so a word that starts in lower case,
  // a preposition, closing punctuation or many words mean the text says more than a merchant.
  if (
    named.some(
      (piece) =>
        piece.split(/\s+/u).length > MAX_MERCHANT_WORDS ||
        PREPOSITION.test(piece) ||
        /[.!?]\s|[.!?]$/u.test(piece) ||
        /\d[.,]\d/u.test(piece) ||
        piece.split(/\s+/u).some((word) => !/^[\p{Lu}\p{N}]/u.test(word)),
    )
  ) {
    return null;
  }

  const parsed: ParsedPayment = {
    kind: direction,
    stage: 'payment',
    amount: payment.amount,
    currencyCode: payment.currencyCode,
    originalAmount: null,
    originalCurrencyCode: null,
    merchant: named[0] ?? null,
    payee: null,
    cardName: card?.name ?? null,
    cardLastDigits: card?.digits ?? null,
    balanceAfter:
      balance && balance.currencyCode
        ? {
            amount: balance.sign === '-' ? `-${balance.amount}` : balance.amount,
            currencyCode: balance.currencyCode,
            scopeHint: 'unknown',
          }
        : null,
    occurredAt: readOccurredAt({ text: whole }),
  };

  return {
    symbol: payment.currencyCode ? null : payment.symbol,
    classified: {
      parser: 'rules',
      kind: direction,
      confidence: RULES_CONFIDENCE,
      verdict: 'payment',
      payment: parsed,
    },
  };
};
