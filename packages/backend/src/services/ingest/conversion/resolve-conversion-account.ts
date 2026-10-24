import { ACCOUNT_STATUSES, isDedicatedFlowAccountCategory, type RecordId } from '@bt/shared/types';
import Accounts from '@models/accounts.model';
import type NotificationSources from '@models/notification-sources.model';

import { pickAccountByName } from '../event/resolve-notification-account';
import { sourceAppName } from '../event/source-label';
import { findCardRows } from '../resolve-card-account';

/** The accounts of the user in `currencyCode` that take a manual payment. */
const usableAccountsIn = async ({ userId, currencyCode }: { userId: number; currencyCode: string }) =>
  (
    await Accounts.findAll({
      where: { userId, currencyCode },
      attributes: ['id', 'name', 'status', 'accountCategory'],
    })
  ).filter(
    (account) =>
      account.status !== ACCOUNT_STATUSES.archived && !isDedicatedFlowAccountCategory(account.accountCategory),
  );

/**
 * The account at the bank that told of an exchange which holds `currencyCode`. The notice never names it, so
 * only the bank's own accounts are searched, never the user's other accounts in that currency:
 *
 * 1. the card named after the app (the owner's "Example Bank" card): its row of that currency, else its default
 *    row when the account behind it is in that currency;
 * 2. the one account in that currency whose name matches the app;
 * 3. the source's default account, when it is in that currency.
 *
 * `null` when none is found; the card of the exchange then asks the owner.
 */
export const resolveConversionAccount = async ({
  userId,
  source,
  payload,
  currencyCode,
}: {
  userId: number;
  source: Pick<NotificationSources, 'appName' | 'bundleId' | 'defaultAccountId'> | null;
  payload: Record<string, unknown>;
  currencyCode: string;
}): Promise<RecordId | null> => {
  const accounts = await usableAccountsIn({ userId, currencyCode });
  const appName = sourceAppName({ source, payload });

  if (appName) {
    const rows = await findCardRows({ userId, cardLabel: appName });
    const row =
      rows.find((item) => item.currencyCode === currencyCode) ?? rows.find((item) => item.currencyCode === null);
    const mapped = accounts.find((account) => account.id === row?.accountId);
    if (mapped) return mapped.id;

    const named = pickAccountByName({ accounts, appName });
    if (named) return named.id;
  }

  return accounts.find((account) => account.id === source?.defaultAccountId)?.id ?? null;
};
