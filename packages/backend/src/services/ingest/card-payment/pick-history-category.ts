import type { RecordId } from '@bt/shared/types';
import { findTransactions } from '@models/transactions-query';
import { getUserDefaultCategory } from '@models/users.model';
import { subMonths } from 'date-fns';
import { Op, col, fn, literal } from 'sequelize';

/** How far back the payee's past categories count. */
const HISTORY_CATEGORY_MONTHS = 12;

/**
 * The categories the owner gave each payee's past payments, the most frequent first and a tie to
 * the one used last. A payee with no such payment has no entry.
 *
 * Counts only real, non-transfer rows dated since 12 months before `asOf`, with no upper bound
 * (a payment retried weeks after it was made also sees what the user logged since), and not the
 * user's default category: that one is what an uncategorized row carries, so it says nothing
 * about the payee. Split parents are left out as well, their category is derived from their
 * splits, and so are the rows whose category a context notification chose (it names one order's venue), and so is `excludeTransactionId`: a payment just logged is not its own history.
 */
export const rankHistoryCategories = async ({
  ownerUserId,
  payeeIds,
  asOf,
  excludeTransactionId,
}: {
  ownerUserId: number;
  payeeIds: readonly string[];
  asOf: Date;
  excludeTransactionId?: RecordId;
}): Promise<Map<string, RecordId[]>> => {
  const ranked = new Map<string, RecordId[]>();
  if (!payeeIds.length) return ranked;

  const defaultCategoryId = await getUserDefaultCategory({ id: ownerUserId });

  const rows = await findTransactions({
    planned: 'exclude',
    access: { accountOwner: ownerUserId },
    balanceAdjustments: 'exclude',
    transfers: 'exclude',
    // One row per payee and category: every row is needed to rank them.
    completeness: 'all',
    where: {
      payeeId: { [Op.in]: [...payeeIds] },
      categoryId: { [Op.ne]: defaultCategoryId },
      time: { [Op.gte]: subMonths(asOf, HISTORY_CATEGORY_MONTHS) },
      ...(excludeTransactionId && { id: { [Op.ne]: excludeTransactionId } }),
      [Op.and]: [
        literal(
          `NOT EXISTS (SELECT 1 FROM "TransactionSplits" WHERE "TransactionSplits"."transactionId" = "Transactions"."id")`,
        ),
        // A category a context notification chose fits that order's venue, not the payee's next payment.
        literal(`COALESCE("Transactions"."externalData" #>> '{ingest,context,categoryApplied}', 'false') <> 'true'`),
      ],
    },
    attributes: ['payeeId', 'categoryId'],
    group: ['payeeId', 'categoryId'],
    order: [
      [fn('COUNT', col('Transactions.id')), 'DESC'],
      [fn('MAX', col('Transactions.time')), 'DESC'],
    ],
    raw: true,
  });

  for (const row of rows) {
    const payeeId = row.payeeId as string;
    ranked.set(payeeId, [...(ranked.get(payeeId) ?? []), row.categoryId as RecordId]);
  }

  return ranked;
};

/** The category the owner most often gave the payee's past payments, or `null` when there is none. */
export const pickHistoryCategory = async ({
  ownerUserId,
  payeeId,
  asOf,
  excludeTransactionId,
}: {
  ownerUserId: number;
  payeeId: string;
  asOf: Date;
  excludeTransactionId?: RecordId;
}): Promise<RecordId | null> => {
  const ranked = await rankHistoryCategories({ ownerUserId, payeeIds: [payeeId], asOf, excludeTransactionId });

  return ranked.get(payeeId)?.[0] ?? null;
};
