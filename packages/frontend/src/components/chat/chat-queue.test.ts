import type { QueuedMessage } from '@/composable/chat/use-chat-queue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { createChatI18n } from './cards/card-test-fixtures';
import ChatQueue from './chat-queue.vue';

const item = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: 'q1',
  text: 'Next question',
  attachments: [],
  queuedAt: 0,
  ...overrides,
});

const mountQueue = (props: { items: QueuedMessage[]; canSendNow?: boolean }) =>
  mount(ChatQueue, { props: { canSendNow: false, ...props }, global: { plugins: [createChatI18n()] } });

describe('ChatQueue', () => {
  it('renders nothing for an empty queue', () => {
    expect(mountQueue({ items: [] }).find('[data-testid="chat-queue"]').exists()).toBe(false);
  });

  it('shows every queued message, with its attachment count', () => {
    const wrapper = mountQueue({
      items: [
        item(),
        item({ id: 'q2', text: 'With file', attachments: [{ id: 'a', fileName: 'a.pdf', sizeBytes: 1 }] }),
      ],
    });

    const rows = wrapper.findAll('[data-testid="queue-item"]');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.text()).toContain('With file');
    expect(rows[1]!.text()).toContain('1');
  });

  it('names the files of a message that has no text', () => {
    const wrapper = mountQueue({
      items: [item({ text: '', attachments: [{ id: 'a', fileName: 'a.pdf', sizeBytes: 1 }] })],
    });

    expect(wrapper.find('[data-testid="queue-item"]').text()).toContain('a.pdf');
  });

  it('emits edit, remove and send-now', async () => {
    const wrapper = mountQueue({ items: [item()], canSendNow: true });

    await wrapper.find('[data-testid="queue-edit"]').trigger('click');
    await wrapper.find('[data-testid="queue-remove"]').trigger('click');
    await wrapper.find('[data-testid="queue-send-now"]').trigger('click');

    expect(wrapper.emitted('edit')).toEqual([['q1']]);
    expect(wrapper.emitted('remove')).toEqual([['q1']]);
    expect(wrapper.emitted('send-now')).toHaveLength(1);
  });

  it('offers "Send queued" only when nothing is running', () => {
    expect(
      mountQueue({ items: [item()], canSendNow: false })
        .find('[data-testid="queue-send-now"]')
        .exists(),
    ).toBe(false);
  });
});
