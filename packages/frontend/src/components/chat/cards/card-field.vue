<script setup lang="ts">
import AccountLogo from '@/components/common/account-logo.vue';
import BrandLogo from '@/components/common/brand-logo.vue';
import CategoryCircle from '@/components/common/category-circle.vue';
import CurrencyChip from '@/components/common/currency-chip.vue';
import { toEntityLogoDisplayProps } from '@/components/common/logo-selection';
import { Button } from '@/components/lib/ui/button';
import { cn } from '@/lib/utils';
import type { ChatCardDependency, ChatCardField, ChatUncertaintyReason } from '@bt/shared/types';
import { TriangleAlertIcon } from '@lucide/vue';
import type { CardRowTone } from './card-diff';
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
  /** `changed` marks a field the card changes; it is highlighted. */
  tone?: CardRowTone;
}>();

const emit = defineEmits<{ choose: [value: unknown] }>();
const tone = computed(() => props.tone ?? 'normal');

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
// An old value that was empty has nothing to strike through: the highlight says the field is new.
const hadOldValue = computed(() => {
  const { before } = props.field;
  if (before === undefined) return false;
  if (before === null && props.field.path === 'retentionDays') return true;
  return !(before === null || before === '' || (Array.isArray(before) && before.length === 0));
});
const beforeText = computed(() =>
  !hadOldValue.value
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
    :data-tone="tone"
    :class="
      cn(
        'flex flex-col gap-1 rounded-md px-2 py-1.5',
        tone === 'changed' && 'bg-primary/10',
        field.uncertain && 'bg-warning/10 ring-warning/30 ring-1',
      )
    "
  >
    <div class="flex items-baseline justify-between gap-3">
      <dt class="text-muted-foreground shrink-0 text-xs">{{ label }}</dt>
      <dd class="min-w-0 text-right text-sm wrap-anywhere" data-testid="field-value">
        <template v-for="(part, index) in valueParts" :key="index">
          <template v-if="index > 0">, </template>
          <span class="inline-flex max-w-full items-center justify-end gap-1.5 align-middle">
            <BrandLogo
              v-if="part.entity?.kind === 'payee' && lookups.payee({ id: part.entity.id })"
              v-bind="toEntityLogoDisplayProps(lookups.payee({ id: part.entity.id })!)"
              :name="part.text"
              class="size-5 shrink-0"
              data-testid="field-logo"
            />
            <AccountLogo
              v-else-if="part.entity?.kind === 'account' && lookups.account({ id: part.entity.id })"
              :account="lookups.account({ id: part.entity.id })!"
              class="size-5 shrink-0"
              data-testid="field-logo"
            />
            <CategoryCircle
              v-else-if="part.entity?.kind === 'category'"
              :category-id="part.entity.id"
              data-testid="field-logo"
            />
            <RouterLink v-if="part.to" :to="part.to" class="text-primary-text min-w-0 truncate hover:underline">{{
              part.text
            }}</RouterLink>
            <span v-else class="min-w-0 truncate">{{ part.text }}</span>
            <CurrencyChip v-if="part.note" :code="part.note" data-testid="field-note" />
          </span>
        </template>
      </dd>
    </div>

    <i18n-t
      v-if="beforeText !== null"
      keypath="chat.cards.fieldBefore"
      tag="p"
      class="text-muted-foreground text-right text-xs wrap-anywhere"
      data-testid="field-before"
    >
      <template #value
        ><s>{{ beforeText }}</s></template
      >
    </i18n-t>

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
