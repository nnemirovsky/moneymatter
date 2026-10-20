import { logger } from '@js/utils/logger';
import { Job, Queue, Worker } from 'bullmq';

import { assistantPushConfig } from './assistant-push-config';
import { type AssistantPushTarget } from './assistant-push-state';
import { processAssistantPush } from './process-assistant-push';

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
    ? `assistant-push-${process.env.JEST_WORKER_ID}`
    : 'assistant-push';

const PUSH_JOB = 'assistant-push';

/**
 * Delayed jobs, one per push window: when one fires, the events of its window become one notification.
 * A job id is `assistant-<slot>-<userId>-<key>-<windowStart>`; BullMQ rejects custom ids that contain `:`.
 */
export const assistantPushQueue = new Queue<AssistantPushTarget>(queueName, {
  connection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: { age: 3600 }, attempts: 2 },
});

assistantPushQueue.on('error', (err) => {
  if (!err.message.includes('Connection is closed')) {
    logger.error({ message: '[Assistant Push Queue] Queue error', error: err });
  }
});

/** Exported for the teardown of the test environment and for shutdown. */
export const assistantPushWorker = new Worker<AssistantPushTarget>(
  queueName,
  async (job: Job<AssistantPushTarget>) => processAssistantPush({ target: job.data }),
  { connection, concurrency: 5 },
);

assistantPushWorker.on('failed', (job, err) => {
  logger.error({ message: `[Assistant Push Worker] Job ${job?.id} failed`, error: err });
});

assistantPushWorker.on('error', (err) => {
  if (!err.message.includes('Connection is closed')) {
    logger.error({ message: '[Assistant Push Worker] Worker error', error: err });
  }
});

/** Queues the job that ends the window `target` just opened. */
export const scheduleAssistantPushJob = async ({ target }: { target: AssistantPushTarget }): Promise<void> => {
  await assistantPushQueue.add(PUSH_JOB, target, {
    delay: assistantPushConfig.debounceMs,
    jobId: ['assistant', target.slot, target.userId, target.key, Date.now()].join('-'),
  });
};
