<script setup lang="ts">
import { cn } from '@/lib/utils';

defineProps<{
  /** The ISO code (or custom code) of an account's currency. */
  code: string;
}>();
</script>

<template>
  <!-- The small bordered pill the account select shows beside an account. -->
  <span
    :class="
      cn(
        'border-border text-muted-foreground shrink-0 rounded-[5px] border px-1.5 py-px text-[10.5px] font-bold tracking-wider tabular-nums',
      )
    "
    data-testid="currency-chip"
  >
    {{ code }}
  </span>
</template>
