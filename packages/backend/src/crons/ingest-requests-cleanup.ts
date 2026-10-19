import { INGEST_REQUEST_RETENTION_DAYS } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import { subDays } from 'date-fns';
import { Op } from 'sequelize';

import { createScheduledSync } from './lib/create-scheduled-sync';

/**
 * Deletes requests that reached a final outcome and have not changed for the retention period.
 * Waiting requests (`parked`, `received`) stay until the user logs or dismisses them: they hold
 * a payment that exists nowhere else.
 */
const deleteFinishedRequests = async (): Promise<{ deleted: number }> => ({
  deleted: await IngestRequests.destroy({
    where: {
      status: { [Op.in]: ['logged', 'rejected', 'dismissed'] },
      updatedAt: { [Op.lt]: subDays(new Date(), INGEST_REQUEST_RETENTION_DAYS) },
    },
  }),
});

/** Schedule: 04:30 UTC daily, after the other retention sweeps. */
export const ingestRequestsCleanupCron = createScheduledSync({
  name: 'cleanup of finished card-payment requests',
  cronExpression: '30 4 * * *',
  timeZone: 'UTC',
  scheduleDescription: 'runs daily at 04:30 UTC',
  errorCode: 'INGEST_REQUESTS_CLEANUP_CRON',
  run: deleteFinishedRequests,
});
