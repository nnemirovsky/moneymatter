<script setup lang="ts">
import SelectField from '@/components/fields/select-field.vue';
import { useAiSettings } from '@/composable/data-queries/ai-settings';
import { useAiConnectionsList } from '@/composable/data-queries/use-ai-connections';
import { AI_FEATURE } from '@bt/shared/types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import {
  type ChatConnectionOption,
  buildChatConnectionOptions,
  findSelectedChatConnectionOption,
} from './chat-connection-options';

const props = withDefaults(
  defineProps<{
    /** The connection the conversation runs on; null is the included model. */
    connectionId: string | null;
    disabled?: boolean;
  }>(),
  { disabled: false },
);

const emit = defineEmits<{ select: [connectionId: string | null] }>();

const { t } = useI18n();
const { connections } = useAiConnectionsList();
const { getFeatureStatus } = useAiSettings();

const options = computed(() =>
  buildChatConnectionOptions({
    connections: connections.value,
    hasIncludedModel: Boolean(getFeatureStatus(AI_FEATURE.chat)?.serverModelName),
  }),
);
const selected = computed(() =>
  findSelectedChatConnectionOption({ options: options.value, connectionId: props.connectionId }),
);

const formatOption = (option: ChatConnectionOption) => {
  if (option.kind === 'included') return t('chat.connection.included');

  const params = { name: option.name, model: option.model };
  return option.needsAttention
    ? t('chat.connection.optionNeedsAttention', params)
    : t('chat.connection.option', params);
};

const onSelect = (option: ChatConnectionOption | null) => {
  if (option && option.connectionId !== props.connectionId) emit('select', option.connectionId);
};
</script>

<template>
  <div
    v-if="options.length > 0"
    class="min-w-0"
    role="group"
    :aria-label="$t('chat.connection.label')"
    data-testid="chat-connection-picker"
  >
    <SelectField
      class="w-full max-w-72"
      :model-value="selected"
      :values="options"
      :label-key="formatOption"
      value-key="value"
      :placeholder="$t('chat.connection.placeholder')"
      :disabled="disabled"
      @update:model-value="onSelect"
    />
  </div>
</template>
