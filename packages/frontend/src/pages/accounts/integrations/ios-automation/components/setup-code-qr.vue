<template>
  <!-- Scanners need dark modules on a light ground whatever the theme, so the colors are fixed on purpose. -->
  <svg
    v-if="qr"
    :viewBox="`0 0 ${qr.viewBoxSize} ${qr.viewBoxSize}`"
    role="img"
    :aria-label="label"
    shape-rendering="crispEdges"
    class="size-full"
    data-testid="setup-code-qr"
  >
    <rect :width="qr.viewBoxSize" :height="qr.viewBoxSize" fill="white" />
    <path :d="qr.path" fill="black" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { buildQrCode } from '../qr-code';

const props = defineProps<{ text: string; label: string }>();

/** `null` when the text cannot be encoded, so the dialog still offers the copy button. */
const qr = computed(() => {
  try {
    return buildQrCode({ text: props.text });
  } catch {
    return null;
  }
});
</script>
