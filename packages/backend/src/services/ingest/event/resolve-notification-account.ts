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

/** How the account was found, in the order the lookup tries them. */
type AccountMatch = 'card' | 'sourceDefault';

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

/**
 * A guess for the inbox card of a payment whose account is unknown: the user's only usable account in
 * the payment's currency. It pre-fills the card and is never used to log the payment.
 */
export const guessNotificationAccount = async ({
  userId,
  currencyCode,
}: {
  userId: number;
  currencyCode: string | null;
}): Promise<RecordId | null> => {
  if (!currencyCode) return null;

  const accounts = await Accounts.findAll({
    where: { userId, currencyCode, status: { [Op.ne]: ACCOUNT_STATUSES.archived } },
    attributes: ['id', 'accountCategory'],
    limit: 3,
  });
  const usable = accounts.filter((account) => !isDedicatedFlowAccountCategory(account.accountCategory));

  return usable.length === 1 ? usable[0]!.id : null;
};
