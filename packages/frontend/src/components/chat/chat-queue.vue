<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import type { QueuedMessage } from '@/composable/chat/use-chat-queue';
import { PaperclipIcon, PencilIcon, SendIcon, XIcon } from '@lucide/vue';

defineProps<{
  items: QueuedMessage[];
  /** The assistant is idle, so nothing will send the queue by itself: offer to. */
  canSendNow: boolean;
}>();

const emit = defineEmits<{ edit: [id: string]; remove: [id: string]; 'send-now': [] }>();
</script>

<template>
  <section
    v-if="items.length > 0"
    class="flex flex-col gap-1.5 border-t px-3 pt-3 pb-1"
    data-testid="chat-queue"
    :aria-label="$t('chat.queue.title')"
  >
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {{ $t('chat.queue.title') }}
      </h3>
      <Button
        v-if="canSendNow"
        type="button"
        variant="outline"
        size="sm"
        data-testid="queue-send-now"
        @click="emit('send-now')"
      >
        <SendIcon class="size-3.5" aria-hidden="true" />
        {{ $t('chat.queue.sendQueued') }}
      </Button>
    </div>
    <ul class="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
      <li
        v-for="item in items"
        :key="item.id"
        class="bg-muted/50 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm"
        data-testid="queue-item"
      >
        <span class="min-w-0 flex-1 truncate">{{
          item.text || item.attachments.map((a) => a.fileName).join(', ')
        }}</span>
        <span
          v-if="item.attachments.length > 0 && item.text"
          class="text-muted-foreground flex shrink-0 items-center gap-0.5 text-xs"
        >
          <PaperclipIcon class="size-3" aria-hidden="true" />
          {{ item.attachments.length }}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          class="size-7 shrink-0"
          data-testid="queue-edit"
          :aria-label="$t('chat.queue.edit')"
          @click="emit('edit', item.id)"
        >
          <PencilIcon class="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          class="size-7 shrink-0"
          data-testid="queue-remove"
          :aria-label="$t('chat.queue.remove')"
          @click="emit('remove', item.id)"
        >
          <XIcon class="size-3.5" aria-hidden="true" />
        </Button>
      </li>
    </ul>
  </section>
</template>
