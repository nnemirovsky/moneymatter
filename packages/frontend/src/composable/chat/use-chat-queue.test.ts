import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { CHAT_QUEUE_STORAGE_KEY, parseQueues, resetChatQueues, useChatQueue } from './use-chat-queue';

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

    queue.putBack({ message: first });
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

describe('parseQueues', () => {
  it.each([null, '', 'not json', '[]', '"x"', '{"t1":"nope"}'])('reads %j as no queues', (raw) => {
    expect(parseQueues({ raw })).toEqual({});
  });

  it('drops malformed entries and keeps valid ones', () => {
    const raw = JSON.stringify({
      t1: [{ id: 'a', text: 'ok', attachments: [] }, { id: 1 }, { id: 'b', text: 'x', attachments: [{ id: 3 }] }],
      t2: [{ nope: true }],
    });

    expect(parseQueues({ raw })).toEqual({ t1: [{ id: 'a', text: 'ok', attachments: [] }] });
  });
});
