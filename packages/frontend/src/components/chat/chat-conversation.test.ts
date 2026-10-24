import { createRunState } from '@/composable/chat/apply-run-event';
import { resetChatQueues } from '@/composable/chat/use-chat-queue';
import { useChatRun } from '@/composable/chat/use-chat-run';
import { useAiSettings } from '@/composable/data-queries/ai-settings';
import {
  useChatDefaultConnection,
  useChatThread,
  useCreateChatThread,
  useUpdateChatThread,
} from '@/composable/data-queries/chat';
import { notifyMutationError } from '@/composable/data-queries/use-invalidating-mutation';
import { useChatPresence } from '@/composable/use-chat-presence';
import type { ChatMessage, ChatPageContext, ChatProposalCard, ChatThread } from '@bt/shared/types';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, ref, shallowRef } from 'vue';

import { buildCard, createChatI18n } from './cards/card-test-fixtures';
import ChatConversation from './chat-conversation.vue';

vi.mock('@/composable/data-queries/chat', () => ({
  useChatDefaultConnection: vi.fn(),
  useChatThread: vi.fn(),
  useCreateChatThread: vi.fn(),
  useUpdateChatThread: vi.fn(),
}));
vi.mock('@/composable/chat/use-chat-run', () => ({ useChatRun: vi.fn() }));
vi.mock('./chat-context-label', () => ({
  useChatContextLabel: () => ({
    label: ({ context, names = {} }: { context: ChatPageContext; names?: Record<string, string> }) => {
      if (context.entity) return `Subscription: ${names[`${context.entity.kind}:${context.entity.id}`] ?? 'unnamed'}`;
      return context.route ? 'Transactions' : null;
    },
  }),
}));
vi.mock('@/composable/data-queries/ai-settings', () => ({ useAiSettings: vi.fn() }));
vi.mock('@/composable/data-queries/use-invalidating-mutation', () => ({ notifyMutationError: vi.fn() }));
vi.mock('@/components/notification-center', () => ({ useNotificationCenter: () => ({ addErrorNotification }) }));
vi.mock('@/composable/use-chat-presence', () => ({ useChatPresence: vi.fn() }));

const assistant = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm-a',
  threadId: 'thread-1',
  role: 'assistant',
  status: 'complete',
  parts: [{ type: 'text', id: 'p1', text: 'Hello' }],
  plainText: 'Hello',
  pageContext: null,
  runId: null,
  provider: null,
  modelId: null,
  promptVersion: null,
  usage: null,
  stepCount: 1,
  error: null,
  createdAt: '2026-03-05T10:00:00.000Z',
  ...overrides,
});

const user = (overrides: Partial<ChatMessage> = {}): ChatMessage =>
  assistant({ id: 'm-u', role: 'user', parts: [{ type: 'text', id: 'u1', text: 'Hi' }], ...overrides });

const MessageStub = defineComponent({
  props: ['message', 'cards', 'isLive', 'canAnswer', 'inbox'],
  emits: ['answer', 'commented'],
  setup:
    (props, { emit }) =>
    () =>
      h('div', {
        'data-testid': 'message',
        'data-id': props.message.id,
        'data-live': String(props.isLive),
        'data-status': props.message.status,
        'data-can-answer': String(props.canAnswer),
        'data-inbox': String(props.inbox),
        'data-parts': props.message.parts.length,
        'data-card-ids': Object.keys(props.cards).join(','),
        onClick: () => {
          emit('answer', { clarificationId: 'cl1', optionIds: ['o1'] });
          emit('commented', { runId: 'run-9', messageId: 'm-9', userMessageId: 'u-9' });
        },
      }),
});

const fill = vi.fn();
const restore = vi.fn();
const ComposerStub = defineComponent({
  props: ['isStreaming', 'disabled', 'ensureThread'],
  emits: ['send', 'cancel'],
  setup: (props, { emit, expose }) => {
    expose({ fill, restore });
    return () =>
      h('div', {
        'data-testid': 'composer',
        'data-streaming': String(props.isStreaming),
        'data-disabled': String(props.disabled),
        onClick: () =>
          emit('send', {
            text: 'Ask',
            attachmentIds: ['att-1'],
            attachments: [{ id: 'att-1', fileName: 'a.pdf', sizeBytes: 3 }],
          }),
        onDblclick: () => emit('cancel'),
      });
  },
});

const PickerStub = defineComponent({
  props: ['connectionId', 'modelId', 'disabled'],
  emits: ['select', 'select-model'],
  setup:
    (props, { emit, slots }) =>
    () =>
      h('div', [
        h('button', {
          'data-testid': 'picker',
          'data-connection': String(props.connectionId),
          'data-model': String(props.modelId),
          'data-disabled': String(props.disabled),
          onClick: () => emit('select', 'c-picked'),
          onDblclick: () => emit('select-model', 'm-picked'),
        }),
        slots.default?.(),
      ]),
});

const EmptyStub = defineComponent({
  props: ['isConfigured'],
  emits: ['prompt'],
  setup:
    (props, { emit }) =>
    () =>
      h('div', {
        'data-testid': 'empty',
        'data-configured': String(props.isConfigured),
        onClick: () => emit('prompt', 'Where?'),
      }),
});

const addErrorNotification = vi.fn();
const ApproveAllStub = defineComponent({
  props: ['groups'],
  setup: (props) => () =>
    h('div', {
      'data-testid': 'approve-all-bar',
      'data-groups': JSON.stringify(
        props.groups.map((group: { messageId: string; cards: ChatProposalCard[] }) => ({
          messageId: group.messageId,
          cards: group.cards.map((card) => card.id),
        })),
      ),
    }),
});

const send = vi.fn();
const attach = vi.fn();
const cancel = vi.fn();
const loadOlder = vi.fn();
const refetch = vi.fn();
const mutateAsync = vi.fn();
const updateMutateAsync = vi.fn();

const state = {
  messages: ref<ChatMessage[]>([]),
  cards: ref<Record<string, ChatProposalCard>>({}),
  hasMore: ref(false),
  isLoading: ref(false),
  isError: ref(false),
  run: shallowRef<ReturnType<typeof createRunState> | null>(null),
  lastFinished: shallowRef<{ threadId: string; runId: string; status: string } | null>(null),
  featureServedBy: ref<'connection' | 'server' | null>('connection'),
  featureKnown: ref(true),
  thread: ref<ChatThread | null>(null),
  defaultConnectionId: ref<string | null>('c-default'),
  defaultModelId: ref<string | null>(null),
  isUpdating: ref(false),
};

// The mocked state is shared, so a conversation left mounted would keep reacting to the next test's changes.
const mounted: Array<ReturnType<typeof mount>> = [];

const mountConversation = ({
  threadId = 'thread-1',
  context = null,
}: { threadId?: string | null; context?: ChatPageContext | null } = {}) => {
  const wrapper = mount(ChatConversation, {
    props: { threadId, context },
    global: {
      plugins: [createChatI18n()],
      stubs: {
        ChatMessage: MessageStub,
        ApproveAllBar: ApproveAllStub,
        ChatComposer: ComposerStub,
        ChatConnectionPicker: PickerStub,
        ChatEmptyState: EmptyStub,
        ScrollArea: { template: '<div><slot /></div>' },
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
};

describe('ChatConversation', () => {
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
  });

  beforeEach(() => {
    for (const mock of [
      send,
      attach,
      cancel,
      loadOlder,
      refetch,
      mutateAsync,
      updateMutateAsync,
      fill,
      restore,
      addErrorNotification,
      vi.mocked(notifyMutationError),
      vi.mocked(useChatPresence),
    ]) {
      mock.mockReset();
    }
    send.mockResolvedValue({ runId: 'run-1', messageId: 'm-1', userMessageId: 'u-1' });
    mutateAsync.mockResolvedValue({ id: 'new-thread' } as ChatThread);
    state.messages.value = [];
    state.cards.value = {};
    state.hasMore.value = false;
    state.isLoading.value = false;
    state.isError.value = false;
    state.run.value = null;
    state.lastFinished.value = null;
    localStorage.clear();
    resetChatQueues();
    state.featureServedBy.value = 'connection';
    state.featureKnown.value = true;
    state.thread.value = { id: 'thread-1', connectionId: 'c-thread', modelId: null } as ChatThread;
    state.defaultConnectionId.value = 'c-default';
    state.defaultModelId.value = null;
    state.isUpdating.value = false;
    updateMutateAsync.mockResolvedValue({});

    vi.mocked(useChatThread).mockImplementation(
      () =>
        ({
          thread: computed(() => state.thread.value),
          messages: computed(() => state.messages.value),
          cards: computed(() => state.cards.value),
          hasMore: computed(() => state.hasMore.value),
          isLoading: state.isLoading,
          isError: state.isError,
          error: ref(null),
          isLoadingOlder: ref(false),
          loadOlder,
          refetch,
        }) as unknown as ReturnType<typeof useChatThread>,
    );
    vi.mocked(useCreateChatThread).mockReturnValue({ mutateAsync } as unknown as ReturnType<
      typeof useCreateChatThread
    >);
    vi.mocked(useUpdateChatThread).mockReturnValue({
      mutateAsync: updateMutateAsync,
      isPending: state.isUpdating,
    } as unknown as ReturnType<typeof useUpdateChatThread>);
    vi.mocked(useChatDefaultConnection).mockReturnValue({
      data: computed(() => ({ connectionId: state.defaultConnectionId.value, modelId: state.defaultModelId.value })),
    } as unknown as ReturnType<typeof useChatDefaultConnection>);
    vi.mocked(useChatRun).mockReturnValue({
      run: state.run,
      isStreaming: computed(() => state.run.value?.status === 'streaming'),
      lastFinished: state.lastFinished,
      send,
      attach,
      cancel,
      stop: vi.fn(),
    } as unknown as ReturnType<typeof useChatRun>);
    vi.mocked(useAiSettings).mockReturnValue({
      getFeatureStatus: () => (state.featureKnown.value ? { servedBy: state.featureServedBy.value } : undefined),
    } as unknown as ReturnType<typeof useAiSettings>);
  });

  it('shows the messages of the thread', () => {
    state.messages.value = [user(), assistant()];

    const wrapper = mountConversation();

    expect(wrapper.findAll('[data-testid="message"]').map((item) => item.attributes('data-id'))).toEqual([
      'm-u',
      'm-a',
    ]);
    expect(wrapper.find('[data-testid="empty"]').exists()).toBe(false);
  });

  describe('automation inbox thread', () => {
    beforeEach(() => {
      state.thread.value = { id: 'thread-1', connectionId: null, modelId: null, kind: 'automationInbox' } as ChatThread;
    });

    it('has no composer and no model picker, since the assistant never runs there', () => {
      state.messages.value = [assistant()];

      const wrapper = mountConversation();

      expect(wrapper.find('[data-testid="composer"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="picker"]').exists()).toBe(false);
    });

    it('hands the cards of every message to one approve-all bar', () => {
      const withCard = ({ id, card }: { id: string; card: string }) =>
        assistant({ id, parts: [{ type: 'proposal', id: `p-${id}`, proposalId: card }] });
      state.messages.value = [
        assistant({ id: 'm0' }),
        withCard({ id: 'm1', card: 'c1' }),
        withCard({ id: 'm2', card: 'c2' }),
      ];
      state.cards.value = { c1: buildCard({ id: 'c1' }), c2: buildCard({ id: 'c2' }) };

      const wrapper = mountConversation();

      expect(wrapper.findAll('[data-testid="approve-all-bar"]')).toHaveLength(1);
      expect(JSON.parse(wrapper.find('[data-testid="approve-all-bar"]').attributes('data-groups')!)).toEqual([
        { messageId: 'm1', cards: ['c1'] },
        { messageId: 'm2', cards: ['c2'] },
      ]);
    });

    it('has no thread-wide approve-all outside the inbox', () => {
      state.thread.value = { id: 'thread-1', connectionId: null, modelId: null, kind: 'chat' } as ChatThread;
      state.messages.value = [assistant({ id: 'm1', parts: [{ type: 'proposal', id: 'p1', proposalId: 'c1' }] })];
      state.cards.value = { c1: buildCard({ id: 'c1' }) };

      expect(mountConversation().find('[data-testid="approve-all-bar"]').exists()).toBe(false);
    });

    it('tells the messages they sit in the inbox', () => {
      state.messages.value = [assistant()];

      expect(mountConversation().find('[data-testid="message"]').attributes('data-inbox')).toBe('true');
    });

    it('says nothing is waiting instead of offering the assistant prompts', () => {
      const wrapper = mountConversation();

      expect(wrapper.find('[data-testid="inbox-empty"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="empty"]').exists()).toBe(false);
    });

    it('still sends the presence heartbeat for the thread', () => {
      mountConversation();

      expect(useChatPresence).toHaveBeenCalledTimes(1);
    });

    it('keeps the composer on a chat thread', () => {
      state.thread.value = { id: 'thread-1', connectionId: null, modelId: null, kind: 'chat' } as ChatThread;
      state.messages.value = [assistant()];

      const wrapper = mountConversation();

      expect(wrapper.find('[data-testid="composer"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="message"]').attributes('data-inbox')).toBe('false');
    });
  });

  it('gives every message the cards of the thread', () => {
    state.messages.value = [assistant()];
    state.cards.value = { c1: { id: 'c1' } as ChatProposalCard };

    const wrapper = mountConversation();

    expect(wrapper.find('[data-testid="message"]').attributes('data-card-ids')).toBe('c1');
  });

  it('shows the empty state for a conversation that has not started', () => {
    const wrapper = mountConversation({ threadId: null });

    expect(wrapper.find('[data-testid="empty"]').attributes('data-configured')).toBe('true');
  });

  it('tells a user without a model, and locks the composer', () => {
    state.featureServedBy.value = null;

    const wrapper = mountConversation({ threadId: null });

    expect(wrapper.find('[data-testid="empty"]').attributes('data-configured')).toBe('false');
    expect(wrapper.find('[data-testid="composer"]').attributes('data-disabled')).toBe('true');
  });

  it('does not lock the composer while the model setting is still unknown', () => {
    state.featureKnown.value = false;

    expect(mountConversation({ threadId: null }).find('[data-testid="composer"]').attributes('data-disabled')).toBe(
      'false',
    );
  });

  it('puts an example prompt in the composer instead of sending it', async () => {
    const wrapper = mountConversation({ threadId: null });

    await wrapper.find('[data-testid="empty"]').trigger('click');

    expect(fill).toHaveBeenCalledWith({ text: 'Where?' });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a message to the thread with its attachments', async () => {
    const wrapper = mountConversation();

    await wrapper.find('[data-testid="composer"]').trigger('click');
    await flushPromises();

    expect(send).toHaveBeenCalledWith({ payload: { text: 'Ask', attachmentIds: ['att-1'] } });
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('reports the thread on screen as present, and the new one once the first message has created it', async () => {
    const wrapper = mountConversation({ threadId: null });
    const { threadId } = vi.mocked(useChatPresence).mock.calls[0]![0];

    expect(threadId.value).toBeNull();

    await wrapper.find('[data-testid="composer"]').trigger('click');
    await flushPromises();

    expect(threadId.value).toBe('new-thread');

    await wrapper.setProps({ threadId: 'thread-2' });

    expect(threadId.value).toBe('thread-2');
  });

  it('creates the thread on the first message and tells the page about it', async () => {
    const wrapper = mountConversation({ threadId: null });

    await wrapper.find('[data-testid="composer"]').trigger('click');
    await flushPromises();

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('thread-created')).toEqual([['new-thread']]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  describe('page context of the thread', () => {
    const SUBSCRIPTION: ChatPageContext = {
      route: 'dashboard.planned.subscription-details',
      entity: { kind: 'subscription', id: 's1' },
    };
    const TRANSACTIONS: ChatPageContext = { route: 'dashboard.transactions' };

    const storedThread = (overrides: Partial<ChatThread> = {}) =>
      ({
        id: 'thread-1',
        connectionId: 'c-thread',
        modelId: null,
        pageContext: SUBSCRIPTION,
        pageContextNames: { 'subscription:s1': 'Spotify' },
        ...overrides,
      }) as ChatThread;

    it('shows the context the thread keeps, with the name the server read', () => {
      state.thread.value = storedThread();

      const wrapper = mountConversation({ threadId: 'thread-1', context: null });

      expect(wrapper.find('[data-testid="context-chip"]').text()).toContain('Subscription: Spotify');
      expect(wrapper.find('[data-testid="context-use-page"]').exists()).toBe(false);
    });

    it('shows a neutral name when the entity is gone', () => {
      state.thread.value = storedThread({ pageContextNames: {} });

      const wrapper = mountConversation({ threadId: 'thread-1' });

      expect(wrapper.find('[data-testid="context-chip"]').text()).toContain('Subscription: unnamed');
    });

    it('shows no chip for a thread without context, even on a page with one', () => {
      state.thread.value = storedThread({ pageContext: null });

      const wrapper = mountConversation({ threadId: 'thread-1', context: null });

      expect(wrapper.find('[data-testid="context-chip"]').exists()).toBe(false);
    });

    it('offers "Use this page" when the page differs, and does not switch by itself', async () => {
      state.thread.value = storedThread();

      const wrapper = mountConversation({ threadId: 'thread-1', context: TRANSACTIONS });

      expect(wrapper.find('[data-testid="context-chip"]').text()).toContain('Subscription: Spotify');
      expect(updateMutateAsync).not.toHaveBeenCalled();

      await wrapper.find('[data-testid="context-use-page"]').trigger('click');

      expect(updateMutateAsync).toHaveBeenCalledWith({ threadId: 'thread-1', payload: { pageContext: TRANSACTIONS } });
    });

    it("does not offer it when the page is the thread's own, whatever order the server keeps keys in", () => {
      state.thread.value = storedThread({ pageContext: { entity: SUBSCRIPTION.entity, route: SUBSCRIPTION.route } });

      const wrapper = mountConversation({ threadId: 'thread-1', context: SUBSCRIPTION });

      expect(wrapper.find('[data-testid="context-use-page"]').exists()).toBe(false);
    });

    it('offers the current page to a thread that has none', () => {
      state.thread.value = storedThread({ pageContext: null });

      const wrapper = mountConversation({ threadId: 'thread-1', context: TRANSACTIONS });

      expect(wrapper.find('[data-testid="context-chip"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="context-use-page"]').exists()).toBe(true);
    });

    it('ignores the drawer and the ticked rows of the page it takes', async () => {
      state.thread.value = storedThread({ pageContext: null });
      const wrapper = mountConversation({
        threadId: 'thread-1',
        context: {
          ...TRANSACTIONS,
          focus: { kind: 'transaction', id: 't1' },
          selection: { kind: 'transaction', ids: ['t1'] },
        },
      });

      await wrapper.find('[data-testid="context-use-page"]').trigger('click');

      expect(updateMutateAsync).toHaveBeenCalledWith({ threadId: 'thread-1', payload: { pageContext: TRANSACTIONS } });
    });

    it('removes the context from the thread', async () => {
      state.thread.value = storedThread();
      const wrapper = mountConversation({ threadId: 'thread-1' });

      await wrapper.find('[data-testid="context-remove"]').trigger('click');

      expect(updateMutateAsync).toHaveBeenCalledWith({ threadId: 'thread-1', payload: { pageContext: null } });
    });

    it('starts a new conversation on the page it is on, and creates the thread with it', async () => {
      const wrapper = mountConversation({ threadId: null, context: TRANSACTIONS });
      expect(wrapper.find('[data-testid="context-chip"]').text()).toContain('Transactions');

      await wrapper.find('[data-testid="composer"]').trigger('click');
      await flushPromises();

      expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ pageContext: TRANSACTIONS }));
    });

    it('starts a new conversation without context when there is no page, or when the chip was removed', async () => {
      const none = mountConversation({ threadId: null, context: null });
      await none.find('[data-testid="composer"]').trigger('click');
      await flushPromises();
      expect(mutateAsync.mock.calls[0]![0]).not.toHaveProperty('pageContext');

      mutateAsync.mockClear();
      const removed = mountConversation({ threadId: null, context: TRANSACTIONS });
      await removed.find('[data-testid="context-remove"]').trigger('click');
      expect(updateMutateAsync).not.toHaveBeenCalled();
      await removed.find('[data-testid="composer"]').trigger('click');
      await flushPromises();
      expect(mutateAsync.mock.calls[0]![0]).not.toHaveProperty('pageContext');
    });
  });

  it('reports a message that could not be sent', async () => {
    send.mockRejectedValue(new Error('boom'));
    const wrapper = mountConversation();

    await wrapper.find('[data-testid="composer"]').trigger('click');
    await flushPromises();

    expect(notifyMutationError).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackKey: 'chat.errors.sendFailed' }),
    );
  });

  it('sends the answer to a question as a message of its own', async () => {
    state.messages.value = [assistant()];
    const wrapper = mountConversation();

    await wrapper.find('[data-testid="message"]').trigger('click');
    await flushPromises();

    expect(send).toHaveBeenCalledWith({
      payload: { text: '', clarificationAnswer: { clarificationId: 'cl1', optionIds: ['o1'] } },
    });
  });

  it('follows the run a comment on a card started', async () => {
    state.messages.value = [assistant()];
    const wrapper = mountConversation();

    await wrapper.find('[data-testid="message"]').trigger('click');
    await flushPromises();

    expect(attach).toHaveBeenCalledWith({ runId: 'run-9', messageId: 'm-9' });
    expect(refetch).toHaveBeenCalled();
  });

  it('shows what a live run has produced in place of the stored message', () => {
    state.messages.value = [user(), assistant({ id: 'm-live', status: 'streaming', parts: [] })];
    state.run.value = {
      ...createRunState({ runId: 'run-1', messageId: 'm-live' }),
      parts: [{ type: 'text', id: 'p1', text: 'Partial' }],
    };

    const wrapper = mountConversation();
    const live = wrapper.findAll('[data-testid="message"]')[1]!;

    expect(live.attributes('data-live')).toBe('true');
    expect(live.attributes('data-parts')).toBe('1');
  });

  it('shows a live run whose message the thread does not hold yet', () => {
    state.messages.value = [user()];
    state.run.value = createRunState({ runId: 'run-1', messageId: 'm-live' });

    const wrapper = mountConversation();

    expect(wrapper.findAll('[data-testid="message"]').map((item) => item.attributes('data-id'))).toEqual([
      'm-u',
      'm-live',
    ]);
  });

  it('adds the cards of the live run to the cards of the thread', () => {
    state.messages.value = [assistant({ id: 'm-live', status: 'streaming', parts: [] })];
    state.cards.value = { c1: { id: 'c1' } as ChatProposalCard };
    state.run.value = {
      ...createRunState({ runId: 'run-1', messageId: 'm-live' }),
      cards: { c2: { id: 'c2' } as ChatProposalCard },
    };

    const wrapper = mountConversation();

    expect(wrapper.find('[data-testid="message"]').attributes('data-card-ids')).toBe('c1,c2');
  });

  it('follows the run of a message that is still streaming after a reload', async () => {
    state.messages.value = [user(), assistant({ id: 'm-live', status: 'streaming', runId: 'run-7', parts: [] })];

    mountConversation();
    await flushPromises();

    expect(attach).toHaveBeenCalledWith({ runId: 'run-7', messageId: 'm-live' });
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('does not follow a run that is already followed', async () => {
    state.messages.value = [assistant({ id: 'm-live', status: 'streaming', runId: 'run-7', parts: [] })];
    state.run.value = createRunState({ runId: 'run-7', messageId: 'm-live' });

    mountConversation();
    await flushPromises();

    expect(attach).not.toHaveBeenCalled();
  });

  it('shows the composer as busy while a run streams and stops the run on request', async () => {
    state.messages.value = [assistant({ id: 'm-live', status: 'streaming', parts: [] })];
    state.run.value = createRunState({ runId: 'run-1', messageId: 'm-live' });

    const wrapper = mountConversation();
    expect(wrapper.find('[data-testid="composer"]').attributes('data-streaming')).toBe('true');

    await wrapper.find('[data-testid="composer"]').trigger('dblclick');

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  describe('message queue', () => {
    const streaming = () => {
      state.messages.value = [assistant({ id: 'm-live', status: 'streaming', parts: [] })];
      state.run.value = createRunState({ runId: 'run-1', messageId: 'm-live' });
    };
    const finish = async ({ status }: { status: string }) => {
      state.run.value = null;
      state.messages.value = [assistant()];
      state.lastFinished.value = { threadId: 'thread-1', runId: 'run-1', status };
      await flushPromises();
    };
    const queued = (wrapper: ReturnType<typeof mountConversation>) =>
      wrapper.findAll('[data-testid="queue-item"]').map((item) => item.text());

    it('queues a message written during a run instead of sending it', async () => {
      streaming();
      const wrapper = mountConversation();

      await wrapper.find('[data-testid="composer"]').trigger('click');

      expect(send).not.toHaveBeenCalled();
      expect(queued(wrapper)).toEqual(['Ask 1']);
      expect(wrapper.find('[data-testid="queue-send-now"]').exists()).toBe(false);
    });

    it('sends the queued messages one after another as the runs complete', async () => {
      streaming();
      const wrapper = mountConversation();
      await wrapper.find('[data-testid="composer"]').trigger('click');
      await wrapper.find('[data-testid="composer"]').trigger('click');
      expect(queued(wrapper)).toHaveLength(2);

      await finish({ status: 'complete' });

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({ payload: { text: 'Ask', attachmentIds: ['att-1'] } });
      expect(queued(wrapper)).toHaveLength(1);

      streaming();
      await finish({ status: 'complete' });

      expect(send).toHaveBeenCalledTimes(2);
      expect(queued(wrapper)).toHaveLength(0);
    });

    it.each(['cancelled', 'failed', 'interrupted', 'stepLimit'])(
      'keeps the queue and offers "Send queued" when the run ends as %s',
      async (status) => {
        streaming();
        const wrapper = mountConversation();
        await wrapper.find('[data-testid="composer"]').trigger('click');

        await finish({ status });

        expect(send).not.toHaveBeenCalled();
        expect(queued(wrapper)).toHaveLength(1);

        await wrapper.find('[data-testid="queue-send-now"]').trigger('click');
        await flushPromises();

        expect(send).toHaveBeenCalledTimes(1);
        expect(queued(wrapper)).toHaveLength(0);
      },
    );

    it('keeps the message at the front when sending it fails', async () => {
      streaming();
      const wrapper = mountConversation();
      await wrapper.find('[data-testid="composer"]').trigger('click');
      send.mockRejectedValueOnce(new Error('offline'));

      await finish({ status: 'complete' });

      expect(notifyMutationError).toHaveBeenCalled();
      expect(queued(wrapper)).toEqual(['Ask 1']);
    });

    it('does not send the queue of another thread when its run ends', async () => {
      streaming();
      const wrapper = mountConversation();
      await wrapper.find('[data-testid="composer"]').trigger('click');

      state.run.value = null;
      state.lastFinished.value = { threadId: 'other-thread', runId: 'run-9', status: 'complete' };
      await flushPromises();

      expect(send).not.toHaveBeenCalled();
      expect(queued(wrapper)).toHaveLength(1);
    });

    it('shows a queue left by an earlier visit, idle, with "Send queued"', async () => {
      localStorage.setItem(
        'bt-chat-queue',
        JSON.stringify({ 'thread-1': [{ id: 'q1', text: 'From before', attachments: [], queuedAt: Date.now() }] }),
      );
      resetChatQueues();

      const wrapper = mountConversation();

      expect(queued(wrapper)).toEqual(['From before']);
      expect(wrapper.find('[data-testid="queue-send-now"]').exists()).toBe(true);
      expect(send).not.toHaveBeenCalled();
    });

    it('sends a message written while idle right away, ahead of a waiting queue', async () => {
      localStorage.setItem(
        'bt-chat-queue',
        JSON.stringify({ 'thread-1': [{ id: 'q1', text: 'From before', attachments: [], queuedAt: Date.now() }] }),
      );
      resetChatQueues();
      const wrapper = mountConversation();

      await wrapper.find('[data-testid="composer"]').trigger('click');

      expect(send).toHaveBeenCalledTimes(1);
      expect(queued(wrapper)).toEqual(['From before']);
    });

    it('puts a refused message back into the box when it was sent directly', async () => {
      send.mockRejectedValueOnce(new Error('offline'));
      const wrapper = mountConversation();

      await wrapper.find('[data-testid="composer"]').trigger('click');
      await flushPromises();

      expect(restore).toHaveBeenCalledWith({
        text: 'Ask',
        attachments: [{ id: 'att-1', fileName: 'a.pdf', sizeBytes: 3 }],
      });
    });

    it('sends an old queued message without its expired attachments, and says so', async () => {
      const old = Date.now() - 2 * 60 * 60 * 1000;
      localStorage.setItem(
        'bt-chat-queue',
        JSON.stringify({
          'thread-1': [
            { id: 'q1', text: 'Old', attachments: [{ id: 'att-9', fileName: 'a.pdf', sizeBytes: 1 }], queuedAt: old },
          ],
        }),
      );
      resetChatQueues();
      const wrapper = mountConversation();

      await wrapper.find('[data-testid="queue-send-now"]').trigger('click');
      await flushPromises();

      expect(send).toHaveBeenCalledWith({ payload: { text: 'Old' } });
      expect(addErrorNotification).toHaveBeenCalled();
    });

    it('follows a run again when the thread is opened again', async () => {
      state.messages.value = [assistant({ id: 'm-live', status: 'streaming', runId: 'run-7', parts: [] })];
      const wrapper = mountConversation();
      await flushPromises();
      expect(attach).toHaveBeenCalledTimes(1);

      await wrapper.setProps({ threadId: 'thread-2' });
      state.messages.value = [];
      await flushPromises();
      await wrapper.setProps({ threadId: 'thread-1' });
      state.messages.value = [assistant({ id: 'm-live', status: 'streaming', runId: 'run-7', parts: [] })];
      await flushPromises();

      expect(attach).toHaveBeenCalledTimes(2);
    });

    it('removes a queued message', async () => {
      streaming();
      const wrapper = mountConversation();
      await wrapper.find('[data-testid="composer"]').trigger('click');

      await wrapper.find('[data-testid="queue-remove"]').trigger('click');

      expect(queued(wrapper)).toEqual([]);
    });

    it('takes a queued message back into the composer to edit it', async () => {
      streaming();
      const wrapper = mountConversation();
      await wrapper.find('[data-testid="composer"]').trigger('click');

      await wrapper.find('[data-testid="queue-edit"]').trigger('click');

      expect(restore).toHaveBeenCalledWith({
        text: 'Ask',
        attachments: [{ id: 'att-1', fileName: 'a.pdf', sizeBytes: 3 }],
      });
      expect(queued(wrapper)).toEqual([]);
    });
  });

  it('locks the questions while a run streams', () => {
    state.messages.value = [assistant(), assistant({ id: 'm-live', status: 'streaming', parts: [] })];
    state.run.value = createRunState({ runId: 'run-1', messageId: 'm-live' });

    const wrapper = mountConversation();

    expect(wrapper.findAll('[data-testid="message"]')[0]!.attributes('data-can-answer')).toBe('false');
  });

  it('loads earlier messages on request', async () => {
    state.messages.value = [assistant()];
    state.hasMore.value = true;
    const wrapper = mountConversation();

    await wrapper.find('[data-testid="load-older"]').trigger('click');

    expect(loadOlder).toHaveBeenCalled();
  });

  it('offers a retry when the thread cannot be read', async () => {
    state.isError.value = true;
    const wrapper = mountConversation();

    expect(wrapper.text()).toContain('Could not load this conversation.');

    await wrapper.find('[data-testid="retry"]').trigger('click');

    expect(refetch).toHaveBeenCalled();
  });

  it('shows skeletons while the thread loads', () => {
    state.isLoading.value = true;

    expect(mountConversation().find('[data-testid="conversation-skeleton"]').exists()).toBe(true);
  });
  describe('connection picker', () => {
    it('sits at the top of the conversation, above the messages and the composer', () => {
      const html = mountConversation().html();

      expect(html.indexOf('data-testid="picker"')).toBeGreaterThan(-1);
      expect(html.indexOf('data-testid="picker"')).toBeLessThan(html.indexOf('data-testid="composer"'));
    });

    const picker = (wrapper: ReturnType<typeof mountConversation>) => wrapper.find('[data-testid="picker"]');

    it('shows the connection of the thread', () => {
      expect(picker(mountConversation()).attributes('data-connection')).toBe('c-thread');
    });

    it('shows the default the server would choose for a conversation that has not started', () => {
      state.thread.value = null;

      expect(picker(mountConversation({ threadId: null })).attributes('data-connection')).toBe('c-default');
    });

    it('switches the connection of the thread', async () => {
      const wrapper = mountConversation();

      await picker(wrapper).trigger('click');
      await flushPromises();

      expect(updateMutateAsync).toHaveBeenCalledWith({ threadId: 'thread-1', payload: { connectionId: 'c-picked' } });
    });

    it('creates the thread on the connection picked before the first message', async () => {
      state.thread.value = null;
      mutateAsync.mockResolvedValue({ id: 'new-thread', connectionId: 'c-picked' } as ChatThread);
      const wrapper = mountConversation({ threadId: null });

      await picker(wrapper).trigger('click');
      expect(picker(wrapper).attributes('data-connection')).toBe('c-picked');
      expect(updateMutateAsync).not.toHaveBeenCalled();

      await wrapper.find('[data-testid="composer"]').trigger('click');
      await flushPromises();

      expect(mutateAsync).toHaveBeenCalledWith({ connectionId: 'c-picked', modelId: null });
    });

    it('creates the thread without a connection when the user picked none', async () => {
      state.thread.value = null;
      const wrapper = mountConversation({ threadId: null });

      await wrapper.find('[data-testid="composer"]').trigger('click');
      await flushPromises();

      expect(mutateAsync).toHaveBeenCalledWith({});
    });

    describe('model within the connection', () => {
      it('shows the model of the thread, and the one a new conversation would inherit', () => {
        state.thread.value = { id: 'thread-1', connectionId: 'c-thread', modelId: 'm-thread' } as ChatThread;
        expect(picker(mountConversation()).attributes('data-model')).toBe('m-thread');

        state.thread.value = null;
        state.defaultModelId.value = 'm-inherited';
        expect(picker(mountConversation({ threadId: null })).attributes('data-model')).toBe('m-inherited');
      });

      it('picks a model for the thread without touching its connection', async () => {
        const wrapper = mountConversation();

        await picker(wrapper).trigger('dblclick');
        await flushPromises();

        expect(updateMutateAsync).toHaveBeenCalledWith({ threadId: 'thread-1', payload: { modelId: 'm-picked' } });
      });

      it('goes back to the connection default as soon as the connection changes', async () => {
        state.thread.value = { id: 'thread-1', connectionId: 'c-thread', modelId: 'm-thread' } as ChatThread;
        updateMutateAsync.mockReturnValue(new Promise(() => {}));
        const wrapper = mountConversation();

        await picker(wrapper).trigger('click');

        expect(picker(wrapper).attributes('data-model')).toBe('null');
      });

      it('goes back to the stored model when the pick is refused', async () => {
        state.thread.value = { id: 'thread-1', connectionId: 'c-thread', modelId: 'm-thread' } as ChatThread;
        updateMutateAsync.mockRejectedValue(new Error('not served'));
        const wrapper = mountConversation();

        await picker(wrapper).trigger('dblclick');
        await flushPromises();

        expect(picker(wrapper).attributes('data-model')).toBe('m-thread');
      });

      it('creates the thread on the model picked before the first message, on the connection shown', async () => {
        state.thread.value = null;
        mutateAsync.mockResolvedValue({
          id: 'new-thread',
          connectionId: 'c-default',
          modelId: 'm-picked',
        } as ChatThread);
        const wrapper = mountConversation({ threadId: null });

        await picker(wrapper).trigger('dblclick');
        expect(updateMutateAsync).not.toHaveBeenCalled();
        await wrapper.find('[data-testid="composer"]').trigger('click');
        await flushPromises();

        expect(mutateAsync).toHaveBeenCalledWith({ connectionId: 'c-default', modelId: 'm-picked' });
        expect(picker(wrapper).attributes('data-model')).toBe('m-picked');
      });

      it('sends the connection default outright, so the new thread does not inherit the latest model', async () => {
        state.thread.value = null;
        state.defaultModelId.value = 'm-inherited';
        mutateAsync.mockResolvedValue({ id: 'new-thread', connectionId: 'c-default', modelId: null } as ChatThread);
        const wrapper = mountConversation({ threadId: null });
        // The stub picks 'm-picked'; a second pick of the default is what the real select reports as null.
        await picker(wrapper).trigger('dblclick');
        await wrapper.findComponent(PickerStub).vm.$emit('select-model', null);
        await wrapper.find('[data-testid="composer"]').trigger('click');
        await flushPromises();

        expect(mutateAsync).toHaveBeenCalledWith({ modelId: null });
      });

      it('does not send the model of the connection that was switched away from', async () => {
        state.thread.value = null;
        mutateAsync.mockResolvedValue({ id: 'new-thread', connectionId: 'c-picked', modelId: null } as ChatThread);
        const wrapper = mountConversation({ threadId: null });

        await picker(wrapper).trigger('dblclick');
        await picker(wrapper).trigger('click');
        await wrapper.find('[data-testid="composer"]').trigger('click');
        await flushPromises();

        expect(mutateAsync).toHaveBeenCalledWith({ connectionId: 'c-picked', modelId: null });
      });
    });

    it('is disabled while an answer streams', () => {
      state.messages.value = [assistant({ id: 'm-live', status: 'streaming', parts: [] })];
      state.run.value = createRunState({ runId: 'run-1', messageId: 'm-live' });

      expect(picker(mountConversation()).attributes('data-disabled')).toBe('true');
    });

    it('goes back to the stored connection when the switch is refused', async () => {
      updateMutateAsync.mockRejectedValue(new Error('conflict'));
      const wrapper = mountConversation();

      await picker(wrapper).trigger('click');
      await flushPromises();

      expect(picker(wrapper).attributes('data-connection')).toBe('c-thread');
    });
  });
});
