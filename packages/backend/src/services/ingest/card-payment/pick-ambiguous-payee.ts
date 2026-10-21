import type { RecordId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import IngestRequests from '@models/ingest-requests.model';

import { pickPayeeWithAi } from '../payee/pick-payee-with-ai';
import { matchIngestMerchant } from '../payee/resolve-ingest-payee';
import { parsePayload } from './parse-payload';

/**
 * Before a tap is processed: when its merchant is as close to several of the user's payees, the AI
 * chooses among them here, outside any transaction, so no row lock waits for a model. The answer is
 * only a pick: processing checks it against the candidates again under its lock.
 *
 * Returns the chosen payee, or `null` when there is nothing to choose or the model chose none.
 */
export const pickAmbiguousPayee = async ({
  userId,
  requestId,
}: {
  userId: number;
  requestId: RecordId;
}): Promise<string | null> => {
  try {
    const row = await IngestRequests.findOne({
      where: { id: requestId, userId },
      attributes: ['payload', 'status', 'createdAt'],
    });
    if (!row || row.status === 'logged' || row.status === 'dismissed') return null;

    const parsed = parsePayload({ body: row.payload, receivedAt: row.createdAt });
    if (!parsed.ok || parsed.kind !== 'payment' || !parsed.merchant) return null;

    const match = await matchIngestMerchant({ userId, rawMerchant: parsed.merchant });
    if (match.kind !== 'ambiguous') return null;

    return await pickPayeeWithAi({ userId, merchant: parsed.merchant, candidates: match.candidates });
  } catch (error) {
    logger.error({ message: 'Failed to settle the payee of a tap before processing it', error: error as Error });

    return null;
  }
};
