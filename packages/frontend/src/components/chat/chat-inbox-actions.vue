<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import { useNotificationCenter } from '@/components/notification-center';
import { useArchiveChatThread, useClearResolvedChatThread } from '@/composable/data-queries/chat';
import type { ChatProposalCard, ChatThread } from '@bt/shared/types';
import { ArchiveIcon, BrushCleaningIcon, Loader2Icon } from '@lucide/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { countWaitingCards } from './chat-inbox';

const props = defineProps<{
  thread: ChatThread;
  /** The cards of the loaded part of the thread. */
  cards: Record<string, ChatProposalCard>;
}>();

const { t } = useI18n();
const { addSuccessNotification } = useNotificationCenter();
const clearResolved = useClearResolvedChatThread();
const archive = useArchiveChatThread();

const waitingCount = computed(() => countWaitingCards({ cards: props.cards }));
const isClosed = computed(() => props.thread.inboxState === 'closed');
// The server refuses too (409); the reason is on the page, since a tooltip never shows on a phone.
const archiveBlockedText = computed(() => {
  if (isClosed.value) return t('chat.inbox.archive.closed');
  if (waitingCount.value > 0)
    return t('chat.inbox.archive.cardsPending', { count: waitingCount.value }, waitingCount.value);
  return null;
});

const onClearResolved = async () => {
  try {
    const { deletedMessages } = await clearResolved.mutateAsync({ threadId: props.thread.id });
    addSuccessNotification(t('chat.inbox.clearResolved.done', { count: deletedMessages }, deletedMessages));
  } catch {
    // Reported by the mutation.
  }
};

const onArchive = async () => {
  try {
    await archive.mutateAsync({ threadId: props.thread.id });
    addSuccessNotification(t('chat.inbox.archive.done'));
  } catch {
    // Reported by the mutation.
  }
};
</script>

<template>
  <div
    class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-3 py-2"
    data-testid="inbox-actions"
  >
    <p class="text-muted-foreground min-w-0 flex-1 text-xs" data-testid="inbox-note">
      {{ archiveBlockedText ?? $t('chat.inbox.archive.hint') }}
    </p>

    <div class="flex shrink-0 items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        data-testid="inbox-clear-resolved"
        :disabled="clearResolved.isPending.value"
        @click="onClearResolved"
      >
        <Loader2Icon v-if="clearResolved.isPending.value" class="size-4 animate-spin" aria-hidden="true" />
        <BrushCleaningIcon v-else class="size-4" aria-hidden="true" />
        {{ $t('chat.inbox.clearResolved.label') }}
      </Button>

      <Button
        variant="outline"
        size="sm"
        data-testid="inbox-archive"
        :disabled="archiveBlockedText !== null || archive.isPending.value"
        @click="onArchive"
      >
        <Loader2Icon v-if="archive.isPending.value" class="size-4 animate-spin" aria-hidden="true" />
        <ArchiveIcon v-else class="size-4" aria-hidden="true" />
        {{ $t('chat.inbox.archive.label') }}
      </Button>
    </div>
  </div>
</template>
