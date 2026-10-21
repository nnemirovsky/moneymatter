import type { RecordId } from '@bt/shared/types';
import { t } from '@i18n/index';
import IngestRequests from '@models/ingest-requests.model';
import { withTransaction } from '@services/common/with-transaction';

import { isWaitingRequest, type ProcessIngestResult } from '../card-payment/process-ingest-request';
import { FORCE_PARK_REASONS } from './stored-parse';

type PrepareResult =
  | { kind: 'ready' }
  | { kind: 'conflict'; result: Extract<ProcessIngestResult, { outcome: 'conflict' }> };

const prepareNotificationRetryImpl = async ({
  requestId,
  force,
  locale,
}: {
  requestId: RecordId;
  force: boolean;
  locale: string;
}): Promise<PrepareResult> => {
  const row = await IngestRequests.findOne({ where: { id: requestId, pipeline: 'notification' }, lock: true });
  if (!row) throw new Error(`Ingest request ${requestId} does not exist.`);

  if (row.status === 'dismissed') {
    return {
      kind: 'conflict',
      result: { outcome: 'conflict', reason: 'dismissed', message: t({ key: 'ingest.requestDismissed', locale }) },
    };
  }

  if (!isWaitingRequest({ row })) {
    return {
      kind: 'conflict',
      result: { outcome: 'conflict', reason: 'notWaiting', message: t({ key: 'ingest.requestNotWaiting', locale }) },
    };
  }

  if (row.status === 'parked' && row.reason && FORCE_PARK_REASONS.includes(row.reason) && !force) {
    return {
      kind: 'conflict',
      result: {
        outcome: 'conflict',
        reason: row.reason as 'ownTransfer' | 'lowConfidence' | 'unverifiedParse',
        message: t({ key: 'ingest.requestNeedsApproval', locale }),
      },
    };
  }

  // Back to `received` under the row lock: of two concurrent retries the second finds a request
  // that is not waiting any more. The stored text and reading stay, so the job starts from them.
  await row.update({ status: 'received', reason: null, summary: null });

  return { kind: 'ready' };
};

/**
 * Checks a notification request may be retried and puts it back to `received` for the job. A
 * dismissed or settled request, and an approval-gated park without `force`, are returned conflicts.
 */
export const prepareNotificationRetry = withTransaction(prepareNotificationRetryImpl);
