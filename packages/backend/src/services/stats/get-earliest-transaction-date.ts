import { formatDayInZone } from '@common/lib/time-zones/tz-options';
import Accounts from '@models/accounts.model';
import { findTransactions } from '@models/transactions-query';
import { getUserTimeZone } from '@services/user-settings/get-user-time-zone';

interface GetEarliestTransactionDateParams {
  userId: number;
}

/**
 * Returns the date of the user's earliest (oldest) transaction, in the user's zone.
 * Only considers transactions from enabled accounts.
 * Returns null if the user has no transactions.
 *
 * Plans are intentions rather than history, so a future-dated one can never become the
 * date the user's records start.
 */
export const getEarliestTransactionDate = async ({
  userId,
}: GetEarliestTransactionDateParams): Promise<string | null> => {
  const [oldest] = await findTransactions({
    planned: 'exclude',
    access: { accessibleTo: userId },
    balanceAdjustments: 'include',
    completeness: 'probe',
    include: [
      {
        model: Accounts,
        where: { excludeFromStats: false },
        attributes: [],
      },
    ],
    order: [['time', 'ASC']],
    attributes: ['time'],
  });

  if (!oldest) return null;

  // The day in the viewing zone, so a report window that starts here still holds the row.
  return formatDayInZone({ date: new Date(oldest.time), zone: await getUserTimeZone({ userId }) });
};
