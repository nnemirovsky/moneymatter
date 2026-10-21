<template>
  <Combobox.Combobox
    :model-value="modelValue ?? undefined"
    v-model:search-term="searchTerm"
    v-model:open="isOpen"
    :ignore-filter="true"
    :disabled="disabled"
    class="w-full"
    @update:model-value="onSelect"
  >
    <Combobox.ComboboxAnchor>
      <Combobox.ComboboxTrigger
        class="border-input bg-input-background ring-offset-background focus-visible:ring-ring flex h-10 w-full items-center justify-between gap-2 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span class="min-w-0 flex-1 truncate text-left" :class="{ 'text-muted-foreground': !selectedLabel }">
          {{ selectedLabel ?? placeholder }}
        </span>
        <ChevronDown class="text-muted-foreground size-4 shrink-0" />
      </Combobox.ComboboxTrigger>
    </Combobox.ComboboxAnchor>

    <Combobox.ComboboxList class="max-h-100 w-(--reka-combobox-trigger-width) lg:max-h-75">
      <div class="relative w-full items-center p-2 pb-0">
        <Combobox.ComboboxInput
          class="h-9 w-full rounded-md border pl-9 focus-visible:ring-0"
          :placeholder="$t('fields.timeZoneSelect.searchPlaceholder')"
        />
        <SearchIcon class="text-muted-foreground absolute top-[60%] left-4 size-5 -translate-y-1/2" />
      </div>
      <div class="max-h-85 overflow-y-auto p-1.25 lg:max-h-60">
        <Combobox.ComboboxGroup>
          <Combobox.ComboboxItem
            v-for="option in visibleOptions"
            :key="option.value"
            :value="option.value"
            class="hover:bg-accent hover:text-accent-foreground flex cursor-pointer items-center justify-between rounded-md px-2 py-1"
          >
            <span class="truncate">{{ option.label }}</span>
            <CheckIcon v-if="option.value === modelValue" />
          </Combobox.ComboboxItem>
        </Combobox.ComboboxGroup>
        <p v-if="!visibleOptions.length" class="text-muted-foreground py-2 text-center text-sm">
          {{ $t('fields.timeZoneSelect.noResults') }}
        </p>
      </div>
    </Combobox.ComboboxList>
  </Combobox.Combobox>
</template>

<script setup lang="ts">
import * as Combobox from '@/components/lib/ui/combobox';
import { CheckIcon, ChevronDown, SearchIcon } from '@lucide/vue';
import { computed, ref } from 'vue';

import { buildTimeZoneOptions, filterTimeZoneOptions } from './utils/time-zone-options';

interface SpecialOption {
  /** Emitted instead of a zone; must not look like an IANA name. */
  value: string;
  label: string;
}

const props = defineProps<{
  /** Selected zone, or the `value` of a special option. */
  modelValue: string | null;
  /** Entries pinned above the zones, such as "Automatic" or "Clear". */
  specialOptions?: SpecialOption[];
  placeholder?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const searchTerm = ref('');
const isOpen = ref(false);

const zoneOptions = buildTimeZoneOptions();

const specialAsOptions = computed(() =>
  (props.specialOptions ?? []).map((option) => ({ ...option, offsetMinutes: 0 })),
);

const visibleOptions = computed(() => [
  ...(searchTerm.value.trim()
    ? filterTimeZoneOptions({ options: specialAsOptions.value, searchTerm: searchTerm.value })
    : specialAsOptions.value),
  ...filterTimeZoneOptions({ options: zoneOptions, searchTerm: searchTerm.value }),
]);

const selectedLabel = computed(() => {
  if (!props.modelValue) return null;
  const all = [...specialAsOptions.value, ...zoneOptions];
  return all.find((option) => option.value === props.modelValue)?.label ?? props.modelValue;
});

const onSelect = (value: unknown) => {
  if (typeof value !== 'string') return;
  emit('update:modelValue', value);
  isOpen.value = false;
  searchTerm.value = '';
};
</script>
