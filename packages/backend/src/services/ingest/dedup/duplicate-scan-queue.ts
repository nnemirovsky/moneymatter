import { logger } from '@js/utils/logger';
import { Job, Queue, Worker } from 'bullmq';

import { runDuplicateScan } from './run-duplicate-scan';

interface DuplicateScanJobData {
  userId: number;
  transactionIds: string[];
}

/** One retry after a minute: a failed judge call is usually a provider hiccup. */
const DUPLICATE_SCAN_ATTEMPTS = 2;
const DUPLICATE_SCAN_BACKOFF_MS = 60_000;

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
    ? `ingest-duplicate-scan-${process.env.JEST_WORKER_ID}`
    : 'ingest-duplicate-scan';

/** Queue of freshly synced or imported rows waiting for the duplicate scan. */
export const duplicateScanQueue = new Queue<DuplicateScanJobData>(queueName, {
  connection,
  defaultJobOptions: {
    attempts: DUPLICATE_SCAN_ATTEMPTS,
    backoff: { type: 'fixed', delay: DUPLICATE_SCAN_BACKOFF_MS },
    removeOnComplete: true,
    removeOnFail: { age: 3600 },
  },
});

duplicateScanQueue.on('error', (err) => {
  // "Connection is closed" is what test teardown looks like.
  if (!err.message.includes('Connection is closed')) {
    logger.error({ message: '[Duplicate Scan Queue] Queue error', error: err });
  }
});

/** Exported for the teardown of the test environment and for shutdown. */
export const duplicateScanWorker = new Worker<DuplicateScanJobData>(
  queueName,
  async (job: Job<DuplicateScanJobData>) => {
    await runDuplicateScan({ userId: job.data.userId, transactionIds: job.data.transactionIds });
  },
  { connection, concurrency: 2 },
);

duplicateScanWorker.on('failed', (job, err) => {
  logger.error({
    message: `[Duplicate Scan Worker] Job ${job?.id ?? 'unknown'} failed (attempt ${job?.attemptsMade ?? 0})`,
    error: err,
  });
});

duplicateScanWorker.on('error', (err) => {
  if (!err.message.includes('Connection is closed')) {
    logger.error({ message: '[Duplicate Scan Worker] Worker error', error: err });
  }
});

/**
 * Queues the scan of rows a sync or an import just committed. The scan runs on a worker, so a slow
 * or failing judge never holds up the sync or the import that raised it.
 */
export const enqueueDuplicateScan = async ({
  userId,
  transactionIds,
}: {
  userId: number;
  transactionIds: readonly string[];
}): Promise<void> => {
  if (!transactionIds.length) return;

  await duplicateScanQueue.add('duplicate-scan', { userId, transactionIds: [...transactionIds] });
};
