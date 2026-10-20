import type { ChatRunStatus } from '@bt/shared/types';
import { logger } from '@js/utils/logger';

import { scheduleAssistantPushJob } from './assistant-push-queue';
import { type AssistantPushTarget, recordPushEvent } from './assistant-push-state';
import { isThreadPresent } from './presence';

/** Run statuses worth a push: the user waits for the answer. A cancelled or interrupted run is not one. */
const PUSHED_RUN_STATUSES: readonly ChatRunStatus[] = ['complete', 'failed', 'stepLimit'];

/**
 * Records the event and, when it opened a window, queues the delayed job. A push is a courtesy: a
 * failure here (Redis down) is logged and never reaches the run, the card or the payment that raised it.
 */
const emit = async ({
  target,
  detail = {},
}: {
  target: AssistantPushTarget;
  detail?: Record<string, unknown>;
}): Promise<void> => {
  try {
    const { opened } = await recordPushEvent({ target, detail });
    if (opened) await scheduleAssistantPushJob({ target });
  } catch (error) {
    logger.error({ message: 'Failed to queue an assistant push', error: error as Error });
  }
};

/**
 * A chat run ended. Pushes one `chatReplyReady`, or `chatCardsWaiting` when the run left cards, unless
 * the user is looking at the thread. Collapses per thread (`assistantPushConfig.threadCooldownMs`).
 */
export const emitChatRunFinished = async ({
  userId,
  threadId,
  messageId,
  status,
}: {
  userId: number;
  threadId: string;
  messageId: string;
  status: ChatRunStatus;
}): Promise<void> => {
  if (!PUSHED_RUN_STATUSES.includes(status)) return;

  try {
    if (await isThreadPresent({ userId, threadId })) return;
  } catch (error) {
    logger.error({ message: 'Failed to read chat presence', error: error as Error });
    return;
  }

  await emit({ target: { slot: 'thread', userId, key: threadId }, detail: { messageId, runStatus: status } });
};

/**
 * A new item landed in the Automation inbox. Collapses into one `automationInbox` push with a count
 * (`assistantPushConfig.inboxCooldownMs`); items that arrive during the cooldown wait in the inbox.
 */
export const emitInboxItem = ({ userId, threadId }: { userId: number; threadId: string }): Promise<void> =>
  emit({ target: { slot: 'inbox', userId, key: threadId } });

/**
 * A payment is stuck for a reason with no inbox card. One `ingestAttention` push per reason per
 * `assistantPushConfig.ingestCooldownMs`.
 */
export const emitIngestAttention = ({ userId, reason }: { userId: number; reason: string }): Promise<void> =>
  emit({ target: { slot: 'ingest', userId, key: reason } });
