<script setup lang="ts">
import AppIcon from './app-icon.vue';
import PillChip from './pill-chip.vue';

defineProps<{
  appName: string | null;
  bundleId?: string | null;
  sender?: string | null;
  iconUrl?: string | null;
  /** Shown when the source has neither an app name nor a bundle id. */
  fallback?: string;
}>();
</script>

<template>
  <!-- A source reads "<Sender> [<icon> App]": the sender first, then the app in the pill. One that is the app
       itself, with no sender, is the icon and the name without a pill. -->
  <span class="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5" data-testid="source-label">
    <template v-if="sender">
      <span class="break-words" data-testid="source-label-sender">{{ sender }}</span>
      <PillChip data-testid="source-label-app">
        <AppIcon :app-name="appName" :bundle-id="bundleId" :icon-url="iconUrl" :size="12" />
        <span class="break-words">{{ appName || bundleId || fallback }}</span>
      </PillChip>
    </template>
    <template v-else>
      <AppIcon :app-name="appName" :bundle-id="bundleId" :icon-url="iconUrl" :size="16" />
      <span class="break-words" data-testid="source-label-app">{{ appName || bundleId || fallback }}</span>
    </template>
  </span>
</template>
