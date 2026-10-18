import ImportBatchAccountEffects from '@models/import-batch-account-effects.model';
import ImportBatches from '@models/import-batches.model';
import { findTransactions } from '@models/transactions-query';
import * as Transactions from '@models/transactions.model';
import { Op } from 'sequelize';

import { hashTargetIds, latestUpdatedAt } from '../snapshot';
import { TRANSACTION_SAMPLE_ATTRIBUTES, targetNotFound, transactionsAffected } from './preview-helpers';
import type { PreviewResolver } from './types';

/**
 * Undoing an import deletes every transaction the batch stamped (the same set the service reads),
 * reverses the balance the import absorbed and removes the accounts it created. The other leg of a
 * transfer that lies outside the batch is deleted only with `deleteLinkedTransfers`.
 */
export const resolveDeleteImportBatch: PreviewResolver = async ({ userId, args }) => {
  const batchId = args.batchId as string;

  const batch = await ImportBatches.findOne({ where: { userId, batchId } });
  const effects = batch ? await ImportBatchAccountEffects.findAll({ where: { importBatchId: batch.id } }) : [];

  const rows = await Transactions.findWithFilters({
    planned: 'exclude',
    access: { creator: userId },
    completeness: 'all',
    balanceAdjustments: 'include',
    batchId: batch?.batchId ?? batchId,
    attributes: TRANSACTION_SAMPLE_ATTRIBUTES,
  });
  if (rows.length === 0 && !batch) throw targetNotFound({ what: 'import batch' });

  const transferIds = [...new Set(rows.flatMap((row) => (row.transferId ? [row.transferId] : [])))];
  const outside =
    transferIds.length === 0
      ? []
      : await findTransactions({
          planned: 'include',
          access: { creator: userId },
          balanceAdjustments: 'include',
          completeness: 'all',
          attributes: ['id', 'updatedAt'],
          where: { transferId: transferIds, id: { [Op.notIn]: rows.map((row) => row.id) } },
        });
  const deletesOutside = args.deleteLinkedTransfers === true;
  const total = rows.length + (deletesOutside ? outside.length : 0);

  const warnings = [
    ...(batch && !batch.finishedAt ? [{ key: 'chat.warnings.importRunning' }] : []),
    ...(deletesOutside && outside.length > 0
      ? [{ key: 'chat.warnings.linkedTransfers', params: { count: outside.length } }]
      : []),
  ];

  return {
    preview: {
      affected: transactionsAffected({ rows, count: total }),
      counts: {
        transactionCount: rows.length,
        createdAccountCount: effects.filter((effect) => effect.createdByImport).length,
        balanceReversalCount: effects.filter((effect) => !effect.absorbedAmount.isZero()).length,
      },
    },
    snapshot: {
      updatedAt: latestUpdatedAt({ dates: rows.map((row) => row.updatedAt) }),
      targetHash: hashTargetIds({ ids: rows.map((row) => row.id) }),
      targetCount: rows.length,
    },
    affectedCount: total,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};
