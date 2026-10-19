import type { ChatThread } from '@bt/shared/types';
import ChatThreads from '@models/chat-threads.model';
import { withTransaction } from '@services/common/with-transaction';

import { getChatRetentionDays } from './retention.service';
import { notifyThreadUpdated } from './thread-events';
import { computeThreadExpiry } from './thread-expiry';
import { toChatThread } from './to-chat-thread';

const createThreadImpl = async ({ userId, title }: { userId: number; title?: string }): Promise<ChatThread> => {
  const retentionDays = await getChatRetentionDays({ userId, lock: true });
  const lastMessageAt = new Date();

  const thread = await ChatThreads.create({
    userId,
    // An untitled thread is shown with a localized placeholder until its first message names it.
    title: title ?? '',
    titleSource: title === undefined ? 'auto' : 'user',
    pinned: false,
    lastMessageAt,
    expiresAt: computeThreadExpiry({ lastMessageAt, pinned: false, retentionDays }),
  });

  return toChatThread({ row: thread });
};

const createThreadTransactional = withTransaction(createThreadImpl);

export const createThread = async (params: { userId: number; title?: string }): Promise<ChatThread> => {
  const thread = await createThreadTransactional(params);
  notifyThreadUpdated({ userId: params.userId, threadId: thread.id });
  return thread;
};
