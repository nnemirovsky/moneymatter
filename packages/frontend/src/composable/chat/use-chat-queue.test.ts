import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import {
  CHAT_QUEUE_STORAGE_KEY,
  QUEUED_ATTACHMENT_MAX_AGE_MS,
  hasExpiredAttachments,
  parseQueues,
  resetChatQueues,
  useChatQueue,
} from './use-chat-queue';

const attachment = { id: 'att-1', fileName: 'a.pdf', sizeBytes: 10 };

describe('useChatQueue', () => {
  beforeEach(() => {
    localStorage.clear();
    resetChatQueues();
  });

  it('keeps messages in order, per thread', () => {
    const threadId = ref<string | null>('t1');
    const queue = useChatQueue({ threadId });

    queue.enqueue({ text: 'one', attachments: [] });
    queue.enqueue({ text: 'two', attachments: [attachment] });
    threadId.value = 't2';
    queue.enqueue({ text: 'other', attachments: [] });

    expect(queue.items.value.map((item) => item.text)).toEqual(['other']);
    threadId.value = 't1';
    expect(queue.items.value.map((item) => item.text)).toEqual(['one', 'two']);
    expect(queue.items.value[1]!.attachments).toEqual([attachment]);
  });

  it('has no queue for a thread that has not started', () => {
    const queue = useChatQueue({ threadId: null });

    queue.enqueue({ text: 'lost', attachments: [] });

    expect(queue.items.value).toEqual([]);
    expect(localStorage.getItem(CHAT_QUEUE_STORAGE_KEY)).toBeNull();
  });

  it('takes messages off the front and puts a failed one back there', () => {
    const queue = useChatQueue({ threadId: 't1' });
    queue.enqueue({ text: 'one', attachments: [] });
    queue.enqueue({ text: 'two', attachments: [] });

    const first = queue.take()!;
    expect(first.text).toBe('one');
    expect(queue.items.value.map((item) => item.text)).toEqual(['two']);

    queue.putBack({ message: first, threadId: 't1' });
    expect(queue.items.value.map((item) => item.text)).toEqual(['one', 'two']);
  });

  it('returns null when nothing waits', () => {
    expect(useChatQueue({ threadId: 't1' }).take()).toBeNull();
  });

  it('removes one message', () => {
    const queue = useChatQueue({ threadId: 't1' });
    queue.enqueue({ text: 'one', attachments: [] });
    queue.enqueue({ text: 'two', attachments: [] });

    queue.remove({ id: queue.items.value[0]!.id });

    expect(queue.items.value.map((item) => item.text)).toEqual(['two']);
  });

  it('survives a reload through localStorage and clears the key when empty', () => {
    const queue = useChatQueue({ threadId: 't1' });
    queue.enqueue({ text: 'one', attachments: [attachment] });

    resetChatQueues();
    expect(queue.items.value.map((item) => item.text)).toEqual(['one']);

    queue.take();
    expect(localStorage.getItem(CHAT_QUEUE_STORAGE_KEY)).toBeNull();
  });

  it('works for the page when storage throws', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const queue = useChatQueue({ threadId: 't1' });

    queue.enqueue({ text: 'one', attachments: [] });

    expect(queue.items.value).toHaveLength(1);
    setItem.mockRestore();
  });
});

describe('shared storage', () => {
  beforeEach(() => {
    localStorage.clear();
    resetChatQueues();
  });

  it('puts a failed message back in the thread it was taken from, not the one open now', () => {
    const threadId = ref<string | null>('t1');
    const queue = useChatQueue({ threadId });
    queue.enqueue({ text: 'one', attachments: [] });
    const taken = queue.take()!;

    threadId.value = 't2';
    queue.putBack({ message: taken, threadId: 't1' });

    expect(queue.items.value).toEqual([]);
    threadId.value = 't1';
    expect(queue.items.value.map((item) => item.text)).toEqual(['one']);
  });

  it('keeps what another tab stored when this one changes a different thread', () => {
    const queue = useChatQueue({ threadId: 't2' });
    // Another tab queues on t1 after this one loaded.
    localStorage.setItem(
      CHAT_QUEUE_STORAGE_KEY,
      JSON.stringify({ t1: [{ id: 'x', text: 'other tab', attachments: [], queuedAt: 1 }] }),
    );

    queue.enqueue({ text: 'mine', attachments: [] });

    expect(JSON.parse(localStorage.getItem(CHAT_QUEUE_STORAGE_KEY)!)).toMatchObject({
      t1: [{ text: 'other tab' }],
      t2: [{ text: 'mine' }],
    });
  });

  it('does not take a message another tab already took', () => {
    const queue = useChatQueue({ threadId: 't1' });
    queue.enqueue({ text: 'one', attachments: [] });
    localStorage.removeItem(CHAT_QUEUE_STORAGE_KEY);

    expect(queue.take()).toBeNull();
  });

  it('follows another tab through the storage event', () => {
    const queue = useChatQueue({ threadId: 't1' });
    localStorage.setItem(
      CHAT_QUEUE_STORAGE_KEY,
      JSON.stringify({ t1: [{ id: 'x', text: 'other tab', attachments: [], queuedAt: 1 }] }),
    );

    window.dispatchEvent(new StorageEvent('storage', { key: CHAT_QUEUE_STORAGE_KEY }));

    expect(queue.items.value.map((item) => item.text)).toEqual(['other tab']);
  });
});

describe('hasExpiredAttachments', () => {
  const message = { id: 'a', text: '', queuedAt: 0 };
  const file = { id: 'att', fileName: 'a.pdf', sizeBytes: 1 };

  it('expires attachments of a message older than the margin', () => {
    expect(
      hasExpiredAttachments({ message: { ...message, attachments: [file] }, now: QUEUED_ATTACHMENT_MAX_AGE_MS + 1 }),
    ).toBe(true);
  });

  it('keeps a fresh message, and a message with nothing to expire', () => {
    expect(hasExpiredAttachments({ message: { ...message, attachments: [file] }, now: 1000 })).toBe(false);
    expect(
      hasExpiredAttachments({ message: { ...message, attachments: [] }, now: QUEUED_ATTACHMENT_MAX_AGE_MS * 2 }),
    ).toBe(false);
  });
});

describe('parseQueues', () => {
  it.each([null, '', 'not json', '[]', '"x"', '{"t1":"nope"}'])('reads %j as no queues', (raw) => {
    expect(parseQueues({ raw })).toEqual({});
  });

  it('drops malformed entries and keeps valid ones', () => {
    const raw = JSON.stringify({
      t1: [
        { id: 'a', text: 'ok', attachments: [], queuedAt: 1 },
        { id: 1 },
        { id: 'b', text: 'x', attachments: [{ id: 3 }], queuedAt: 1 },
      ],
      t2: [{ nope: true }],
    });

    expect(parseQueues({ raw })).toEqual({ t1: [{ id: 'a', text: 'ok', attachments: [], queuedAt: 1 }] });
  });
});
