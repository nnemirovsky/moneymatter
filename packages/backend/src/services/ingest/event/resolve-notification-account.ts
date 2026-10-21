import { ACCOUNT_STATUSES, isDedicatedFlowAccountCategory, type RecordId } from '@bt/shared/types';
import Accounts from '@models/accounts.model';
import type NotificationSources from '@models/notification-sources.model';
import { Op } from 'sequelize';

import { resolveCardAccount } from '../resolve-card-account';

/** The account when it takes a manual payment (not archived, not a loan or a vehicle), else `null`. */
const usableOrNull = ({ account }: { account: Accounts | null }): Accounts | null =>
  account && account.status !== ACCOUNT_STATUSES.archived && !isDedicatedFlowAccountCategory(account.accountCategory)
    ? account
    : null;

/** How the account was found, in the order the lookup tries them; `owner` is the account chosen on an inbox card. */
type AccountMatch = 'card' | 'sourceDefault' | 'owner';

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
 * 2. the source's default account.
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
}: {
  userId: number;
  cardName: string | null;
  cardLastDigits: string | null;
  /** The currency the payment states, or `null` when the text states none. */
  currencyCode: string | null;
  source: Pick<NotificationSources, 'defaultAccountId'> | null;
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

  return null;
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
 * 1. the one account in the payment's currency whose name matches the app the notification came from;
 * 2. else the user's only usable account in that currency.
 */
export const guessNotificationAccount = async ({
  userId,
  currencyCode,
  appName = null,
}: {
  userId: number;
  currencyCode: string | null;
  appName?: string | null;
}): Promise<RecordId | null> => {
  if (!currencyCode) return null;

  const accounts = await Accounts.findAll({
    where: { userId, currencyCode, status: { [Op.ne]: ACCOUNT_STATUSES.archived } },
    attributes: ['id', 'name', 'accountCategory'],
  });
  const usable = accounts.filter((account) => !isDedicatedFlowAccountCategory(account.accountCategory));

  const named = pickAccountByName({ accounts: usable, appName });
  if (named) return named.id;

  return usable.length === 1 ? usable[0]!.id : null;
};
