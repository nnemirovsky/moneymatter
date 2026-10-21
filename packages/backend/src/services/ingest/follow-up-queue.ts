import type { RecordId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { Job, Queue, Worker } from 'bullmq';

import { afterPaymentLogged } from './after-payment-logged';

interface FollowUpJobData {
  userId: number;
  transactionId: RecordId;
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
    ? `ingest-follow-up-${process.env.JEST_WORKER_ID}`
    : 'ingest-follow-up';

/**
 * Queue of freshly logged payments waiting for their follow-ups (`afterPaymentLogged`). A job runs once:
 * every follow-up logs its own failure and stores only a suggestion, so a retry would add nothing.
 */
export const ingestFollowUpQueue = new Queue<FollowUpJobData>(queueName, {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: { age: 3600 },
  },
});

ingestFollowUpQueue.on('error', (err) => {
  // "Connection is closed" is what test teardown looks like.
  if (!err.message.includes('Connection is closed')) {
    logger.error({ message: '[Ingest Follow-up Queue] Queue error', error: err });
  }
});

/** Exported for the teardown of the test environment and for shutdown. */
export const ingestFollowUpWorker = new Worker<FollowUpJobData>(
  queueName,
  async (job: Job<FollowUpJobData>) => {
    await afterPaymentLogged({ userId: job.data.userId, transactionId: job.data.transactionId });
  },
  // A model call can outlast the default lock; the lock is renewed while the job runs.
  { connection, concurrency: 3, lockDuration: 60_000 },
);

ingestFollowUpWorker.on('failed', (job, err) => {
  logger.error({
    message: `[Ingest Follow-up Worker] Job ${job?.id ?? 'unknown'} failed`,
    error: err,
  });
});

ingestFollowUpWorker.on('error', (err) => {
  if (!err.message.includes('Connection is closed')) {
    logger.error({ message: '[Ingest Follow-up Worker] Worker error', error: err });
  }
});

/**
 * Hands a logged payment to the follow-up worker. The shortcut's answer never waits for them: the
 * short-balance composer and the duplicate judge are model calls bounded only by the AI call guards.
 * A queue that cannot take the job is logged, because the payment is already committed and answered.
 */
export const enqueueAfterPaymentLogged = async ({
  userId,
  transactionId,
}: {
  userId: number;
  transactionId: RecordId;
}): Promise<void> => {
  try {
    await ingestFollowUpQueue.add('after-payment-logged', { userId, transactionId });
  } catch (error) {
    logger.error({ message: 'Failed to queue the follow-ups of a logged payment', error: error as Error });
  }
};
