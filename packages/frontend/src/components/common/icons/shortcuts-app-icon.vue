<template>
  <svg viewBox="0 0 100 100" fill="none" aria-hidden="true" :class="cn('size-9', $attrs.class as string)">
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
        <stop stop-color="#ff5f8f" />
        <stop offset="1" stop-color="#6f4cf0" />
      </linearGradient>
    </defs>
    <rect width="100" height="100" rx="22" :fill="`url(#${gradientId})`" />
    <rect x="24" y="22" width="40" height="40" rx="12" fill="#ffffff" fill-opacity="0.92" />
    <rect x="36" y="38" width="40" height="40" rx="12" fill="#ffffff" fill-opacity="0.55" />
  </svg>
</template>

<script setup lang="ts">
// Our own drawing that reads as a shortcuts app: two overlapping rounded squares on a warm gradient square.
import { cn } from '@/lib/utils';
import { useId } from 'vue';

const gradientId = `shortcuts-${useId()}`;
</script>
