import { useArchiveChatThread, useClearResolvedChatThread } from '@/composable/data-queries/chat';
import type { ChatProposalCard, ChatThread } from '@bt/shared/types';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { createChatI18n } from './cards/card-test-fixtures';
import ChatInboxActions from './chat-inbox-actions.vue';

vi.mock('@/composable/data-queries/chat', () => ({
  useClearResolvedChatThread: vi.fn(),
  useArchiveChatThread: vi.fn(),
}));
const addSuccessNotification = vi.fn();
vi.mock('@/components/notification-center', () => ({
  NotificationType: { error: 'error' },
  useNotificationCenter: () => ({ addSuccessNotification, addErrorNotification: vi.fn(), addNotification: vi.fn() }),
}));

const clearMutateAsync = vi.fn();
const archiveMutateAsync = vi.fn();
const clearPending = ref(false);

const inboxThread = (overrides: Partial<ChatThread> = {}) =>
  ({ id: 'inbox-1', kind: 'automationInbox', inboxState: 'live', pinned: true, ...overrides }) as ChatThread;

const card = ({ id, status }: { id: string; status: ChatProposalCard['status'] }) =>
  [id, { id, status } as ChatProposalCard] as const;

const mountActions = ({
  thread = inboxThread(),
  cards = {},
}: { thread?: ChatThread; cards?: Record<string, ChatProposalCard> } = {}) =>
  mount(ChatInboxActions, { props: { thread, cards }, global: { plugins: [createChatI18n()] } });

describe('ChatInboxActions', () => {
  beforeEach(() => {
    clearMutateAsync.mockReset().mockResolvedValue({ deletedMessages: 3 });
    archiveMutateAsync.mockReset().mockResolvedValue(inboxThread({ inboxState: 'closed' }));
    addSuccessNotification.mockReset();
    clearPending.value = false;
    vi.mocked(useClearResolvedChatThread).mockReturnValue({
      mutateAsync: clearMutateAsync,
      isPending: clearPending,
    } as unknown as ReturnType<typeof useClearResolvedChatThread>);
    vi.mocked(useArchiveChatThread).mockReturnValue({
      mutateAsync: archiveMutateAsync,
      isPending: ref(false),
    } as unknown as ReturnType<typeof useArchiveChatThread>);
  });

  it('clears the resolved items and says how many went', async () => {
    const wrapper = mountActions();

    await wrapper.find('[data-testid="inbox-clear-resolved"]').trigger('click');
    await flushPromises();

    expect(clearMutateAsync).toHaveBeenCalledWith({ threadId: 'inbox-1' });
    expect(addSuccessNotification).toHaveBeenCalledWith('Cleared 3 resolved items');
  });

  it('archives an inbox with nothing waiting', async () => {
    const wrapper = mountActions({ cards: Object.fromEntries([card({ id: 'a', status: 'applied' })]) });

    await wrapper.find('[data-testid="inbox-archive"]').trigger('click');
    await flushPromises();

    expect(archiveMutateAsync).toHaveBeenCalledWith({ threadId: 'inbox-1' });
    expect(addSuccessNotification).toHaveBeenCalledWith('Inbox archived');
  });

  it.each(['pending', 'stale', 'failed'] as const)(
    'blocks Archive, with the reason, while a %s card waits',
    (status) => {
      const wrapper = mountActions({ cards: Object.fromEntries([card({ id: 'a', status })]) });

      expect(wrapper.find('[data-testid="inbox-archive"]').attributes('disabled')).toBeDefined();
      expect(wrapper.find('[data-testid="inbox-note"]').text()).toBe('Resolve the 1 waiting item to archive.');
    },
  );

  it('counts the waiting items in the reason', () => {
    const wrapper = mountActions({
      cards: Object.fromEntries([card({ id: 'a', status: 'pending' }), card({ id: 'b', status: 'pending' })]),
    });

    expect(wrapper.find('[data-testid="inbox-note"]').text()).toBe('Resolve the 2 waiting items to archive.');
  });

  it('keeps Clear resolved available while cards wait', () => {
    const wrapper = mountActions({ cards: Object.fromEntries([card({ id: 'a', status: 'pending' })]) });

    expect(wrapper.find('[data-testid="inbox-clear-resolved"]').attributes('disabled')).toBeUndefined();
  });

  it('has nothing to archive on a closed inbox and says so', () => {
    const wrapper = mountActions({ thread: inboxThread({ inboxState: 'closed', pinned: false }) });

    expect(wrapper.find('[data-testid="inbox-archive"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="inbox-note"]').text()).toBe(
      'This inbox is closed. The next item starts a new one.',
    );
  });

  it('does not clear twice while a clear is running', () => {
    clearPending.value = true;

    expect(mountActions().find('[data-testid="inbox-clear-resolved"]').attributes('disabled')).toBeDefined();
  });

  it('keeps quiet when the server refuses (the mutation reports it)', async () => {
    archiveMutateAsync.mockRejectedValue(new Error('409'));
    const wrapper = mountActions();

    await wrapper.find('[data-testid="inbox-archive"]').trigger('click');
    await flushPromises();

    expect(addSuccessNotification).not.toHaveBeenCalled();
  });
});
