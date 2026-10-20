import type { RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import { withTransaction } from '@services/common/with-transaction';

import { sanitizeForJsonb } from './sanitize-payload';

/**
 * Writes the request row and commits it before any processing starts, so a payment the
 * processing cannot handle is still on record. A repeated `(userId, idempotencyKey)` keeps the
 * row that is already there: the returned id is always the row's, new or old.
 */
const recordIngestRequestImpl = async ({
  userId,
  tokenId,
  source,
  idempotencyKey,
  fingerprint,
  cardLabel,
  body,
}: {
  userId: number;
  tokenId: RecordId | null;
  source: string;
  idempotencyKey: string;
  fingerprint: string;
  cardLabel: string | null;
  body: unknown;
}): Promise<{ requestId: RecordId }> => {
  const payload = sanitizeForJsonb({ value: body });

  await IngestRequests.bulkCreate(
    [
      {
        userId,
        tokenId,
        pipeline: 'cardPayment',
        source,
        idempotencyKey,
        fingerprint,
        status: 'received',
        payload: typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : {},
        cardLabel,
      },
    ],
    { ignoreDuplicates: true },
  );

  const row = await IngestRequests.findOne({ where: { userId, idempotencyKey }, attributes: ['id'] });
  if (!row) throw new Error('The ingest request row is missing right after it was recorded.');

  return { requestId: row.id };
};

export const recordIngestRequest = withTransaction(recordIngestRequestImpl);
