<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import { useNotificationCenter } from '@/components/notification-center';
import { ScrollArea } from '@/components/lib/ui/scroll-area';
import { type QueuedMessage, hasExpiredAttachments, useChatQueue } from '@/composable/chat/use-chat-queue';
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
import {
  AI_FEATURE,
  type AiEffort,
  type ChatClarificationAnswerInput,
  type ChatCreateThreadRequest,
  type ChatMessage as ChatMessageModel,
  type ChatPageContext,
  type ChatSendMessageRequest,
  type ChatSendMessageResponse,
} from '@bt/shared/types';
import { InboxIcon, Loader2Icon, RotateCwIcon } from '@lucide/vue';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import ApproveAllBar, { type ApproveAllGroup } from './cards/approve-all-bar.vue';
import ChatComposer from './chat-composer.vue';
import ChatConnectionPicker from './chat-connection-picker.vue';
import { isSameChatContext, toThreadContext } from './chat-context';
import ChatContextChip from './chat-context-chip.vue';
import { useChatContextLabel } from './chat-context-label';
import ChatEmptyState from './chat-empty-state.vue';
import { isInboxThread } from './chat-inbox';
import ChatMessage from './chat-message.vue';
import ChatQueue from './chat-queue.vue';

const props = defineProps<{
  /** The thread to show; `null` is a conversation that has not started. */
  threadId: string | null;
  /**
   * The page the user is on. A conversation that has not started takes it as its context; one that has keeps
   * its own and only offers this one as a switch. Null on the Chat page, whose new conversations start without.
   */
  context: ChatPageContext | null;
}>();

const emit = defineEmits<{ 'thread-created': [threadId: string] }>();

/** How close to the end of the conversation counts as "following it". */
const NEAR_BOTTOM_PX = 80;
const SKELETON_COUNT = 3;

// The thread is created on the first message (or the first attachment), so the conversation can hold an
// id the page has not heard of yet; the page catches up through `thread-created`.
const { t } = useI18n();
const activeThreadId = ref(props.threadId);
// A pick belongs to the thread it was made for, so another thread starts without one.
const pickedConnectionId = ref<string | null | undefined>(undefined);
// The model picked within the connection; null is the connection's own model.
const pickedModelId = ref<string | null | undefined>(undefined);
// The reasoning effort picked for the model; null is the provider's default.
const pickedEffort = ref<AiEffort | null | undefined>(undefined);
watch(
  () => props.threadId,
  (id) => {
    if (id !== activeThreadId.value) {
      pickedConnectionId.value = undefined;
      pickedModelId.value = undefined;
      pickedEffort.value = undefined;
    }
    activeThreadId.value = id;
  },
);

const { thread, messages, cards, hasMore, isLoading, isError, isLoadingOlder, loadOlder, refetch } = useChatThread({
  threadId: activeThreadId,
});
const chatRun = useChatRun({ threadId: activeThreadId });
const queue = useChatQueue({ threadId: activeThreadId });
// The side panel and the chat page both show this component, so one call covers both.
useChatPresence({ threadId: activeThreadId });
const createThread = useCreateChatThread();
const updateThread = useUpdateChatThread();
const { getFeatureStatus } = useAiSettings();

// The automation inbox is MoneyMatter's own thread: the assistant never runs in it, so it has no
// composer and no model to pick. The presence heartbeat above still covers it.
const isInbox = computed(() => isInboxThread({ thread: thread.value }));

const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null);
const scrollAreaRef = ref<InstanceType<typeof ScrollArea> | null>(null);
const isSending = ref(false);

const { label: contextLabel } = useChatContextLabel();

// A conversation that has not started follows the page it is on; removing the chip drops that page until
// another one comes along. Once it has started, its context is the stored one, whatever page it is opened on.
const dismissedPage = ref<ChatPageContext | null>(null);
const createdWithContext = ref<ChatPageContext | null>(null);
const currentPage = computed(() => (props.context ? toThreadContext({ context: props.context }) : null));
const threadContext = computed<ChatPageContext | null>(() => {
  if (activeThreadId.value === null) {
    const isDismissed =
      dismissedPage.value !== null && isSameChatContext({ a: dismissedPage.value, b: currentPage.value });
    return isDismissed ? null : currentPage.value;
  }
  // Until the stored thread has loaded, the conversation shows the context it was created with.
  return thread.value ? thread.value.pageContext : createdWithContext.value;
});
const threadContextLabel = computed(() =>
  threadContext.value ? contextLabel({ context: threadContext.value, names: thread.value?.pageContextNames }) : null,
);
const canUseCurrentPage = computed(() => {
  if (activeThreadId.value === null || !thread.value || !currentPage.value) return false;
  if (contextLabel({ context: currentPage.value }) === null) return false;
  return !isSameChatContext({ a: currentPage.value, b: thread.value.pageContext });
});

const onRemoveContext = async () => {
  if (activeThreadId.value === null) {
    dismissedPage.value = currentPage.value;
    return;
  }
  await updateThread.mutateAsync({ threadId: activeThreadId.value, payload: { pageContext: null } }).catch(() => {
    // The mutation reports the failure; the chip stays.
  });
};

const onUseCurrentPage = async () => {
  if (activeThreadId.value === null || !currentPage.value) return;
  await updateThread
    .mutateAsync({ threadId: activeThreadId.value, payload: { pageContext: currentPage.value } })
    .catch(() => {
      // The mutation reports the failure; the thread keeps its page.
    });
};

/** A feature whose status is not known yet is treated as configured: a slow answer must not flash "connect a model". */
const isConfigured = computed(() => {
  const status = getFeatureStatus(AI_FEATURE.chat);
  return status ? status.servedBy !== null : true;
});

const run = chatRun.run;

const liveAssistantMessage = ({ id }: { id: string }): ChatMessageModel => ({
  id,
  threadId: activeThreadId.value ?? '',
  role: 'assistant',
  status: 'streaming',
  parts: [],
  plainText: null,
  pageContext: null,
  runId: null,
  provider: null,
  modelId: null,
  promptVersion: null,
  usage: null,
  stepCount: 0,
  error: null,
  createdAt: new Date().toISOString(),
});

/** What the live run has produced stands in for the stored message of the same id, which fills in when the run ends. */
const displayMessages = computed<ChatMessageModel[]>(() => {
  const live = run.value;
  if (!live) return messages.value;

  const withRun = (message: ChatMessageModel): ChatMessageModel => ({
    ...message,
    status: live.status,
    parts: live.parts,
    error: live.error ?? message.error,
  });
  const stored = messages.value.some((message) => message.id === live.messageId);
  return stored
    ? messages.value.map((message) => (message.id === live.messageId ? withRun(message) : message))
    : [...messages.value, withRun(liveAssistantMessage({ id: live.messageId }))];
});

const displayCards = computed(() => ({ ...cards.value, ...run.value?.cards }));

// The inbox shows one message per card, so its approve-all covers every message of the thread.
const inboxApproveGroups = computed<ApproveAllGroup[]>(() =>
  displayMessages.value.flatMap((message) => {
    if (message.role !== 'assistant') return [];
    const found = message.parts.flatMap((part) => {
      const card = part.type === 'proposal' ? displayCards.value[part.proposalId] : undefined;
      return card ? [card] : [];
    });
    return found.length > 0 ? [{ messageId: message.id, cards: found }] : [];
  }),
);

const isBusy = computed(
  () =>
    chatRun.isStreaming.value ||
    isSending.value ||
    messages.value.some((message) => message.role === 'assistant' && message.status === 'streaming'),
);

// The connection the next message runs on. Before the thread exists the user's pick (or, without one,
// the default the server would choose) is shown and sent with the create call; the picked value stays
// until the stored thread has loaded. A pick on an existing thread is shown until the server confirms it.
const { data: defaultConnection } = useChatDefaultConnection({
  enabled: computed(() => activeThreadId.value === null),
});
const shownConnectionId = computed<string | null>(() => {
  if (pickedConnectionId.value !== undefined) return pickedConnectionId.value;
  if (thread.value) return thread.value.connectionId;
  return activeThreadId.value === null ? (defaultConnection.value?.connectionId ?? null) : null;
});
const shownModelId = computed<string | null>(() => {
  if (pickedModelId.value !== undefined) return pickedModelId.value;
  if (thread.value) return thread.value.modelId;
  return activeThreadId.value === null ? (defaultConnection.value?.modelId ?? null) : null;
});
const shownEffort = computed<AiEffort | null>(() => {
  if (pickedEffort.value !== undefined) return pickedEffort.value;
  if (thread.value) return thread.value.effort ?? null;
  if (activeThreadId.value !== null) return null;
  // A new conversation inherits the latest thread's effort along with its connection and model; another
  // connection or model starts on the provider's default.
  const choseAnother = pickedConnectionId.value !== undefined || pickedModelId.value !== undefined;
  return choseAnother ? null : (defaultConnection.value?.effort ?? null);
});
// The stored thread is the source of truth once it has loaded.
watch(thread, (loaded) => {
  if (loaded && !updateThread.isPending.value) {
    pickedConnectionId.value = undefined;
    pickedModelId.value = undefined;
    pickedEffort.value = undefined;
  }
});

const onPickConnection = async ({ connectionId }: { connectionId: string | null }) => {
  const previous = { connectionId: pickedConnectionId.value, modelId: pickedModelId.value, effort: pickedEffort.value };
  pickedConnectionId.value = connectionId;
  // A model belongs to its connection: the new one starts on its own model.
  pickedModelId.value = null;
  // The effort belongs to the model it was picked for; a stored thread keeps what its new model accepts, which
  // the server decides.
  pickedEffort.value = undefined;
  if (!activeThreadId.value) return;

  try {
    await updateThread.mutateAsync({ threadId: activeThreadId.value, payload: { connectionId } });
  } catch {
    // The mutation reports the failure; the picker goes back to the stored connection and model.
    pickedConnectionId.value = previous.connectionId;
    pickedModelId.value = previous.modelId;
    pickedEffort.value = previous.effort;
    return;
  }
  pickedConnectionId.value = undefined;
  pickedModelId.value = undefined;
  pickedEffort.value = undefined;
};

const onPickModel = async ({ modelId }: { modelId: string | null }) => {
  const previous = { modelId: pickedModelId.value, effort: pickedEffort.value };
  pickedModelId.value = modelId;
  pickedEffort.value = undefined;
  if (!activeThreadId.value) return;

  try {
    await updateThread.mutateAsync({ threadId: activeThreadId.value, payload: { modelId } });
  } catch {
    pickedModelId.value = previous.modelId;
    pickedEffort.value = previous.effort;
    return;
  }
  pickedModelId.value = undefined;
  pickedEffort.value = undefined;
};

const onPickEffort = async ({ effort }: { effort: AiEffort | null }) => {
  const previous = pickedEffort.value;
  pickedEffort.value = effort;
  if (!activeThreadId.value) return;

  try {
    await updateThread.mutateAsync({ threadId: activeThreadId.value, payload: { effort } });
  } catch {
    pickedEffort.value = previous;
    return;
  }
  pickedEffort.value = undefined;
};

/**
 * What the first message creates the thread with. A model rides on the connection it was picked for, so a
 * model picked on the connection shown by default names that connection too. Choosing the connection default
 * is sent as an explicit null: left out, the new thread would inherit the model of the latest one.
 */
const buildCreateRequest = (): ChatCreateThreadRequest => {
  const modelId = pickedModelId.value;
  const connectionId =
    pickedConnectionId.value !== undefined
      ? pickedConnectionId.value
      : typeof modelId === 'string'
        ? shownConnectionId.value
        : undefined;

  const effort = pickedEffort.value;

  return {
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(effort === undefined ? {} : { effort }),
    ...(threadContext.value && threadContextLabel.value !== null ? { pageContext: threadContext.value } : {}),
  };
};

const isLive = ({ message }: { message: ChatMessageModel }) =>
  run.value?.status === 'streaming' && run.value.messageId === message.id;

const hasContent = computed(() => displayMessages.value.length > 0);
const showSkeleton = computed(() => isLoading.value && !hasContent.value && activeThreadId.value !== null);
const showError = computed(() => isError.value && !hasContent.value);
const showEmpty = computed(() => !hasContent.value && !showSkeleton.value && !showError.value);

// A reload while an answer was streaming: follow the run that is still going.
const followedRunIds = new Set<string>();
// Another thread stops following this one's run, so coming back must follow it again.
watch(activeThreadId, () => followedRunIds.clear(), { flush: 'sync' });
watch(
  messages,
  (list) => {
    if (run.value) return;
    const pending = list.findLast((message) => message.role === 'assistant' && message.status === 'streaming');
    if (!pending?.runId || followedRunIds.has(pending.runId)) return;
    followedRunIds.add(pending.runId);
    void chatRun.attach({ runId: pending.runId, messageId: pending.id });
  },
  { immediate: true },
);

let creatingThread: Promise<string> | null = null;

const ensureThread = (): Promise<string> => {
  if (activeThreadId.value) return Promise.resolve(activeThreadId.value);

  // Two attachments dropped together must not create two threads.
  creatingThread ??= createThread
    .mutateAsync(buildCreateRequest())
    .then((created) => {
      createdWithContext.value = created.pageContext ?? null;
      activeThreadId.value = created.id;
      // The stored thread is still loading; until it has, the picker names the connection it was created on.
      pickedConnectionId.value = created.connectionId;
      pickedModelId.value = created.modelId;
      pickedEffort.value = created.effort;
      emit('thread-created', created.id);
      return created.id;
    })
    .finally(() => {
      creatingThread = null;
    });
  return creatingThread;
};

const sendPayload = async ({ payload }: { payload: ChatSendMessageRequest }): Promise<boolean> => {
  isSending.value = true;
  isPinnedToBottom.value = true;
  try {
    await ensureThread();
    // The run composable follows the thread id; let it see the new one before the first message.
    await nextTick();
    await chatRun.send({ payload });
    return true;
  } catch (error) {
    notifyMutationError({ error, fallbackKey: 'chat.errors.sendFailed' });
    return false;
  } finally {
    isSending.value = false;
  }
};

const toPayload = ({ text, attachmentIds }: { text: string; attachmentIds: string[] }): ChatSendMessageRequest => ({
  text,
  ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
});

// The server takes one run at a time, so a message written while the assistant works waits in the queue
// of its thread (its attachments are uploaded already) and goes out when the run ends.
const onSend = async ({
  text,
  attachmentIds,
  attachments,
}: {
  text: string;
  attachmentIds: string[];
  attachments: QueuedMessage['attachments'];
}) => {
  if (isBusy.value && activeThreadId.value) {
    queue.enqueue({ text, attachments });
    return;
  }
  const sent = await sendPayload({ payload: toPayload({ text, attachmentIds }) });
  // The box was cleared on send; a refused message goes back into it instead of being lost.
  if (!sent) composerRef.value?.restore({ text, attachments });
};

/** Sends the first queued message; a failed send puts it back at the front. */
const sendNextQueued = async () => {
  const ownerId = activeThreadId.value;
  const taken = queue.take();
  if (!taken || !ownerId) return;
  // Unsent uploads are deleted by the server after an hour, so an old message goes without them.
  const expired = hasExpiredAttachments({ message: taken });
  if (expired) useNotificationCenter().addErrorNotification(t('chat.queue.attachmentsExpired'));
  const next: QueuedMessage = expired ? { ...taken, attachments: [] } : taken;
  const sent = await sendPayload({
    payload: toPayload({ text: next.text, attachmentIds: next.attachments.map((item) => item.id) }),
  });
  if (!sent) queue.putBack({ message: next, threadId: ownerId });
};

// The queue carries on by itself only after a run that ended well. After a Stop or an error the user decides,
// and so after a reload, when no run has ended in this page yet: "Send queued" starts it again.
watch(
  () => chatRun.lastFinished.value,
  (finished) => {
    if (finished?.status !== 'complete' || finished.threadId !== activeThreadId.value) return;
    void sendNextQueued();
  },
);

const onEditQueued = ({ id }: { id: string }) => {
  const item = queue.items.value.find((candidate) => candidate.id === id);
  if (!item) return;
  queue.remove({ id });
  composerRef.value?.restore({ text: item.text, attachments: item.attachments });
};

const onAnswer = ({ answer }: { answer: ChatClarificationAnswerInput }) =>
  sendPayload({ payload: { text: '', clarificationAnswer: answer } });

/** A comment on a card starts a run like a message does: show it and follow it. */
const onCommented = async ({ response }: { response: ChatSendMessageResponse }) => {
  isPinnedToBottom.value = true;
  await refetch();
  void chatRun.attach({ runId: response.runId, messageId: response.messageId });
};

const fillComposer = ({ text }: { text: string }) => composerRef.value?.fill({ text });

// Stay with the end of the conversation while it grows, unless the user scrolled up to read.
const isPinnedToBottom = ref(true);
const viewportElement = () => scrollAreaRef.value?.viewportRef?.viewportElement as HTMLElement | undefined;

const onScroll = () => {
  const element = viewportElement();
  if (!element) return;
  isPinnedToBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
};

const scrollToBottom = async () => {
  await nextTick();
  const element = viewportElement();
  if (element) element.scrollTop = element.scrollHeight;
};

const contentSignature = computed(
  () =>
    displayMessages.value
      .map((message) => {
        const last = message.parts.at(-1);
        return `${message.id}:${message.parts.length}:${last && last.type === 'text' ? last.text.length : 0}`;
      })
      .join('|') + Object.keys(displayCards.value).length,
);

watch(contentSignature, () => {
  if (isPinnedToBottom.value) void scrollToBottom();
});
watch(activeThreadId, () => {
  isPinnedToBottom.value = true;
});
onMounted(scrollToBottom);
</script>

<template>
  <div class="@container/chat-conversation flex h-full min-h-0 flex-col">
    <ChatConnectionPicker
      v-if="!isInbox"
      :connection-id="shownConnectionId"
      :model-id="shownModelId"
      :effort="shownEffort"
      :disabled="isBusy || updateThread.isPending.value"
      @select="(connectionId) => onPickConnection({ connectionId })"
      @select-model="(modelId) => onPickModel({ modelId })"
      @select-effort="(effort) => onPickEffort({ effort })"
    >
      <template v-if="threadContextLabel || canUseCurrentPage" #default>
        <ChatContextChip
          :label="threadContextLabel"
          :can-use-current-page="canUseCurrentPage"
          @remove="onRemoveContext"
          @use-current-page="onUseCurrentPage"
        />
      </template>
    </ChatConnectionPicker>

    <ScrollArea ref="scrollAreaRef" class="min-h-0 flex-1" :scroll-y="onScroll">
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-5 px-3 py-4 @sm/chat-conversation:px-5">
        <div v-if="showSkeleton" class="flex flex-col gap-4" data-testid="conversation-skeleton">
          <div v-for="index in SKELETON_COUNT" :key="index" class="flex flex-col gap-2">
            <div class="bg-muted h-4 w-3/4 animate-pulse rounded" />
            <div class="bg-muted/60 h-4 w-1/2 animate-pulse rounded" />
          </div>
        </div>

        <div v-else-if="showError" class="flex flex-col items-center gap-3 py-10 text-center">
          <p class="text-muted-foreground text-sm">
            {{ $t('chat.conversation.loadError') }}
          </p>
          <Button variant="outline" data-testid="retry" @click="refetch()">
            <RotateCwIcon class="size-4" aria-hidden="true" />
            {{ $t('common.actions.retry') }}
          </Button>
        </div>

        <div
          v-else-if="showEmpty && isInbox"
          class="flex flex-col items-center gap-2 py-10 text-center"
          data-testid="inbox-empty"
        >
          <InboxIcon class="text-muted-foreground size-8" aria-hidden="true" />
          <p class="font-medium">{{ $t('chat.inbox.emptyTitle') }}</p>
          <p class="text-muted-foreground max-w-sm text-sm">
            {{ $t('chat.inbox.emptyDescription') }}
          </p>
        </div>

        <ChatEmptyState
          v-else-if="showEmpty"
          :is-configured="isConfigured"
          @prompt="(text) => fillComposer({ text })"
        />

        <template v-else>
          <!-- Pinned to the top: the newest card arrives at the bottom, and the button must stay in reach. -->
          <div v-if="isInbox" class="sticky top-0 z-10 -mx-1 px-1 empty:hidden">
            <ApproveAllBar :groups="inboxApproveGroups" compact />
          </div>
          <Button
            v-if="hasMore"
            variant="ghost"
            size="sm"
            class="self-center"
            data-testid="load-older"
            :disabled="isLoadingOlder"
            @click="loadOlder()"
          >
            <Loader2Icon v-if="isLoadingOlder" class="size-4 animate-spin" aria-hidden="true" />
            {{ $t('chat.conversation.loadOlder') }}
          </Button>

          <ChatMessage
            v-for="message in displayMessages"
            :key="message.id"
            :message="message"
            :cards="displayCards"
            :is-live="isLive({ message })"
            :can-answer="!isBusy"
            :inbox="isInbox"
            @answer="(answer) => onAnswer({ answer })"
            @commented="(response) => onCommented({ response })"
          />
        </template>
      </div>
    </ScrollArea>

    <div v-if="!isInbox" class="mx-auto w-full max-w-3xl shrink-0">
      <ChatQueue
        :items="queue.items.value"
        :can-send-now="!isBusy && isConfigured"
        @edit="(id) => onEditQueued({ id })"
        @remove="(id) => queue.remove({ id })"
        @send-now="sendNextQueued()"
      />
      <ChatComposer
        ref="composerRef"
        :is-streaming="chatRun.isStreaming.value"
        :disabled="!isConfigured"
        :ensure-thread="ensureThread"
        @send="onSend"
        @cancel="chatRun.cancel()"
      />
    </div>
  </div>
</template>
