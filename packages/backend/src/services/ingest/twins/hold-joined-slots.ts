import type { RecordId } from '@bt/shared/types';
import { connection } from '@models/connection';
import type IngestRequests from '@models/ingest-requests.model';
import { findOneTransaction } from '@models/transactions-query';
import { withTransaction } from '@services/common/with-transaction';
import { QueryTypes } from 'sequelize';

import { readTakenSlots, type IngestSourceEntry } from '../dedup/source-slots';
import { findJoinedTwins, probeOf } from './find-parked-twins';

const holdJoinedSlotsImpl = async ({
  request,
  transactionId,
}: {
  request: IngestRequests;
  transactionId: RecordId;
}): Promise<string[]> => {
  const row = await findOneTransaction({
    where: { id: transactionId },
    planned: 'include',
    access: { accountOwner: request.userId },
    balanceAdjustments: 'exclude',
    attributes: ['id', 'externalData'],
  });
  if (!row) return [];

  const taken = readTakenSlots({ externalData: row.externalData });
  const entries: IngestSourceEntry[] = [];
  for (const twin of await findJoinedTwins({ userId: request.userId, requestId: request.id })) {
    const probe = await probeOf({ request: twin });
    if (!probe || taken.includes(probe.slot)) continue;

    entries.push({
      requestId: twin.id,
      pipeline: 'notification',
      sourceKey: probe.sourceKey ?? null,
      slot: probe.slot,
    });
    taken.push(probe.slot);
  }

  if (entries.length) {
    await connection.sequelize.query(
      `UPDATE "Transactions"
          SET "externalData" = jsonb_set(
                "externalData",
                '{ingest,sources}',
                COALESCE("externalData"->'ingest'->'sources', '[]'::jsonb) || CAST(:entries AS jsonb)
              )
        WHERE "id" = :transactionId AND "externalData"->'ingest' IS NOT NULL`,
      { replacements: { entries: JSON.stringify(entries), transactionId }, type: QueryTypes.UPDATE },
    );
  }

  return taken;
};

/**
 * Records, on the logged row, the slots of the requests that joined the logged request as its twins (a
 * bank push that joined Wallet's request): the row holds one request per slot, so a second payment from
 * that source is another payment and never attaches to this row. Returns every slot the row now holds.
 */
export const holdJoinedSlots = withTransaction(holdJoinedSlotsImpl);
