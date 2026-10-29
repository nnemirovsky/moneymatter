import type { RecordId } from '@bt/shared/types';
import { TRANSACTION_TYPES } from '@bt/shared/types';
import { connection } from '@models/connection';
import IngestRequests from '@models/ingest-requests.model';
import { findTransactions } from '@models/transactions-query';
import { Op } from 'sequelize';
import { QueryTypes } from 'sequelize';

import { readStoredParse } from '../event/stored-parse';
import { ingestMarkersOf } from '../ingest-markers';
import { SETTLEMENT_MAX_AGE_MS, SETTLEMENT_MIN_AGE_MS, type SettlementCandidate } from './find-settlement';

/**
 * The payments on the account that a later balance could be settling: logged from a notice, booked in the account's
 * currency from an amount in another one, and still at the amount the notice stated (the owner has not edited it).
 */
export const loadSettlementCandidates = async ({
  userId,
  accountId,
  currencyCode,
  at,
  excludeId,
}: {
  userId: number;
  accountId: RecordId;
  currencyCode: string;
  at: Date;
  excludeId: RecordId;
}): Promise<SettlementCandidate[]> => {
  const rows = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: 'all',
    where: {
      accountId,
      id: { [Op.ne]: excludeId },
      transferId: null,
      originalCurrencyCode: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: currencyCode }] },
      time: {
        [Op.between]: [new Date(at.getTime() - SETTLEMENT_MAX_AGE_MS), new Date(at.getTime() - SETTLEMENT_MIN_AGE_MS)],
      },
    },
  });

  const candidates: SettlementCandidate[] = [];
  for (const row of rows) {
    const markers = ingestMarkersOf({ externalData: row.externalData });
    if (!markers.requestId) continue;

    const request = await IngestRequests.findOne({
      where: { id: markers.requestId, userId, pipeline: 'notification' },
      attributes: ['parsed'],
    });
    const notified = request ? readStoredParse({ value: request.parsed })?.payment : null;
    if (!notified || notified.currencyCode !== currencyCode || Number(notified.amount) !== row.amount.toNumber()) {
      continue;
    }

    candidates.push({
      id: row.id,
      kind: row.transactionType === TRANSACTION_TYPES.expense ? 'debit' : 'credit',
      amount: row.amount,
      time: row.time,
      proposed: markers.settlement?.status === 'proposed',
    });
  }

  return candidates;
};

/** Remembers that the correction was proposed, so the same balance does not ask twice. */
export const markSettlementProposed = async ({
  transactionId,
  from,
  to,
}: {
  transactionId: RecordId;
  from: number;
  to: number;
}): Promise<void> => {
  await connection.sequelize.query(
    `-- planned-ok: the marker belongs to the row whether it is a plan or not, so the base table is written on purpose
    UPDATE "Transactions"
        SET "externalData" = jsonb_set("externalData", '{ingest,settlement}', CAST(:settlement AS jsonb), true)
      WHERE "id" = :transactionId AND "externalData" #> '{ingest}' IS NOT NULL`,
    {
      replacements: { transactionId, settlement: JSON.stringify({ status: 'proposed', from, to }) },
      type: QueryTypes.UPDATE,
    },
  );
};
