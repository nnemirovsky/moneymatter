import type { RecordId } from '@bt/shared/types';
import { t } from '@i18n/index';
import IngestRequests from '@models/ingest-requests.model';
import { withTransaction } from '@services/common/with-transaction';

import { readUserLocale } from '../card-payment/read-user-locale';

const processNotificationImpl = async ({ requestId }: { requestId: RecordId }): Promise<void> => {
  const row = await IngestRequests.findOne({ where: { id: requestId, pipeline: 'notification' }, lock: true });
  if (!row || row.status !== 'received') return;

  const locale = await readUserLocale({ userId: row.userId });

  await row.update({
    status: 'logged',
    reason: null,
    summary: t({ key: 'ingest.summary.notificationLogged', locale }),
  });
};

/**
 * What the processing job runs for one stored notification: it records the request as logged and
 * does nothing else (no parsing, no account, no transaction). A request that is no longer `received`
 * is left as it is.
 */
export const processNotification = withTransaction(processNotificationImpl);
