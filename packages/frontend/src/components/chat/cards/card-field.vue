<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import { cn } from '@/lib/utils';
import type { ChatCardDependency, ChatCardField, ChatUncertaintyReason } from '@bt/shared/types';
import { TriangleAlertIcon } from '@lucide/vue';
import { computed } from 'vue';

import { useChatText } from '../chat-text';
import type { CardLookups } from './use-card-lookups';
import { useCardFieldText } from './use-card-field-text';

const props = defineProps<{
  field: ChatCardField;
  lookups: CardLookups;
  /** The currency of a money field; `null` when the card does not say. */
  currencyCode: string | null;
  /** The cards this one depends on, to name a `$proposal:` ref. */
  dependsOn: ChatCardDependency[];
  /** The alternatives are not offered while the card cannot be changed. */
  disabled?: boolean;
}>();

const emit = defineEmits<{ choose: [value: unknown] }>();

const { keyText } = useChatText();
const { valueParts: partsOfValue } = useCardFieldText();

const partsOf = ({ value, current = false }: { value: unknown; current?: boolean }) =>
  partsOfValue({
    field: props.field,
    value,
    current,
    lookups: props.lookups,
    currencyCode: props.currencyCode,
    dependsOn: props.dependsOn,
  });

const label = computed(() => keyText({ key: props.field.labelKey }) ?? props.field.path);
const valueParts = computed(() => partsOf({ value: props.field.value, current: true }));
const beforeText = computed(() =>
  props.field.before === undefined
    ? null
    : partsOf({ value: props.field.before })
        .map((part) => part.text)
        .join(', '),
);

const uncertainReason = computed<ChatUncertaintyReason | null>(() => props.field.uncertain?.reason ?? null);
const reasonText = computed(() =>
  uncertainReason.value
    ? (keyText({
        key: `chat.cards.uncertainty.${uncertainReason.value}`,
        fallbackKey: 'chat.cards.uncertainty.other',
      }) ?? '')
    : '',
);
const alternatives = computed(() =>
  (props.field.uncertain?.alternatives ?? []).map((value) => ({
    value,
    text: partsOf({ value })
      .map((part) => part.text)
      .join(', '),
  })),
);
</script>

<template>
  <div
    :data-testid="field.uncertain ? 'uncertain' : undefined"
    :class="cn('flex flex-col gap-1 rounded-md px-2 py-1.5', field.uncertain && 'bg-warning/10 ring-warning/30 ring-1')"
  >
    <div class="flex items-baseline justify-between gap-3">
      <dt class="text-muted-foreground shrink-0 text-xs">{{ label }}</dt>
      <dd class="min-w-0 text-right text-sm wrap-anywhere" data-testid="field-value">
        <template v-for="(part, index) in valueParts" :key="index">
          <template v-if="index > 0">, </template>
          <RouterLink v-if="part.to" :to="part.to" class="text-primary-text hover:underline">{{
            part.text
          }}</RouterLink>
          <template v-else>{{ part.text }}</template>
        </template>
      </dd>
    </div>

    <p
      v-if="beforeText !== null"
      class="text-muted-foreground text-right text-xs wrap-anywhere"
      data-testid="field-before"
    >
      {{ $t('chat.cards.fieldBefore', { value: beforeText }) }}
    </p>

    <template v-if="field.uncertain">
      <p class="text-warning-text flex items-center justify-end gap-1.5 text-xs">
        <TriangleAlertIcon class="size-3.5 shrink-0" aria-hidden="true" />
        {{ reasonText }}
      </p>
      <div v-if="alternatives.length > 0" class="flex flex-wrap items-center justify-end gap-1.5">
        <span class="text-muted-foreground text-xs">{{ $t('chat.cards.uncertain.alternatives') }}</span>
        <Button
          v-for="(alternative, index) in alternatives"
          :key="index"
          type="button"
          variant="outline"
          size="sm"
          data-testid="alternative"
          :disabled="disabled"
          @click="emit('choose', alternative.value)"
        >
          {{ alternative.text }}
        </Button>
      </div>
    </template>
  </div>
</template>
