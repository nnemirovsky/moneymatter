import type Transactions from '@models/transactions.model';

import { hashTargetIds, latestUpdatedAt } from '../snapshot';
import {
  assertConcreteTargets,
  loadUserTransactions,
  PreviewError,
  serializeRow,
  targetNotFound,
  transactionsAffected,
} from './preview-helpers';
import type { PreviewResolver } from './types';

/** Planned rows, transfers and refund-linked rows are refused by both reconciliation services. */
const isRefused = ({ row }: { row: Transactions }) => row.isPlanned || Boolean(row.transferId) || row.refundLinked;

async function loadDuplicates({ userId, ids }: { userId: number; ids: string[] }): Promise<Transactions[]> {
  assertConcreteTargets({ value: ids, what: 'transactions' });

  const rows = await loadUserTransactions({ userId, ids });
  if (rows.length !== ids.length) throw targetNotFound({ what: 'transactions' });

  if (rows.some((row) => isRefused({ row }))) {
    throw new PreviewError({
      messageKey: 'chat.cards.reconciliationRefused',
      message: 'Planned rows, transfers and refund-linked rows cannot be removed or merged as duplicates',
    });
  }
  return rows;
}

const snapshotOf = ({ rows }: { rows: Transactions[] }) => ({
  updatedAt: latestUpdatedAt({ dates: rows.map((row) => row.updatedAt) }),
  targetHash: hashTargetIds({ ids: rows.map((row) => row.id) }),
  targetCount: rows.length,
});

/** Removes the listed rows from the books (soft delete): the card lists exactly those rows. */
export const resolveRemoveDuplicateTransactions: PreviewResolver = async ({ userId, args }) => {
  const rows = await loadDuplicates({ userId, ids: [...new Set(args.transactionIds as string[])] });

  return {
    preview: { affected: transactionsAffected({ rows, count: rows.length }) },
    snapshot: snapshotOf({ rows }),
    affectedCount: rows.length,
  };
};

/** Merges duplicates into the survivor, which stays as it is: the card shows it, and lists the rows that go. */
export const resolveMergeDuplicateTransactions: PreviewResolver = async ({ userId, args }) => {
  const survivorId = args.survivorId as string;
  const rows = await loadDuplicates({ userId, ids: [...new Set(args.transactionIds as string[])] });

  const survivor = rows.find((row) => row.id === survivorId);
  if (!survivor) throw targetNotFound({ what: 'surviving transaction' });
  const removed = rows.filter((row) => row.id !== survivorId);

  return {
    preview: {
      before: serializeRow({ row: survivor }),
      affected: transactionsAffected({ rows: removed, count: removed.length }),
    },
    snapshot: snapshotOf({ rows }),
    affectedCount: removed.length,
  };
};
