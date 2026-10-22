<script setup lang="ts">
import { DesktopOnlyTooltip } from '@/components/lib/ui/tooltip';
import { getTransactionTimeTooltip } from '@/js/helpers/time-zone';
import { computed } from 'vue';

const props = defineProps<{
  time: string | number | Date;
  timeZone?: string | null;
  utcOffsetMinutes?: number | null;
}>();

const lines = computed(() =>
  getTransactionTimeTooltip({ time: props.time, timeZone: props.timeZone, utcOffsetMinutes: props.utcOffsetMinutes }),
);
</script>

<template>
  <DesktopOnlyTooltip>
    <slot />
    <template #content>
      <div>{{ lines.primary }}</div>
      <div v-if="lines.recordedLine" class="text-muted-foreground">
        {{ $t('common.transactions.record.recordedIn', { zone: lines.recordedLine }) }}
      </div>
    </template>
  </DesktopOnlyTooltip>
</template>
