import { AI_FEATURE, isAiCliProvider } from '@bt/shared/types';
import { t } from '@i18n/index';
import { NotFoundError, ValidationError } from '@js/errors';
import ChatThreads from '@models/chat-threads.model';
import { createAIClient } from '@services/ai';
import type { AIClientResult } from '@services/ai/ai-client-factory';
import { resolveAIConfiguration } from '@services/ai/ai-model-resolver';
import { assertCliAiAllowed, getCliAiAccess } from '@services/ai/cli/cli-access';
import { getStoredAiSettings } from '@services/user-settings/ai-connections';

const getConnections = async ({ userId }: { userId: number }) =>
  (await getStoredAiSettings({ userId }))?.connections ?? [];

/**
 * Throws unless the user's chat may run on `connectionId`: one of their own connections (a CLI one only
 * where CLI connections are allowed), or null for the included model where one serves chat.
 */
export async function assertSelectableConnection({
  userId,
  connectionId,
}: {
  userId: number;
  connectionId: string | null;
}): Promise<void> {
  if (connectionId === null) {
    const resolution = await resolveAIConfiguration({ userId, feature: AI_FEATURE.chat, pinnedConnectionId: null });
    if (resolution?.kind !== 'server') {
      throw new ValidationError({ message: t({ key: 'chat.includedModelUnavailable' }) });
    }
    return;
  }

  // Another user's connection id is not in this user's settings, so it answers like a missing one.
  const connection = (await getConnections({ userId })).find((candidate) => candidate.id === connectionId);
  if (!connection) throw new NotFoundError({ message: t({ key: 'ai.connectionNotFound' }) });

  if (isAiCliProvider({ provider: connection.provider })) await assertCliAiAllowed({ userId });
}

/** A connection a new thread may inherit: it exists, is not flagged down and its provider may run here. */
async function isInheritable({ userId, connectionId }: { userId: number; connectionId: string }): Promise<boolean> {
  const connection = (await getConnections({ userId })).find((candidate) => candidate.id === connectionId);
  if (!connection || connection.status === 'invalid') return false;

  return !isAiCliProvider({ provider: connection.provider }) || (await getCliAiAccess({ userId })).allowed;
}

/**
 * The connection a new thread starts on: the one the user's most recently used thread has, while it is
 * still usable; else the connection that answers by default; else the included model where one serves
 * chat. Null when nothing can answer yet.
 */
export async function pickDefaultConnectionId({ userId }: { userId: number }): Promise<string | null> {
  const latest = await ChatThreads.findOne({
    where: { userId },
    order: [
      ['lastMessageAt', 'DESC'],
      ['id', 'DESC'],
    ],
    attributes: ['connectionId'],
  });

  if (latest?.connectionId && (await isInheritable({ userId, connectionId: latest.connectionId }))) {
    return latest.connectionId;
  }

  const resolution = await resolveAIConfiguration({ userId, feature: AI_FEATURE.chat });

  return resolution?.kind === 'connection' ? resolution.connectionId : null;
}

/**
 * The AI client for a thread's next run, built on the thread's connection. A connection deleted since the
 * thread picked it falls back as for a new thread. When the client that answers is not the one the thread
 * names (the fallback, or a connection that could not be dialled), the thread keeps the one that answers.
 */
export async function createThreadAiClient({
  userId,
  threadId,
  connectionId,
}: {
  userId: number;
  threadId: string;
  connectionId: string | null;
}): Promise<AIClientResult | null> {
  const deleted =
    connectionId !== null && !(await getConnections({ userId })).some((candidate) => candidate.id === connectionId);
  const pinnedConnectionId = deleted ? await pickDefaultConnectionId({ userId }) : connectionId;

  const aiClient = await createAIClient({ userId, feature: AI_FEATURE.chat, pinnedConnectionId });

  const answeringConnectionId = aiClient ? (aiClient.connectionId ?? null) : connectionId;
  if (aiClient && answeringConnectionId !== connectionId) {
    await ChatThreads.update({ connectionId: answeringConnectionId }, { where: { id: threadId, userId } });
  }

  return aiClient;
}
