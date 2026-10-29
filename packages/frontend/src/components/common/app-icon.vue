<script setup lang="ts">
import { cn } from '@/lib/utils';
import { getBuiltInAppGlyph } from '@bt/shared/types';
import { MessageCircleIcon, WalletIcon } from '@lucide/vue';
import { computed, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    appName: string | null;
    bundleId?: string | null;
    /** The icon the server resolved from the App Store; null when it found none. */
    iconUrl?: string | null;
    /** The edge of the square icon, in px. */
    size?: number;
  }>(),
  { bundleId: null, iconUrl: null, size: 16 },
);

// The letter is drawn by CSS from `data-letter`, so it is not part of the text a screen reader or a copy picks up.
// An icon that fails to load (offline, removed artwork) falls back to the glyph rather than a broken image.
const isBroken = ref(false);
watch(
  () => props.iconUrl,
  () => {
    isBroken.value = false;
  },
);

const glyph = computed(() => getBuiltInAppGlyph({ bundleId: props.bundleId, appName: props.appName }));
const monogram = computed(() => (props.appName ?? props.bundleId ?? '?').trim().charAt(0).toUpperCase() || '?');
const style = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
</script>

<template>
  <img
    v-if="iconUrl && !isBroken"
    :src="iconUrl"
    :style="style"
    alt=""
    loading="lazy"
    referrerpolicy="no-referrer"
    class="shrink-0 rounded-[22%] object-cover"
    data-testid="app-icon-image"
    @error="isBroken = true"
  />
  <span
    v-else
    :style="style"
    :class="
      cn(
        'bg-muted text-muted-foreground inline-flex shrink-0 items-center justify-center rounded-[22%] text-[9px] leading-none font-bold before:content-[attr(data-letter)]',
      )
    "
    :data-glyph="glyph ?? 'monogram'"
    :data-letter="glyph ? '' : monogram"
    data-testid="app-icon-fallback"
    aria-hidden="true"
  >
    <MessageCircleIcon v-if="glyph === 'messages'" :size="Math.round(size * 0.7)" />
    <WalletIcon v-else-if="glyph === 'wallet'" :size="Math.round(size * 0.7)" />
  </span>
</template>
