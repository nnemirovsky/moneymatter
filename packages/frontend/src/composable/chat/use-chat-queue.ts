import { type MaybeRefOrGetter, computed, ref, toValue } from 'vue';

export interface QueuedAttachment {
  id: string;
  fileName: string;
  sizeBytes: number;
}

/** A message the user wrote while the assistant was busy; its attachments are uploaded already. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: QueuedAttachment[];
}

type QueuesByThread = Record<string, QueuedMessage[]>;

export const CHAT_QUEUE_STORAGE_KEY = 'bt-chat-queue';

const isQueuedAttachment = (value: unknown): value is QueuedAttachment => {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.fileName === 'string' && typeof item.sizeBytes === 'number';
};

const isQueuedMessage = (value: unknown): value is QueuedMessage => {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.text === 'string' &&
    Array.isArray(item.attachments) &&
    item.attachments.every(isQueuedAttachment)
  );
};

/** Reads what storage held; anything that is not a queue per thread (or is not JSON) is an empty set of queues. */
export const parseQueues = ({ raw }: { raw: string | null }): QueuesByThread => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const queues: QueuesByThread = {};
    for (const [threadId, list] of Object.entries(parsed)) {
      if (!Array.isArray(list)) continue;
      const valid = list.filter(isQueuedMessage);
      if (valid.length > 0) queues[threadId] = valid;
    }
    return queues;
  } catch {
    return {};
  }
};

const readStorage = (): QueuesByThread => {
  try {
    return parseQueues({ raw: localStorage.getItem(CHAT_QUEUE_STORAGE_KEY) });
  } catch {
    return {};
  }
};

const writeStorage = ({ queues }: { queues: QueuesByThread }) => {
  try {
    if (Object.keys(queues).length === 0) localStorage.removeItem(CHAT_QUEUE_STORAGE_KEY);
    else localStorage.setItem(CHAT_QUEUE_STORAGE_KEY, JSON.stringify(queues));
  } catch {
    // Storage can be blocked or full; the queue then lives for this page only.
  }
};

// Shared by every conversation view (the side panel and the Chat page), so a queue follows its thread around.
const queues = ref<QueuesByThread>(readStorage());
let nextId = 0;

const setQueue = ({ threadId, list }: { threadId: string; list: QueuedMessage[] }) => {
  const next = { ...queues.value };
  if (list.length === 0) delete next[threadId];
  else next[threadId] = list;
  queues.value = next;
  writeStorage({ queues: next });
};

/** Re-reads storage; for tests, which start every case from a known state. */
export const resetChatQueues = () => {
  queues.value = readStorage();
};

/**
 * The messages waiting for the assistant to finish, per thread. They survive navigation and a reload.
 * A thread that has not started has no run to wait for, so it has no queue (`threadId` null).
 */
export const useChatQueue = ({ threadId }: { threadId: MaybeRefOrGetter<string | null> }) => {
  const items = computed(() => {
    const id = toValue(threadId);
    return id ? (queues.value[id] ?? []) : [];
  });

  const enqueue = ({ text, attachments }: { text: string; attachments: QueuedAttachment[] }) => {
    const id = toValue(threadId);
    if (!id) return;
    const message: QueuedMessage = { id: `${Date.now()}-${nextId++}`, text, attachments };
    setQueue({ threadId: id, list: [...(queues.value[id] ?? []), message] });
  };

  const remove = ({ id: messageId }: { id: string }) => {
    const id = toValue(threadId);
    if (!id) return;
    setQueue({ threadId: id, list: (queues.value[id] ?? []).filter((item) => item.id !== messageId) });
  };

  /** Takes the first message off the queue to send it. */
  const take = (): QueuedMessage | null => {
    const id = toValue(threadId);
    const [first, ...rest] = id ? (queues.value[id] ?? []) : [];
    if (!id || !first) return null;
    setQueue({ threadId: id, list: rest });
    return first;
  };

  /** Puts a message back at the front, when sending it failed. */
  const putBack = ({ message }: { message: QueuedMessage }) => {
    const id = toValue(threadId);
    if (!id) return;
    setQueue({ threadId: id, list: [message, ...(queues.value[id] ?? [])] });
  };

  return { items, enqueue, remove, take, putBack };
};
