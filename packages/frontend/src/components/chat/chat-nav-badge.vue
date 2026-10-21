<script setup lang="ts">
import { useChatBadgeTotal } from '@/composable/data-queries/chat';
import { cn } from '@/lib/utils';
import { computed } from 'vue';

import { formatBadgeCount } from './chat-badge';

/**
 * What waits across every chat, on the AI chat entry of the navigation: `inline` ends a labelled row,
 * `corner` sits on the top right of an icon-only one. Nothing shows at zero.
 */
withDefaults(defineProps<{ placement?: 'inline' | 'corner' }>(), { placement: 'inline' });

const total = useChatBadgeTotal();
const text = computed(() => formatBadgeCount({ count: total.value }));
</script>

<template>
  <span
    v-if="text"
    :class="
      cn(
        'bg-primary text-primary-foreground inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] leading-none font-semibold tabular-nums',
        placement === 'inline'
          ? 'ml-auto'
          : 'ring-background absolute -top-2 -right-2.5 h-4 min-w-4 px-1 text-[10px] ring-2',
      )
    "
    data-testid="chat-nav-badge"
    :aria-label="$t('navigation.chatBadge', { count: total }, total)"
  >
    {{ text }}
  </span>
</template>
