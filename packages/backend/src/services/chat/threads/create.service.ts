import type { ChatThread } from '@bt/shared/types';
import ChatThreads from '@models/chat-threads.model';
import { withTransaction } from '@services/common/with-transaction';

import { getChatRetentionDays } from './retention.service';
import { assertSelectableConnection, pickDefaultConnectionId } from './thread-connection';
import { notifyThreadUpdated } from './thread-events';
import { computeThreadExpiry } from './thread-expiry';
import { toChatThread } from './to-chat-thread';

interface CreateThreadParams {
  userId: number;
  title?: string;
  /** Omitted: the thread starts on the connection `pickDefaultConnectionId` names. Null picks the included model. */
  connectionId?: string | null;
}

const createThreadImpl = async ({
  userId,
  title,
  connectionId,
}: CreateThreadParams & { connectionId: string | null }): Promise<ChatThread> => {
  const retentionDays = await getChatRetentionDays({ userId, lock: true });
  const lastMessageAt = new Date();

  const thread = await ChatThreads.create({
    userId,
    // An untitled thread is shown with a localized placeholder until its first message names it.
    title: title ?? '',
    titleSource: title === undefined ? 'auto' : 'user',
    pinned: false,
    connectionId,
    lastMessageAt,
    expiresAt: computeThreadExpiry({ lastMessageAt, pinned: false, retentionDays }),
  });

  return toChatThread({ row: thread });
};

const createThreadTransactional = withTransaction(createThreadImpl);

export const createThread = async (params: CreateThreadParams): Promise<ChatThread> => {
  let connectionId: string | null;
  if (params.connectionId === undefined) {
    connectionId = await pickDefaultConnectionId({ userId: params.userId });
  } else {
    connectionId = params.connectionId;
    await assertSelectableConnection({ userId: params.userId, connectionId });
  }

  const thread = await createThreadTransactional({ ...params, connectionId });
  notifyThreadUpdated({ userId: params.userId, threadId: thread.id });
  return thread;
};
