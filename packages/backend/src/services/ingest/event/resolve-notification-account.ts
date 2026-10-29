import { ACCOUNT_STATUSES, isDedicatedFlowAccountCategory, type RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import Accounts from '@models/accounts.model';
import type NotificationSources from '@models/notification-sources.model';
import { Op } from 'sequelize';

import { resolveCardAccount } from '../resolve-card-account';
import { loadHistoryUses, pickHistoryAccount, type HistoryConfidence } from './history-account';

/** The account when it takes a manual payment (not archived, not a loan or a vehicle), else `null`. */
const usableOrNull = ({ account }: { account: Accounts | null }): Accounts | null =>
  account && account.status !== ACCOUNT_STATUSES.archived && !isDedicatedFlowAccountCategory(account.accountCategory)
    ? account
    : null;

/** How the account was found, in the order the lookup tries them; `owner` is the account chosen on an inbox card. */
type AccountMatch = 'card' | 'sourceDefault' | 'history' | 'owner';

/** What a notification states of its payment, for finding the account among the ones the source used before. */
export interface HistoryClue {
  amount: string;
  kind: 'debit' | 'credit';
  balanceAfter: { amount: string; currencyCode: string } | null;
}

/** An account the owner picked by id, when it still takes a manual payment. */
export const findUsableAccount = async ({
  userId,
  accountId,
}: {
  userId: number;
  accountId: RecordId;
}): Promise<{ account: Accounts; matchedBy: AccountMatch } | null> => {
  const account = usableOrNull({ account: await Accounts.findOne({ where: { id: accountId, userId } }) });

  return account ? { account, matchedBy: 'owner' } : null;
};

/**
 * The account a notification's payment is logged on, in this order:
 *
 * 1. the card the notification names (its Wallet card name, else its last digits): the payment
 *    currency's row, else the card's default row;
 * 2. the source's default account;
 * 3. the one account this source's logged payments with the same last digits and currency landed on, or the one whose
 *    balance fits the balance the notice states (see `pickHistoryAccount`).
 *
 * `null` means the account is unknown: the payment waits for the user and the server never guesses.
 * A card or default whose account is archived or gone counts as not found.
 */
export const resolveNotificationAccount = async ({
  userId,
  cardName,
  cardLastDigits,
  currencyCode,
  source,
  clue,
}: {
  userId: number;
  cardName: string | null;
  cardLastDigits: string | null;
  /** The currency the payment states, or `null` when the text states none. */
  currencyCode: string | null;
  source: Pick<NotificationSources, 'id' | 'defaultAccountId'> | null;
  clue?: HistoryClue;
}): Promise<{ account: Accounts; matchedBy: AccountMatch } | null> => {
  const card = await resolveCardAccount({ userId, cardLabel: cardName, lastDigits: cardLastDigits, currencyCode });
  if (card) {
    const account = usableOrNull({
      account: await Accounts.findOne({ where: { id: card.mapping.accountId, userId } }),
    });
    if (account) return { account, matchedBy: 'card' };
  }

  if (source?.defaultAccountId) {
    const account = usableOrNull({
      account: await Accounts.findOne({ where: { id: source.defaultAccountId, userId } }),
    });
    if (account) return { account, matchedBy: 'sourceDefault' };
  }

  const remembered = await findHistoryAccount({ userId, cardLastDigits, currencyCode, source, clue });
  if (remembered && remembered.confidence !== 'unique') {
    const account = usableOrNull({ account: await Accounts.findOne({ where: { id: remembered.accountId, userId } }) });
    if (account) return { account, matchedBy: 'history' };
  }

  return null;
};

/** The account the source's earlier payments point at, with how sure that is; `null` for a source never seen. */
const findHistoryAccount = async ({
  userId,
  cardLastDigits,
  currencyCode,
  source,
  clue,
}: {
  userId: number;
  cardLastDigits: string | null;
  currencyCode: string | null;
  source: Pick<NotificationSources, 'id'> | null;
  clue?: HistoryClue;
}): Promise<{ accountId: RecordId; confidence: HistoryConfidence } | null> => {
  if (!source?.id || !currencyCode || !clue) return null;

  const { uses, balances } = await loadHistoryUses({ userId, sourceId: source.id });
  const stated = clue.balanceAfter && clue.balanceAfter.currencyCode === currencyCode ? clue.balanceAfter : null;

  return pickHistoryAccount({
    uses,
    balances,
    cardLastDigits,
    currencyCode,
    balanceAfter: stated ? Money.fromDecimal(stated.amount) : null,
    amount: Money.fromDecimal(clue.amount),
    kind: clue.kind,
  });
};

/** A name for comparison: diacritics, case and surrounding space ignored. */
const comparableName = ({ value }: { value: string }): string =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The shortest name that may stand for the other as a prefix: "Raiffeisen" for "Raiffeisen Bank", not "R". */
const MIN_PREFIX_NAME_LENGTH = 3;

/**
 * The account whose name matches the app a notification came from: equal, or one a prefix of the
 * other ("Raiffeisen" and "Raiffeisen Bank"), case and diacritics ignored. `null` unless exactly one
 * account matches.
 */
export const pickAccountByName = <T extends { id: RecordId; name: string }>({
  accounts,
  appName,
}: {
  accounts: readonly T[];
  appName: string | null;
}): T | null => {
  const app = appName ? comparableName({ value: appName }) : '';
  if (app.length < MIN_PREFIX_NAME_LENGTH) return null;

  const matches = accounts.filter((account) => {
    const name = comparableName({ value: account.name });

    return name.length >= MIN_PREFIX_NAME_LENGTH && (name.startsWith(app) || app.startsWith(name));
  });

  return matches.length === 1 ? matches[0]! : null;
};

/**
 * A guess for the inbox card of a payment whose account is unknown, never used to log the payment:
 *
 * 0. the account the source's earlier payments point at, even when nothing backs it but the currency (`pickHistoryAccount`);
 * 1. the one account in the payment's currency whose name matches the app the notification came from;
 * 2. else the user's only usable account in that currency.
 */
export const guessNotificationAccount = async ({
  userId,
  currencyCode,
  appName = null,
  cardLastDigits = null,
  source = null,
  clue,
}: {
  userId: number;
  currencyCode: string | null;
  appName?: string | null;
  cardLastDigits?: string | null;
  source?: Pick<NotificationSources, 'id'> | null;
  clue?: HistoryClue;
}): Promise<RecordId | null> => {
  if (!currencyCode) return null;

  const remembered = await findHistoryAccount({ userId, cardLastDigits, currencyCode, source, clue });
  if (remembered) return remembered.accountId;

  const accounts = await Accounts.findAll({
    where: { userId, currencyCode, status: { [Op.ne]: ACCOUNT_STATUSES.archived } },
    attributes: ['id', 'name', 'accountCategory'],
  });
  const usable = accounts.filter((account) => !isDedicatedFlowAccountCategory(account.accountCategory));

  const named = pickAccountByName({ accounts: usable, appName });
  if (named) return named.id;

  return usable.length === 1 ? usable[0]!.id : null;
};
