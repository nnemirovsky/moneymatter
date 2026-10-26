<script setup lang="ts">
import SelectField from '@/components/fields/select-field.vue';
import { type AIConnectionInfo, type AiEffort } from '@bt/shared/types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { type EffortOption, buildEffortOptions, findSelectedEffortOption } from './effort-options';

const props = withDefaults(
  defineProps<{
    connection: Pick<AIConnectionInfo, 'provider' | 'model'>;
    /** The model picked within the connection; null is the connection's own model. */
    modelId: string | null;
    /** The stored level; null is the provider's default. */
    effort: AiEffort | null;
    disabled?: boolean;
    label?: string;
  }>(),
  { disabled: false, label: undefined },
);

const emit = defineEmits<{ select: [effort: AiEffort | null] }>();

const { t } = useI18n();

const options = computed(() => buildEffortOptions({ connection: props.connection, modelId: props.modelId }));
const selected = computed(() => findSelectedEffortOption({ options: options.value, effort: props.effort }));

const formatOption = (option: EffortOption) =>
  option.kind === 'default' ? t('ai.effort.default') : t(`ai.effort.levels.${option.value}`);

const onSelect = (option: EffortOption | null) => {
  if (!option) return;
  const next = option.kind === 'default' ? null : option.value;
  if (next !== (selected.value?.kind === 'level' ? selected.value.value : null)) emit('select', next);
};
</script>

<template>
  <!-- A model without an effort setting has nothing to offer. -->
  <SelectField
    v-if="options.length > 0"
    :model-value="selected"
    :values="options"
    :label-key="formatOption"
    value-key="value"
    :label="label"
    :placeholder="$t('ai.effort.placeholder')"
    :disabled="disabled"
    data-testid="effort-select"
    @update:model-value="onSelect"
  >
    <template #trigger="{ label: triggerLabel }">
      <span class="block truncate" :title="`${$t('ai.effort.label')}: ${triggerLabel}`">{{ triggerLabel }}</span>
    </template>
  </SelectField>
</template>
