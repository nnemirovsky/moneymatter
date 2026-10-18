import { findTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import { getAccessibleAccountIdsForUser } from '@services/sharing/auth/get-accessible-account-ids.service';
import { resolveBulkTargetIds } from '@services/transactions/matching-transactions';
import { Op } from 'sequelize';

import { validateBulkDeleteTransactionsArgs } from '../../../mcp/tools/bulk-delete-transactions';
import { hashTargetIds, latestUpdatedAt } from '../snapshot';
import {
  assertConcreteTargets,
  loadUserTransactions,
  PreviewError,
  TRANSACTION_SAMPLE_ATTRIBUTES,
  transactionsAffected,
} from './preview-helpers';
import type { PreviewResolver } from './types';

const noTargets = () =>
  new PreviewError({
    messageKey: 'chat.cards.noTargets',
    message: 'No transaction of yours matches, so there is nothing to change',
  });

/**
 * Updates the given ids: loads them, shows the count and up to 10 sample rows. The changed fields are
 * the card's own fields (the arguments), so the preview holds only what the call touches.
 */
export const resolveBulkUpdateTransactions: PreviewResolver = async ({ userId, args }) => {
  const requested = [...new Set((args.transactionIds ?? []) as string[])];
  assertConcreteTargets({ value: requested, what: 'transactions' });

  const rows = await loadUserTransactions({ userId, ids: requested });
  if (rows.length === 0) throw noTargets();

  const missing = requested.length - rows.length;
  const ids = rows.map((row) => row.id);

  return {
    preview: {
      affected: transactionsAffected({ rows, count: rows.length }),
      counts: { transactionCount: rows.length },
    },
    snapshot: {
      updatedAt: latestUpdatedAt({ dates: rows.map((row) => row.updatedAt) }),
      targetHash: hashTargetIds({ ids }),
      targetCount: rows.length,
    },
    affectedCount: rows.length,
    ...(missing > 0 ? { warnings: [{ key: 'chat.warnings.targetsMissing', params: { count: missing } }] } : {}),
  };
};

/**
 * The other leg of each transfer among the rows, which the delete removes with its leg. The delete
 * finds the legs by `transferId` alone, because a transfer across a shared account has one leg per
 * user, so this lookup is not limited to the creator either.
 */
async function loadTransferTwins({ rows }: { rows: Transactions[] }): Promise<Transactions[]> {
  const transferIds = [...new Set(rows.flatMap((row) => (row.transferId ? [row.transferId] : [])))];
  if (transferIds.length === 0) return [];

  return findTransactions({
    planned: 'include',
    access: 'unscoped-internal',
    balanceAdjustments: 'include',
    completeness: 'all',
    attributes: TRANSACTION_SAMPLE_ATTRIBUTES,
    where: { transferId: transferIds, id: { [Op.notIn]: rows.map((row) => row.id) } },
  });
}

/** The twins on accounts the user can see; the others count, but their details are not shown. */
async function visibleTwins({ userId, twins }: { userId: number; twins: Transactions[] }): Promise<Transactions[]> {
  if (twins.length === 0) return [];

  const accountIds = new Set(await getAccessibleAccountIdsForUser({ userId }));
  return twins.filter((twin) => accountIds.has(twin.accountId));
}

/** Each target followed by its twin, so the sample shows a transfer's two legs together. */
function withTwinsAfterTheirLeg({ rows, twins }: { rows: Transactions[]; twins: Transactions[] }): Transactions[] {
  const twinsByTransfer = Map.groupBy(twins, (twin) => twin.transferId);
  return rows.flatMap((row) => [row, ...(row.transferId ? (twinsByTransfer.get(row.transferId) ?? []) : [])]);
}

/**
 * Deletes by ids or by filters. Filters are validated exactly as the MCP handler validates them
 * (empty filters are refused), then resolved to the exact ids; those ids are frozen in the snapshot
 * and are what the approval deletes. The count, the sample and the typed phrase also cover the
 * transfer twins the delete removes.
 */
export const resolveBulkDeleteTransactions: PreviewResolver = async ({ userId, args }) => {
  assertConcreteTargets({ value: args, what: 'transactions' });
  const target = validateBulkDeleteTransactionsArgs({ args: args as never });

  const ids = [...new Set(await resolveBulkTargetIds({ userId, ...target }))];
  if (ids.length === 0) throw noTargets();

  const rows = await loadUserTransactions({ userId, ids });
  const twins = await loadTransferTwins({ rows });
  const total = rows.length + twins.length;

  return {
    preview: {
      affected: transactionsAffected({
        rows: withTwinsAfterTheirLeg({ rows, twins: await visibleTwins({ userId, twins }) }),
        count: total,
      }),
      counts: { transactionCount: rows.length, transferTwinCount: twins.length },
    },
    snapshot: {
      targetIds: ids.toSorted(),
      targetHash: hashTargetIds({ ids }),
      targetCount: ids.length,
      updatedAt: latestUpdatedAt({ dates: [...rows, ...twins].map((row) => row.updatedAt) }),
    },
    affectedCount: total,
    ...(twins.length > 0
      ? { warnings: [{ key: 'chat.warnings.transferTwins', params: { count: twins.length } }] }
      : {}),
  };
};
