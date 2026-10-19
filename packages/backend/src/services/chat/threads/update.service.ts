import type { ChatThread } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ConflictError } from '@js/errors';
import { withTransaction } from '@services/common/with-transaction';

import { hasActiveRun } from '../runs/run-lease';
import { findThreadOrThrow } from './find-thread';
import { getChatRetentionDays } from './retention.service';
import { assertSelectableConnection, resolveThreadModel } from './thread-connection';
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
  /** A model of the thread's connection, or null for its own model. A switch of connection resets it first. */
  modelId?: string | null;
}

const updateThreadImpl = async ({
  userId,
  threadId,
  title,
  pinned,
  connectionId,
  modelId,
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

  const switchesConnection = connectionId !== undefined && connectionId !== thread.connectionId;
  const picksModel = modelId !== undefined && (switchesConnection || modelId !== thread.modelId);

  // The run in flight keeps the client it started with, so a switch now would show a model it is not on.
  // Asked first: validating a model probes the provider, which a refused switch should not cost.
  if ((switchesConnection || picksModel) && (await hasActiveRun({ threadId }))) {
    throw new ConflictError({ message: t({ key: 'chat.runInProgress' }) });
  }

  if (connectionId !== undefined && switchesConnection) {
    await assertSelectableConnection({ userId, connectionId });
    thread.connectionId = connectionId;
    // A model belongs to its connection: the new one starts on its own model unless the request names one.
    thread.modelId = null;
  }

  if (modelId !== undefined) {
    thread.modelId = await resolveThreadModel({ userId, connectionId: thread.connectionId, modelId });
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
