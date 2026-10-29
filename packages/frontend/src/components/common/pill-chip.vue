<script setup lang="ts">
import { cn } from '@/lib/utils';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <!-- The small bordered pill the account select shows beside an account; also names the app of a source. -->
  <span
    v-bind="$attrs"
    :class="
      cn(
        'border-border text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-[5px] border px-1.5 py-px text-[10.5px] font-bold tracking-wider tabular-nums',
        $attrs.class as string | undefined,
      )
    "
  >
    <slot />
  </span>
</template>
