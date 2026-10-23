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
  /** When it was queued (ms), to tell whether its uploads can still be there: the server drops unsent ones. */
  queuedAt: number;
}

/** The server deletes attachments that no message claimed after an hour; leave a margin for the upload itself. */
export const QUEUED_ATTACHMENT_MAX_AGE_MS = 45 * 60 * 1000;

export const hasExpiredAttachments = ({ message, now = Date.now() }: { message: QueuedMessage; now?: number }) =>
  message.attachments.length > 0 && now - message.queuedAt > QUEUED_ATTACHMENT_MAX_AGE_MS;

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
    typeof item.queuedAt === 'number' &&
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

/** Null when storage cannot be read, so the page keeps the queues it has in memory. */
const readStorage = (): QueuesByThread | null => {
  try {
    return parseQueues({ raw: localStorage.getItem(CHAT_QUEUE_STORAGE_KEY) });
  } catch {
    return null;
  }
};

const writeStorage = ({ queues: next }: { queues: QueuesByThread }) => {
  try {
    if (Object.keys(next).length === 0) localStorage.removeItem(CHAT_QUEUE_STORAGE_KEY);
    else localStorage.setItem(CHAT_QUEUE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be blocked or full; the queue then lives for this page only.
  }
};

// Shared by every conversation view (the side panel and the Chat page), so a queue follows its thread around.
const queues = ref<QueuesByThread>(readStorage() ?? {});

/** Picks up what another tab stored; every change starts from this, so tabs do not overwrite each other. */
const syncFromStorage = () => {
  const stored = readStorage();
  if (stored) queues.value = stored;
};

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === CHAT_QUEUE_STORAGE_KEY || event.key === null) syncFromStorage();
  });
}

const setQueue = ({ threadId, list }: { threadId: string; list: QueuedMessage[] }) => {
  const next = { ...queues.value };
  if (list.length === 0) delete next[threadId];
  else next[threadId] = list;
  queues.value = next;
  writeStorage({ queues: next });
};

/** Re-reads storage; for tests, which start every case from a known state. */
export const resetChatQueues = () => {
  queues.value = readStorage() ?? {};
};

let nextId = 0;

/**
 * The messages waiting for the assistant to finish, per thread. They survive navigation and a reload.
 * A thread that has not started has no run to wait for, so it has no queue (`threadId` null).
 */
export const useChatQueue = ({ threadId }: { threadId: MaybeRefOrGetter<string | null> }) => {
  const items = computed(() => {
    const id = toValue(threadId);
    return id ? (queues.value[id] ?? []) : [];
  });

  /** A change names the thread it was made for: a send that outlasts a thread switch must not land in the new one. */
  const resolve = ({ explicit }: { explicit?: string | null }) => {
    syncFromStorage();
    return explicit ?? toValue(threadId);
  };

  const enqueue = ({ text, attachments }: { text: string; attachments: QueuedAttachment[] }) => {
    const id = resolve({});
    if (!id) return;
    const message: QueuedMessage = { id: `${Date.now()}-${nextId++}`, text, attachments, queuedAt: Date.now() };
    setQueue({ threadId: id, list: [...(queues.value[id] ?? []), message] });
  };

  const remove = ({ id: messageId }: { id: string }) => {
    const id = resolve({});
    if (!id) return;
    setQueue({ threadId: id, list: (queues.value[id] ?? []).filter((item) => item.id !== messageId) });
  };

  /** Takes the first message off the queue to send it; null when another tab took it first. */
  const take = (): QueuedMessage | null => {
    const id = resolve({});
    const [first, ...rest] = id ? (queues.value[id] ?? []) : [];
    if (!id || !first) return null;
    setQueue({ threadId: id, list: rest });
    return first;
  };

  /** Puts a message back at the front of its own thread's queue, when sending it failed. */
  const putBack = ({ message, threadId: ownerId }: { message: QueuedMessage; threadId: string }) => {
    const id = resolve({ explicit: ownerId });
    if (!id) return;
    setQueue({ threadId: id, list: [message, ...(queues.value[id] ?? [])] });
  };

  return { items, enqueue, remove, take, putBack };
};
