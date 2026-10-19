import type { ChatThread } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ConflictError } from '@js/errors';
import { withTransaction } from '@services/common/with-transaction';

import { hasActiveRun } from '../runs/run-lease';
import { findThreadOrThrow } from './find-thread';
import { getChatRetentionDays } from './retention.service';
import { assertSelectableConnection } from './thread-connection';
import { notifyThreadUpdated } from './thread-events';
import { computeThreadExpiry } from './thread-expiry';
import { toChatThread } from './to-chat-thread';

interface UpdateThreadParams {
  userId: number;
  threadId: string;
  title?: string;
  pinned?: boolean;
  /** A connection of the user, or null for the included model; it takes effect on the next message. */
  connectionId?: string | null;
}

const updateThreadImpl = async ({
  userId,
  threadId,
  title,
  pinned,
  connectionId,
}: UpdateThreadParams): Promise<ChatThread> => {
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

  if (connectionId !== undefined && connectionId !== thread.connectionId) {
    await assertSelectableConnection({ userId, connectionId });
    // The run in flight keeps the client it started with, so a switch now would show a connection it is not on.
    if (await hasActiveRun({ threadId })) throw new ConflictError({ message: t({ key: 'chat.runInProgress' }) });
    thread.connectionId = connectionId;
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
