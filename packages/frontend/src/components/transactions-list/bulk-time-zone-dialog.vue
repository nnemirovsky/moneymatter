<script lang="ts" setup>
import ResponsiveDialog from '@/components/common/responsive-dialog.vue';
import TimeZoneSelectField from '@/components/fields/time-zone-select-field.vue';
import { Button } from '@/components/lib/ui/button';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

/** Emitted by the picker for the "Clear" entry; not an IANA name. */
const CLEAR_TIME_ZONE_VALUE = '__clear__';

const props = defineProps<{
  open: boolean;
  selectedCount: number;
  isLoading: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  /** A zone to record on every selected row, or `null` to clear it. */
  apply: [timeZone: string | null];
}>();

const { t } = useI18n();

const isOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

const choice = ref<string | null>(null);

watch(isOpen, (open) => {
  if (open) choice.value = null;
});

const specialOptions = computed(() => [{ value: CLEAR_TIME_ZONE_VALUE, label: t('transactions.bulkTimeZone.clear') }]);

const isApplyDisabled = computed(() => props.isLoading || props.selectedCount === 0 || choice.value === null);

const handleApply = () => {
  if (choice.value === null) return;
  emit('apply', choice.value === CLEAR_TIME_ZONE_VALUE ? null : choice.value);
};
</script>

<template>
  <ResponsiveDialog v-model:open="isOpen">
    <template #title>{{ t('transactions.bulkTimeZone.title', { count: selectedCount }) }}</template>
    <template #description>{{ t('transactions.bulkTimeZone.description') }}</template>

    <form class="mt-4 grid gap-4" @submit.prevent="handleApply">
      <TimeZoneSelectField
        v-model="choice"
        :special-options="specialOptions"
        :placeholder="t('transactions.bulkTimeZone.placeholder')"
      />

      <div class="mt-2 flex justify-end">
        <Button type="submit" :disabled="isApplyDisabled">
          {{ isLoading ? t('transactions.bulkEdit.applyingButton') : t('transactions.bulkEdit.applyButton') }}
        </Button>
      </div>
    </form>
  </ResponsiveDialog>
</template>
