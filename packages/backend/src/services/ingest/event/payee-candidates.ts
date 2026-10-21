import type { RecordId } from '@bt/shared/types';
import { connection } from '@models/connection';
import PayeeAliases from '@models/payee-aliases.model';
import Payees from '@models/payees.model';
import { isGenericMerchantWord } from '@services/transactions/planned-matching/generic-merchant-words';
import Fuse from 'fuse.js';
import { QueryTypes } from 'sequelize';

import { FUZZY_MIN_MATCH_CHAR_LENGTH, fuzzyFuseOptions } from '../../payees/fuzzy-matcher';
import { normalizePayeeName } from '../../payees/normalize-name';
import { loadUsualCategoryNames } from '../payee/usual-categories';

/** How many candidates the prompt may carry. */
export const PAYEE_CANDIDATES_LIMIT = 15;

const TOKEN_MATCH_QUOTA = 8;
const FUZZY_MATCH_QUOTA = 5;
const RECENT_PAYEES_QUOTA = 5;
const MAX_TOKENS = 8;
const RECENT_REQUESTS_SCANNED = 50;

/** A payee the model may pick, with a few of its known spellings. */
export interface PayeeCandidate {
  payeeId: RecordId;
  name: string;
  aliases: string[];
  /** The categories the owner usually gives the payee, the most frequent first; filled by `loadPayeeCandidates`. */
  usualCategories?: string[];
}

/**
 * Words that fill a bank notification and say nothing about the merchant, in the languages the
 * notifications come in. A payee called "Card Shop" must not become a candidate of every purchase
 * because the text says "card". Payment-processor prefixes and domain endings are here too. Place
 * names and kinds of business ("cafe") are in `generic-merchant-words`.
 */
const NOTIFICATION_FILLER_WORDS: ReadonlySet<string> = new Set([
  // English
  'purchase',
  'payment',
  'paid',
  'pay',
  'balance',
  'available',
  'card',
  'debit',
  'credit',
  'transfer',
  'transaction',
  'withdrawal',
  'deposit',
  'bank',
  'account',
  'amount',
  'approved',
  'declined',
  'successful',
  'visa',
  'mastercard',
  'ending',
  'with',
  'from',
  'your',
  'the',
  'for',
  'and',
  'you',
  'was',
  'has',
  'been',
  'pos',
  'atm',
  'www',
  'com',
  'http',
  'https',
  'paypal',
  'google',
  'apple',
  'total',
  'remaining',
  'limit',
  // Russian
  'покупка',
  'оплата',
  'платеж',
  'платёж',
  'баланс',
  'остаток',
  'доступно',
  'карта',
  'картой',
  'карты',
  'списание',
  'перевод',
  'поступление',
  'зачисление',
  'снятие',
  'сумма',
  'банк',
  'счет',
  'счёт',
  'одобрено',
  'отклонено',
  // Ukrainian
  'залишок',
  'картка',
  'карткою',
  'списання',
  'переказ',
  'поповнення',
  'зняття',
  'сума',
  'рахунок',
  // Georgian
  'შეძენა',
  'გადახდა',
  'ბარათი',
  'ბარათით',
  'ბალანსი',
  'ნაშთი',
  'ჩარიცხვა',
  'გადარიცხვა',
  'განაღდება',
  'თანხა',
  'ბანკი',
  'ანგარიში',
  'ხელმისაწვდომია',
]);

/** ISO 4217 codes in lower case: "GEL" in "43.60 GEL" is the currency, not a merchant. */
const CURRENCY_CODE_WORDS: ReadonlySet<string> = new Set(
  Intl.supportedValuesOf('currency').map((code) => code.toLowerCase()),
);

/**
 * The words of a notification that can name a merchant, in the order they appear: three letters or
 * more, not numbers, not a currency code, not filler and not a place or kind of business. `ignoredWords` takes the
 * words of the notification's own title and app name, which name the bank rather than the shop.
 */
export const extractMerchantTokens = ({
  text,
  ignoredWords = [],
}: {
  text: string;
  ignoredWords?: readonly string[];
}): string[] => {
  const ignored = new Set(ignoredWords.flatMap((word) => normalizePayeeName({ raw: word }).split(' ')));
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const token of normalizePayeeName({ raw: text }).split(' ')) {
    if (token.length < FUZZY_MIN_MATCH_CHAR_LENGTH || /^\p{N}+$/u.test(token)) continue;
    if (NOTIFICATION_FILLER_WORDS.has(token) || CURRENCY_CODE_WORDS.has(token)) continue;
    if (isGenericMerchantWord({ token }) || ignored.has(token)) continue;
    // A word mixing letters and digits is a code or a terminal id, not a name.
    if (/\p{N}/u.test(token)) continue;
    if (seen.has(token)) continue;

    seen.add(token);
    tokens.push(token);
    if (tokens.length === MAX_TOKENS) break;
  }

  return tokens;
};

interface PayeeEntry {
  id: RecordId;
  name: string;
  normalizedName: string;
  aliases: { rawName: string; normalizedName: string }[];
}

const toCandidate = ({ payee }: { payee: PayeeEntry }): PayeeCandidate => ({
  payeeId: payee.id,
  name: payee.name,
  aliases: payee.aliases.map((alias) => alias.rawName),
});

/**
 * Payees whose name or alias contains a token (the same test as `ILIKE '%token%'` over the
 * normalized names), the ones that match the most tokens first.
 */
export const findTokenMatches = ({
  payees,
  tokens,
}: {
  payees: readonly PayeeEntry[];
  tokens: readonly string[];
}): PayeeEntry[] => {
  if (!tokens.length) return [];

  return payees
    .map((payee) => {
      const names = [payee.normalizedName, ...payee.aliases.map((alias) => alias.normalizedName)];
      const matched = tokens.filter((token) => names.some((name) => name.includes(token))).length;

      return { payee, matched };
    })
    .filter(({ matched }) => matched > 0)
    .toSorted((a, b) => b.matched - a.matched || a.payee.name.localeCompare(b.payee.name))
    .map(({ payee }) => payee);
};

/** The payees whose names or aliases are closest to a token, best first, one entry per payee. */
export const findFuzzyMatches = ({
  payees,
  tokens,
}: {
  payees: readonly PayeeEntry[];
  tokens: readonly string[];
}): PayeeEntry[] => {
  if (!tokens.length || !payees.length) return [];

  const haystack = payees.flatMap((payee) => [
    { payeeId: payee.id, text: payee.name },
    ...payee.aliases.map((alias) => ({ payeeId: payee.id, text: alias.rawName })),
  ]);
  const fuse = new Fuse(haystack, fuzzyFuseOptions<(typeof haystack)[number]>());
  const bestScore = new Map<string, number>();

  for (const token of tokens) {
    for (const hit of fuse.search(token, { limit: FUZZY_MATCH_QUOTA })) {
      const score = hit.score ?? 1;
      const known = bestScore.get(hit.item.payeeId);

      if (known === undefined || score < known) bestScore.set(hit.item.payeeId, score);
    }
  }

  const byId = new Map<string, PayeeEntry>(payees.map((payee) => [payee.id, payee]));

  return [...bestScore.entries()].toSorted((a, b) => a[1] - b[1]).flatMap(([payeeId]) => byId.get(payeeId) ?? []);
};

/**
 * Up to `limit` candidates, deduplicated, in this order of trust: payees that contain a word of the
 * notification, the closest fuzzy matches, then the payees this source paid most recently. Each
 * group is cut to its quota first, so one group cannot crowd out the others.
 */
export const mergePayeeCandidates = ({
  tokenMatches,
  fuzzyMatches,
  recent,
  limit = PAYEE_CANDIDATES_LIMIT,
}: {
  tokenMatches: readonly PayeeEntry[];
  fuzzyMatches: readonly PayeeEntry[];
  recent: readonly PayeeEntry[];
  limit?: number;
}): PayeeCandidate[] => {
  const merged = new Map<RecordId, PayeeEntry>();
  const groups = [
    tokenMatches.slice(0, TOKEN_MATCH_QUOTA),
    fuzzyMatches.slice(0, FUZZY_MATCH_QUOTA),
    recent.slice(0, RECENT_PAYEES_QUOTA),
  ];

  for (const payee of groups.flat()) {
    if (!merged.has(payee.id)) merged.set(payee.id, payee);
  }

  return [...merged.values()].slice(0, limit).map((payee) => toCandidate({ payee }));
};

/** The payees of the transactions a source logged most recently, newest first, without repeats. */
const loadRecentPayeeIds = async ({
  userId,
  sourceId,
}: {
  userId: number;
  sourceId: RecordId;
}): Promise<RecordId[]> => {
  const rows = (await connection.sequelize.query(
    `SELECT t."payeeId"
       FROM "IngestRequests" r
       -- planned-ok: a payee an ingest chose stays the source's payee while its row is still a plan
       JOIN "Transactions" t ON t."id" = r."transactionId"
      WHERE r."userId" = :userId AND r."sourceId" = :sourceId
        AND t."payeeId" IS NOT NULL AND t."deletedAt" IS NULL
      ORDER BY r."createdAt" DESC
      LIMIT :limit`,
    { replacements: { userId, sourceId, limit: RECENT_REQUESTS_SCANNED }, type: QueryTypes.SELECT },
  )) as { payeeId: RecordId }[];

  return [...new Set(rows.map((row) => row.payeeId))];
};

/**
 * The payees the parser may pick from for one notification: the candidate list of the prompt, each
 * with the categories the owner usually gives it, so the model can tell similar names apart by the
 * kind of business.
 *
 * @public called by the processing job. It
 * reads the user's payees once and ranks them in memory, because the fuzzy match needs all of them
 * anyway.
 */
export const loadPayeeCandidates = async ({
  userId,
  text,
  sourceId,
  ignoredWords,
}: {
  userId: number;
  /** The notification's title, subtitle and body. */
  text: string;
  /** The source the notification came from; its recent payees join the list. */
  sourceId: RecordId | null;
  ignoredWords?: readonly string[];
}): Promise<PayeeCandidate[]> => {
  const rows = await Payees.findAll({
    where: { userId },
    attributes: ['id', 'name', 'normalizedName'],
    include: [{ model: PayeeAliases, as: 'aliases', attributes: ['rawName', 'normalizedName'] }],
  });
  const payees: PayeeEntry[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    normalizedName: row.normalizedName,
    aliases: (row.aliases ?? []).map((alias) => ({ rawName: alias.rawName, normalizedName: alias.normalizedName })),
  }));
  if (!payees.length) return [];

  const tokens = extractMerchantTokens({ text, ignoredWords });
  const byId = new Map<string, PayeeEntry>(payees.map((payee) => [payee.id, payee]));
  const recentIds = sourceId ? await loadRecentPayeeIds({ userId, sourceId }) : [];

  const candidates = mergePayeeCandidates({
    tokenMatches: findTokenMatches({ payees, tokens }),
    fuzzyMatches: findFuzzyMatches({ payees, tokens }),
    recent: recentIds.flatMap((id) => byId.get(id) ?? []),
  });
  const usualCategories = await loadUsualCategoryNames({
    ownerUserId: userId,
    payeeIds: candidates.map((candidate) => candidate.payeeId),
  });

  return candidates.map((candidate) => ({
    ...candidate,
    usualCategories: usualCategories.get(candidate.payeeId) ?? [],
  }));
};
