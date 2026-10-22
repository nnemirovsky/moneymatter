<script setup lang="ts">
import { useChatContextLabel } from '@/components/chat/chat-context-label';
import { isInboxThread } from '@/components/chat/chat-inbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/common/dropdown-menu';
import InputField from '@/components/fields/input-field.vue';
import { Button } from '@/components/lib/ui/button';
import { DesktopOnlyTooltip } from '@/components/lib/ui/tooltip';
import { useDateLocale } from '@/composable/use-date-locale';
import { cn } from '@/lib/utils';
import type { ChatThreadSearchHit } from '@bt/shared/types';
import { EllipsisIcon, InboxIcon, MapPinIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { formatBadgeCount } from '@/components/chat/chat-badge';

const props = defineProps<{
  thread: ChatThreadSearchHit;
  /** This is the thread the page shows. */
  active: boolean;
}>();

const emit = defineEmits<{
  select: [];
  rename: [title: string];
  'toggle-pin': [];
  delete: [];
}>();

const { t } = useI18n();
const { formatDistanceToNow } = useDateLocale();
const { label: contextLabel } = useChatContextLabel();

/** Where the conversation started, kept for the whole thread; absent when it has no page. */
const startedFrom = computed(() =>
  props.thread.pageContext
    ? contextLabel({ context: props.thread.pageContext, names: props.thread.pageContextNames })
    : null,
);

const isRenaming = ref(false);
const draft = ref('');

// MoneyMatter keeps the inbox pinned for good: no unpin, no delete.
const isInbox = computed(() => isInboxThread({ thread: props.thread }));
const lockedHint = computed(() => (isInbox.value ? t('chat.inbox.lockedHint') : null));
const pinLabel = computed(() =>
  props.thread.pinned ? t('chat.threads.actions.unpin') : t('chat.threads.actions.pin'),
);

const lastActivity = computed(() => formatDistanceToNow(new Date(props.thread.lastMessageAt), { addSuffix: true }));
const badgeText = computed(() => formatBadgeCount({ count: props.thread.badgeCount }));

const startRename = () => {
  draft.value = props.thread.title;
  isRenaming.value = true;
};

const finishRename = ({ save }: { save: boolean }) => {
  // Enter ends the edit and removes the field, which can blur it on the way out.
  if (!isRenaming.value) return;
  isRenaming.value = false;

  const title = draft.value.trim();
  if (save && title !== '' && title !== props.thread.title) emit('rename', title);
};
</script>

<template>
  <li
    :class="
      cn(
        'group/thread hover:bg-muted/60 relative flex items-center rounded-lg transition-colors',
        active && 'bg-primary/10 hover:bg-primary/10',
      )
    "
    data-testid="thread-item"
  >
    <div
      v-if="isRenaming"
      class="min-w-0 flex-1 p-1"
      @keydown.enter.prevent="finishRename({ save: true })"
      @keydown.esc.prevent="finishRename({ save: false })"
      @focusout="finishRename({ save: true })"
    >
      <InputField
        v-model="draft"
        autofocus
        :aria-label="$t('chat.threads.renameLabel')"
        :placeholder="$t('chat.threads.renamePlaceholder')"
      />
    </div>

    <template v-else>
      <button
        type="button"
        class="focus-visible:ring-ring flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-3 py-2 text-left outline-hidden focus-visible:ring-2"
        data-testid="thread-select"
        :aria-current="active ? 'true' : undefined"
        @click="emit('select')"
      >
        <!-- The title takes the whole row; the badge, when there is one, ends it 8px further on. -->
        <span class="flex min-w-0 items-center gap-2">
          <span class="flex min-w-0 flex-1 items-center gap-1.5">
            <InboxIcon v-if="isInbox" class="text-primary-text size-3.5 shrink-0" aria-hidden="true" />
            <PinIcon v-else-if="thread.pinned" class="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
            <span class="truncate text-sm font-medium" data-testid="thread-title">
              {{ thread.title || $t('chat.threads.untitled') }}
            </span>
          </span>
          <span
            v-if="badgeText"
            class="bg-primary text-primary-foreground inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] leading-none font-semibold tabular-nums"
            data-testid="thread-badge"
            :aria-label="$t('chat.threads.badge', { count: thread.badgeCount }, thread.badgeCount)"
          >
            {{ badgeText }}
          </span>
        </span>
        <span class="text-muted-foreground truncate text-xs">{{ thread.snippet || lastActivity }}</span>
        <span
          v-if="startedFrom"
          class="text-muted-foreground/80 flex min-w-0 items-center gap-1 text-xs"
          data-testid="thread-context"
        >
          <MapPinIcon class="size-3 shrink-0" aria-hidden="true" />
          <span class="truncate" :title="startedFrom">{{ startedFrom }}</span>
        </span>
      </button>

      <!-- With a mouse the actions float over the row's end on hover or focus, so they take no width from the title. -->
      <div
        class="bg-background pointer-events-none absolute top-1.5 right-1.5 flex items-center rounded-md border opacity-0 shadow-xs transition-opacity group-focus-within/thread:pointer-events-auto group-focus-within/thread:opacity-100 group-hover/thread:pointer-events-auto group-hover/thread:opacity-100 pointer-coarse:hidden"
        data-testid="thread-actions"
      >
        <DesktopOnlyTooltip :content="$t('chat.threads.actions.rename')">
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="thread-rename"
            :aria-label="$t('chat.threads.actions.rename')"
            @click="startRename"
          >
            <PencilIcon class="size-3.5" aria-hidden="true" />
          </Button>
        </DesktopOnlyTooltip>
        <!-- A disabled button swallows hover, so the reason hangs on a wrapper. -->
        <DesktopOnlyTooltip :content="lockedHint ?? pinLabel">
          <span class="inline-flex">
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="thread-pin"
              :disabled="isInbox"
              :aria-label="pinLabel"
              @click="emit('toggle-pin')"
            >
              <PinOffIcon v-if="thread.pinned" class="size-3.5" aria-hidden="true" />
              <PinIcon v-else class="size-3.5" aria-hidden="true" />
            </Button>
          </span>
        </DesktopOnlyTooltip>
        <DesktopOnlyTooltip :content="lockedHint ?? $t('chat.threads.actions.delete')">
          <span class="inline-flex">
            <Button
              variant="ghost-destructive"
              size="icon-sm"
              data-testid="thread-delete"
              :disabled="isInbox"
              :aria-label="$t('chat.threads.actions.delete')"
              @click="emit('delete')"
            >
              <Trash2Icon class="size-3.5" aria-hidden="true" />
            </Button>
          </span>
        </DesktopOnlyTooltip>
      </div>

      <!-- A touch screen has no hover: one button opens the same actions. -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="mr-1 hidden shrink-0 pointer-coarse:inline-flex"
            data-testid="thread-menu"
            :aria-label="$t('chat.threads.actions.more')"
          >
            <EllipsisIcon class="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <!-- Focus stays where the action moved it: the rename field, not the menu button. -->
        <DropdownMenuContent align="end" class="min-w-40" @close-auto-focus.prevent>
          <DropdownMenuItem @select="startRename">
            <PencilIcon class="size-4" aria-hidden="true" />
            {{ $t('chat.threads.actions.rename') }}
          </DropdownMenuItem>
          <DropdownMenuItem :disabled="isInbox" @select="emit('toggle-pin')">
            <PinOffIcon v-if="thread.pinned" class="size-4" aria-hidden="true" />
            <PinIcon v-else class="size-4" aria-hidden="true" />
            {{ pinLabel }}
          </DropdownMenuItem>
          <DropdownMenuItem :disabled="isInbox" class="text-destructive-text" @select="emit('delete')">
            <Trash2Icon class="size-4" aria-hidden="true" />
            {{ $t('chat.threads.actions.delete') }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </template>
  </li>
</template>
