import { NOTIFICATION_TYPES, type NotificationPayload, type NotificationType } from '@bt/shared/types';
import ChatProposals from '@models/chat-proposals.model';
import ChatThreads from '@models/chat-threads.model';
import { createNotification } from '@services/notifications';

import { readUserLocale } from '../ingest/card-payment/read-user-locale';
import { assistantPushConfig } from './assistant-push-config';
import {
  type AssistantPushTarget,
  discardPushState,
  isCoolingDown,
  startCooldown,
  takePushState,
} from './assistant-push-state';
import { renderAssistantBody, renderAssistantTitle } from './assistant-push-text';
import { isThreadPresent } from './presence';

interface Built {
  type: NotificationType;
  payload: NotificationPayload;
}

/** A chat reply, or the cards it left: one push, the cards version when any are still waiting. */
const buildThreadPush = async ({
  target,
  detail,
}: {
  target: AssistantPushTarget;
  detail: Record<string, any>;
}): Promise<Built | null> => {
  const thread = await ChatThreads.findOne({
    where: { id: target.key, userId: target.userId },
    attributes: ['id', 'title', 'titleSource'],
  });
  if (!thread) return null;

  // An automatic title is the first words the user typed: message text, which a push never carries.
  const threadTitle = thread.titleSource === 'auto' ? '' : thread.title;

  const cardCount =
    typeof detail.messageId === 'string'
      ? await ChatProposals.count({ where: { userId: target.userId, messageId: detail.messageId, status: 'pending' } })
      : 0;

  if (cardCount > 0) {
    return {
      type: NOTIFICATION_TYPES.chatCardsWaiting,
      payload: { threadId: thread.id, threadTitle, cardCount },
    };
  }

  return {
    type: NOTIFICATION_TYPES.chatReplyReady,
    payload: { threadId: thread.id, threadTitle, runStatus: detail.runStatus },
  };
};

const buildPush = async ({
  target,
  count,
  detail,
}: {
  target: AssistantPushTarget;
  count: number;
  detail: Record<string, any>;
}): Promise<Built | null> => {
  switch (target.slot) {
    case 'thread':
      return buildThreadPush({ target, detail });
    case 'inbox':
      return { type: NOTIFICATION_TYPES.automationInbox, payload: { threadId: target.key, count } };
    case 'ingest':
      return { type: NOTIFICATION_TYPES.ingestAttention, payload: { reason: target.key } };
  }
};

const cooldownMsOf = ({ slot }: { slot: AssistantPushTarget['slot'] }): number => {
  switch (slot) {
    case 'thread':
      return assistantPushConfig.threadCooldownMs;
    case 'inbox':
      return assistantPushConfig.inboxCooldownMs;
    case 'ingest':
      return assistantPushConfig.ingestCooldownMs;
  }
};

/** Whether the user is looking at the thread the push would be about. */
const isUserLooking = ({ target }: { target: AssistantPushTarget }): Promise<boolean> =>
  target.slot === 'ingest' ? Promise.resolve(false) : isThreadPresent({ userId: target.userId, threadId: target.key });

/**
 * Runs when a window ends: turns the events it collected into one notification. The bell entry is
 * always written; whether it also goes out as a push is decided by the web-push fan-out from the
 * user's `assistant` group preference. Nothing is sent when the target started cooling down meanwhile
 * or the user opened the thread in the window.
 */
export const processAssistantPush = async ({ target }: { target: AssistantPushTarget }): Promise<void> => {
  if (await isCoolingDown({ target })) {
    await discardPushState({ target });
    return;
  }

  const state = await takePushState({ target });
  if (!state) return;

  if (await isUserLooking({ target })) return;

  const built = await buildPush({ target, count: state.count, detail: state.detail });
  if (!built) return;

  const locale = await readUserLocale({ userId: target.userId });
  const payload = built.payload as Record<string, any>;

  await createNotification({
    userId: target.userId,
    type: built.type,
    title: renderAssistantTitle({ type: built.type, payload, locale }),
    message: renderAssistantBody({ type: built.type, payload, locale }),
    payload: built.payload,
  });
  await startCooldown({ target, ms: cooldownMsOf({ slot: target.slot }) });
};
