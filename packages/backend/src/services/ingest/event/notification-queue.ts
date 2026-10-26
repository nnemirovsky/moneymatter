import type { RecordId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { connection as database } from '@models/connection';
import IngestRequests from '@models/ingest-requests.model';
import { DelayedError, Job, Queue, Worker } from 'bullmq';
import { QueryTypes } from 'sequelize';

import { parkFailedRequest } from '../card-payment/park-failed-request';
import { readUserLocale } from '../card-payment/read-user-locale';
import { NOTIFICATION_JOB_ATTEMPTS, notificationTimings } from './constants';
import * as notificationProcessing from './process-notification';

interface NotificationJobData {
  requestId: RecordId;
}

// Same resilient settings as the other queues: a long connect timeout for slow CI, keepalive against
// idle disconnects, and the `maxRetriesPerRequest: null` BullMQ requires.
const connection = {
  host: process.env.APPLICATION_REDIS_HOST,
  maxRetriesPerRequest: null,
  connectTimeout: 20000,
  keepAlive: 10000,
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
};

// Namespaced by Jest worker in tests so parallel workers do not share a queue.
const queueName =
  process.env.NODE_ENV === 'test' && process.env.JEST_WORKER_ID
    ? `ingest-notification-${process.env.JEST_WORKER_ID}`
    : 'ingest-notification';

/**
 * Queue of stored notifications waiting to be processed. A job is added without delay, with an id
 * of its own per attempt (`${requestId}-${attempt}`), and is retried with backoff
 * (`notificationTimings.retryBackoffMs`, read when the job is added).
 */
export const notificationIngestQueue = new Queue<NotificationJobData>(queueName, {
  connection,
  defaultJobOptions: {
    attempts: NOTIFICATION_JOB_ATTEMPTS,
    removeOnComplete: true,
    removeOnFail: { age: 3600 },
  },
});

notificationIngestQueue.on('error', (err) => {
  // "Connection is closed" is what test teardown looks like.
  if (!err.message.includes('Connection is closed')) {
    logger.error({ message: '[Notification Ingest Queue] Queue error', error: err });
  }
});

/** Exported for the teardown of the test environment and for shutdown. */
export const notificationIngestWorker = new Worker<NotificationJobData>(
  queueName,
  async (job: Job<NotificationJobData>, token?: string) => {
    const result = await notificationProcessing.processNotification({ requestId: job.data.requestId });
    // The AI model is out of reach: the job is put back to run at the time the request names, without an attempt.
    if (typeof result === 'object') {
      await job.moveToDelayed(result.retryAt.getTime(), token);
      throw new DelayedError();
    }
    if (result !== 'locked') return;

    // A base-currency change holds the user's lock. The job goes back to the delayed set without
    // using an attempt and the request stays `received`; the banner poll answers "queued".
    await job.moveToDelayed(Date.now() + notificationTimings.lockRetryDelayMs, token);
    throw new DelayedError();
  },
  { connection, concurrency: 5 },
);

notificationIngestWorker.on('failed', async (job, err) => {
  if (!job) {
    logger.error({ message: '[Notification Ingest Worker] Job failed', error: err });
    return;
  }

  // BullMQ fires `failed` for every attempt; only the last one parks the request.
  if (job.attemptsMade < (job.opts.attempts ?? 1)) {
    logger.info(`[Notification Ingest Worker] Job ${job.id} attempt ${job.attemptsMade} failed, retrying`);
    return;
  }

  try {
    const row = await IngestRequests.findOne({ where: { id: job.data.requestId }, attributes: ['userId'] });
    if (!row) return;

    await parkFailedRequest({
      requestId: job.data.requestId,
      error: err,
      locale: await readUserLocale({ userId: row.userId }),
    });
  } catch (parkError) {
    logger.error({
      message: `[Notification Ingest Worker] Request ${job.data.requestId} could not be parked`,
      error: parkError instanceof Error ? parkError : new Error(String(parkError)),
    });
  }
});

notificationIngestWorker.on('error', (err) => {
  if (!err.message.includes('Connection is closed')) {
    logger.error({ message: '[Notification Ingest Worker] Worker error', error: err });
  }
});

/**
 * Hands a stored notification to the worker. The attempt counter on the row is incremented first and
 * names the job, so a retry always enqueues even while the failed job is still retained. BullMQ
 * rejects custom ids that contain `:`, so the parts are joined with `-`.
 */
export const enqueueNotificationProcessing = async ({ requestId }: { requestId: RecordId }): Promise<void> => {
  const [updated] = (await database.sequelize.query(
    `UPDATE "IngestRequests" SET "attempts" = "attempts" + 1 WHERE "id" = :requestId RETURNING "attempts"`,
    { replacements: { requestId }, type: QueryTypes.SELECT },
  )) as { attempts: number }[];
  if (!updated) throw new Error(`Ingest request ${requestId} does not exist.`);

  // A try that waits for the AI model is replaced by this one, so two chains of retries never run on one request.
  const earlier = await notificationIngestQueue.getJob(`${requestId}-${updated.attempts - 1}`);
  if (earlier && (await earlier.isDelayed())) await earlier.remove();

  await notificationIngestQueue.add(
    'process-notification',
    { requestId },
    {
      jobId: `${requestId}-${updated.attempts}`,
      backoff: { type: 'exponential', delay: notificationTimings.retryBackoffMs },
    },
  );
};
