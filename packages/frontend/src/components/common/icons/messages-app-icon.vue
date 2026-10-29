<template>
  <svg viewBox="0 0 100 100" fill="none" aria-hidden="true" :class="cn('size-9', $attrs.class as string)">
    <rect width="100" height="100" rx="22" fill="#34c759" />
    <path
      d="M50 22c-17.7 0-32 11.6-32 26 0 8.2 4.6 15.5 11.8 20.3-.8 4.2-2.9 8.2-5.8 11.2 5.9-.3 11.6-2.6 15.6-5.9 3.2.9 6.7 1.4 10.4 1.4 17.7 0 32-11.6 32-26S67.7 22 50 22Z"
      fill="#ffffff"
    />
  </svg>
</template>

<script setup lang="ts">
// Our own drawing that reads as a messaging app: a white speech bubble on a green rounded square.
import { cn } from '@/lib/utils';
</script>
