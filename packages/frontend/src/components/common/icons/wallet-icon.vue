<template>
  <svg viewBox="0 0 100 100" fill="none" aria-hidden="true" :class="cn('size-9', $attrs.class as string)">
    <rect width="100" height="100" rx="22" fill="#1c1c1e" />
    <rect x="0.5" y="0.5" width="99" height="99" rx="21.5" stroke="#ffffff" stroke-opacity="0.14" />
    <rect x="14" y="13" width="72" height="30" rx="7" fill="#2fb7a4" />
    <rect x="14" y="24" width="72" height="30" rx="7" fill="#f6b73c" />
    <rect x="14" y="35" width="72" height="30" rx="7" fill="#ec5b4f" />
    <rect x="14" y="46" width="72" height="30" rx="7" fill="#3b82f6" />
    <path d="M10 66a8 8 0 0 1 8-8h64a8 8 0 0 1 8 8v12a12 12 0 0 1-12 12H22A12 12 0 0 1 10 78V62Z" fill="#3a3a3e" />
    <path d="M10 66h80" stroke="#ffffff" stroke-opacity="0.16" stroke-width="1.5" />
  </svg>
</template>

<script setup lang="ts">
import { cn } from '@/lib/utils';
</script>
