import type { RecordId } from '@bt/shared/types';
import { findTransactions } from '@models/transactions-query';
import { getUserDefaultCategory } from '@models/users.model';
import { subMonths } from 'date-fns';
import { Op, col, fn, literal } from 'sequelize';

/** How far back the payee's past categories count. */
const HISTORY_CATEGORY_MONTHS = 12;

/**
 * The category the owner most often gave the payee's past payments, or `null` when there is none.
 *
 * Counts only real, non-transfer rows dated since 12 months before `asOf`, with no upper bound
 * (a payment retried weeks after it was made also sees what the user logged since), and not the
 * user's default category: that one is what an uncategorized row carries, so it says nothing
 * about the payee. Split parents are left out as well, their category is derived from their
 * splits. The most frequent category wins and a tie goes to the one used last.
 */
export const pickHistoryCategory = async ({
  ownerUserId,
  payeeId,
  asOf,
}: {
  ownerUserId: number;
  payeeId: string;
  asOf: Date;
}): Promise<RecordId | null> => {
  const defaultCategoryId = await getUserDefaultCategory({ id: ownerUserId });

  const rows = await findTransactions({
    planned: 'exclude',
    access: { accountOwner: ownerUserId },
    balanceAdjustments: 'exclude',
    transfers: 'exclude',
    completeness: 'probe',
    where: {
      payeeId,
      categoryId: { [Op.ne]: defaultCategoryId },
      time: { [Op.gte]: subMonths(asOf, HISTORY_CATEGORY_MONTHS) },
      [Op.and]: literal(
        `NOT EXISTS (SELECT 1 FROM "TransactionSplits" WHERE "TransactionSplits"."transactionId" = "Transactions"."id")`,
      ),
    },
    attributes: ['categoryId'],
    group: ['categoryId'],
    order: [
      [fn('COUNT', col('Transactions.id')), 'DESC'],
      [fn('MAX', col('Transactions.time')), 'DESC'],
    ],
    raw: true,
  });

  return (rows[0]?.categoryId as RecordId | undefined) ?? null;
};
