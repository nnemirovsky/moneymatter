import type { RecordId } from '@bt/shared/types';
import { t } from '@i18n/index';
import { NotFoundError } from '@js/errors';
import IngestRequests from '@models/ingest-requests.model';
import { withTransaction } from '@services/common/with-transaction';

import { OPEN_REQUEST_STATUSES } from './process-ingest-request';

/**
 * Drops a payment the user does not want logged: it leaves the waiting list and a retry or a
 * resend of its key is refused. Only a request with no final outcome can be dismissed; a logged
 * or an already dismissed one is not found.
 *
 * The row is locked first, so a pass that is processing it right now finishes before the
 * dismissal is decided.
 */
const dismissIngestRequestImpl = async ({ userId, requestId }: { userId: number; requestId: RecordId }) => {
  const row = await IngestRequests.findOne({ where: { id: requestId, userId }, lock: true });

  if (!row || !OPEN_REQUEST_STATUSES.includes(row.status)) {
    throw new NotFoundError({ message: t({ key: 'ingest.requestNotFound' }) });
  }

  await row.update({ status: 'dismissed' });
};

export const dismissIngestRequest = withTransaction(dismissIngestRequestImpl);
