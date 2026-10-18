import type { ChatThread } from '@bt/shared/types';
import { withTransaction } from '@services/common/with-transaction';

import { findThreadOrThrow } from './find-thread';
import { getChatRetentionDays } from './retention.service';
import { notifyThreadUpdated } from './thread-events';
import { computeThreadExpiry } from './thread-expiry';
import { toChatThread } from './to-chat-thread';

interface UpdateThreadParams {
  userId: number;
  threadId: string;
  title?: string;
  pinned?: boolean;
}

const updateThreadImpl = async ({ userId, threadId, title, pinned }: UpdateThreadParams): Promise<ChatThread> => {
  // Settings before thread, the order `setChatRetention` locks in.
  const retentionDays = pinned === undefined ? null : await getChatRetentionDays({ userId, lock: true });
  const thread = await findThreadOrThrow({ userId, threadId, lock: true });

  if (title !== undefined) {
    thread.title = title;
    thread.titleSource = 'user';
  }

  if (pinned !== undefined) {
    thread.pinned = pinned;
    thread.expiresAt = computeThreadExpiry({ lastMessageAt: thread.lastMessageAt, pinned, retentionDays });
  }

  await thread.save();

  return toChatThread({ row: thread });
};

const updateThreadTransactional = withTransaction(updateThreadImpl);

export const updateThread = async (params: UpdateThreadParams): Promise<ChatThread> => {
  const thread = await updateThreadTransactional(params);
  notifyThreadUpdated({ userId: params.userId, threadId: thread.id });
  return thread;
};
