import type {
  ChatRetentionDays,
  ChatSettings,
  ChatThread,
  ChatThreadListPage,
  ChatThreadWithMessages,
} from '@bt/shared/types';

import { makeRequest } from './common';

const buildQuery = ({ params }: { params: Record<string, string | number | undefined> }): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

export async function createChatThread<R extends boolean | undefined = undefined>({
  title,
  raw,
}: { title?: string; raw?: R } = {}) {
  return makeRequest<ChatThread, R>({
    method: 'post',
    url: '/chat/threads',
    payload: title === undefined ? {} : { title },
    raw,
  });
}

export async function listChatThreads<R extends boolean | undefined = undefined>({
  q,
  cursor,
  limit,
  raw,
}: { q?: string; cursor?: string; limit?: number; raw?: R } = {}) {
  return makeRequest<ChatThreadListPage, R>({
    method: 'get',
    url: `/chat/threads${buildQuery({ params: { q, cursor, limit } })}`,
    raw,
  });
}

export async function getChatThread<R extends boolean | undefined = undefined>({
  threadId,
  before,
  limit,
  raw,
}: {
  threadId: string;
  before?: string;
  limit?: number;
  raw?: R;
}) {
  return makeRequest<ChatThreadWithMessages, R>({
    method: 'get',
    url: `/chat/threads/${threadId}${buildQuery({ params: { before, limit } })}`,
    raw,
  });
}

export async function updateChatThread<R extends boolean | undefined = undefined>({
  threadId,
  payload,
  raw,
}: {
  threadId: string;
  payload: { title?: string; pinned?: boolean };
  raw?: R;
}) {
  return makeRequest<ChatThread, R>({ method: 'patch', url: `/chat/threads/${threadId}`, payload, raw });
}

export async function deleteChatThread<R extends boolean | undefined = undefined>({
  threadId,
  raw,
}: {
  threadId: string;
  raw?: R;
}) {
  return makeRequest<void, R>({ method: 'delete', url: `/chat/threads/${threadId}`, raw });
}

/** `retentionDays` is typed wide so a test can send a value the API must refuse. */
export async function setChatRetention<R extends boolean | undefined = undefined>({
  retentionDays,
  raw,
}: {
  retentionDays: ChatRetentionDays | number | null;
  raw?: R;
}) {
  return makeRequest<ChatSettings, R>({ method: 'put', url: '/chat/settings', payload: { retentionDays }, raw });
}
