<script setup lang="ts">
import PillChip from './pill-chip.vue';

defineProps<{
  /** The ISO code (or custom code) of an account's currency. */
  code: string;
}>();
</script>

<template>
  <PillChip data-testid="currency-chip">{{ code }}</PillChip>
</template>
