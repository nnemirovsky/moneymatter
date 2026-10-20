import { isIngestPlan } from '@bt/shared/types';
import type Transactions from '@models/transactions.model';

import { hashTargetIds, latestUpdatedAt } from '../snapshot';
import {
  assertConcreteTargets,
  keepVisibleRows,
  loadUserTransactions,
  PreviewError,
  serializeRow,
  targetNotFound,
  transactionsAffected,
} from './preview-helpers';
import type { PreviewResolver } from './types';

/**
 * Both reconciliation services refuse a planned row unless an ingest pipeline wrote it, and refuse
 * transfers and refund-linked rows.
 */
const isRefused = ({ row }: { row: Transactions }) =>
  (row.isPlanned && !isIngestPlan({ tx: row })) || Boolean(row.transferId) || row.refundLinked;

async function loadDuplicates({
  userId,
  ids,
  lock,
}: {
  userId: number;
  ids: string[];
  lock?: boolean;
}): Promise<Transactions[]> {
  assertConcreteTargets({ value: ids, what: 'transactions' });

  // `externalData` tells an ingest plan, which the services accept, from the owner's own plan.
  const rows = await loadUserTransactions({ userId, ids, lock, extraAttributes: ['externalData'] });
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

/**
 * Removes the listed rows from the books (soft delete): the card counts exactly those rows, and
 * lists the ones on accounts the user can still see.
 */
export const resolveRemoveDuplicateTransactions: PreviewResolver = async ({ userId, args, lock }) => {
  const rows = await loadDuplicates({ userId, ids: [...new Set(args.transactionIds as string[])], lock });

  return {
    preview: { affected: transactionsAffected({ rows: await keepVisibleRows({ userId, rows }), count: rows.length }) },
    snapshot: snapshotOf({ rows }),
    affectedCount: rows.length,
  };
};

/** Merges duplicates into the survivor, which stays as it is: the card shows it, and lists the rows that go. */
export const resolveMergeDuplicateTransactions: PreviewResolver = async ({ userId, args, lock }) => {
  const survivorId = args.survivorId as string;
  const rows = await loadDuplicates({ userId, ids: [...new Set(args.transactionIds as string[])], lock });

  const survivor = rows.find((row) => row.id === survivorId);
  if (!survivor) throw targetNotFound({ what: 'surviving transaction' });
  const removed = rows.filter((row) => row.id !== survivorId);
  // The merge service keeps a booked row over a plan, never the other way round.
  if (survivor.isPlanned && removed.some((row) => !row.isPlanned)) {
    throw new PreviewError({
      messageKey: 'chat.cards.reconciliationPlannedSurvivor',
      message: 'A planned payment cannot be the one that stays when it is merged with a booked row',
    });
  }
  const survivorVisible = (await keepVisibleRows({ userId, rows: [survivor] })).length > 0;

  return {
    preview: {
      ...(survivorVisible ? { before: serializeRow({ row: survivor }) } : {}),
      affected: transactionsAffected({ rows: await keepVisibleRows({ userId, rows: removed }), count: removed.length }),
    },
    snapshot: snapshotOf({ rows }),
    affectedCount: removed.length,
  };
};
