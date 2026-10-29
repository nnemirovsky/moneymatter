<script setup lang="ts">
import AppIcon from './app-icon.vue';

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
  <!-- A source reads "<icon> Mail: Sender", in plain text; one that is the app itself is "<icon> App". -->
  <span class="inline-flex min-w-0 items-center gap-1.5" data-testid="source-label">
    <AppIcon :app-name="appName" :bundle-id="bundleId" :icon-url="iconUrl" :size="16" />
    <span class="min-w-0 wrap-anywhere">
      <span data-testid="source-label-app">{{ appName || bundleId || fallback }}</span>
      <template v-if="sender">
        <span aria-hidden="true">: </span>
        <span data-testid="source-label-sender">{{ sender }}</span>
      </template>
    </span>
  </span>
</template>
