<script setup lang="ts">
import AccountSelectField from '@/components/fields/account-select-field.vue';
import type { ChatIngestRequestSummary } from '@bt/shared/types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { formatVisualDate, formatVisualValue } from '../visuals/format-visual-value';
import type { CardLookups } from './use-card-lookups';

const LABEL_ROOT = 'chat.cards.ingest';

const props = defineProps<{
  payment: ChatIngestRequestSummary;
  lookups: CardLookups;
  /** The account the card will log the payment on, `null` until one is chosen. */
  accountId: string | null;
  /** The account cannot change: the card is closed, or a change is being saved. */
  disabled: boolean;
}>();

const emit = defineEmits<{ 'update:accountId': [value: string | null] }>();

const { t } = useI18n();

const amountText = computed(() =>
  props.payment.amount === null
    ? null
    : formatVisualValue({
        value: props.payment.amount,
        kind: props.payment.currencyCode ? 'money' : 'number',
        currencyCode: props.payment.currencyCode ?? undefined,
      }),
);

const directionKey = computed(() =>
  props.payment.direction === 'credit' ? 'income' : props.payment.direction === 'debit' ? 'expense' : null,
);

const cardText = computed(() => {
  const { cardName, cardLastDigits } = props.payment;
  if (cardName && cardLastDigits) return `${cardName} •${cardLastDigits}`;
  if (cardLastDigits) return `•${cardLastDigits}`;

  return cardName;
});

const timeText = computed(() => (props.payment.time ? formatVisualDate({ value: props.payment.time }) : null));

const selectedAccount = computed(() => props.lookups.accounts().find((account) => account.id === props.accountId) ?? null);

/** What approving on the chosen account teaches, said before the owner approves. */
const lessonText = computed(() => {
  const account = selectedAccount.value;
  const { willLearn, sourceName, cardName, cardLastDigits } = props.payment;
  if (!account || !willLearn) return null;

  if (willLearn === 'sourceDefault') {
    return t(`${LABEL_ROOT}.learnSource`, { source: sourceName ?? '', account: account.name });
  }

  return cardName
    ? t(`${LABEL_ROOT}.learnCardNamed`, { card: cardName, account: account.name })
    : t(`${LABEL_ROOT}.learnCard`, { source: sourceName ?? '', digits: cardLastDigits ?? '', account: account.name });
});
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="ingest-request-body">
    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p class="text-xl font-semibold tabular-nums" data-testid="ingest-amount">{{ amountText ?? '—' }}</p>
      <span
        v-if="directionKey"
        :class="[
          'rounded-[5px] border px-1.5 py-px text-[10.5px] font-bold tracking-wider uppercase',
          payment.direction === 'credit'
            ? 'border-success-text/30 text-success-text'
            : 'border-border text-muted-foreground',
        ]"
        data-testid="ingest-direction"
      >
        {{ $t(`${LABEL_ROOT}.${directionKey}`) }}
      </span>
    </div>

    <dl class="flex flex-col gap-1 text-sm">
      <div class="flex justify-between gap-3" data-testid="ingest-counterparty">
        <dt class="text-muted-foreground shrink-0">{{ $t(`${LABEL_ROOT}.payee`) }}</dt>
        <dd class="min-w-0 text-right break-words">{{ payment.counterparty ?? $t(`${LABEL_ROOT}.unknownCounterparty`) }}</dd>
      </div>
      <div v-if="payment.sourceName" class="flex justify-between gap-3" data-testid="ingest-source">
        <dt class="text-muted-foreground shrink-0">{{ $t(`${LABEL_ROOT}.source`) }}</dt>
        <dd class="min-w-0 text-right break-words">{{ payment.sourceName }}</dd>
      </div>
      <div v-if="timeText" class="flex justify-between gap-3" data-testid="ingest-time">
        <dt class="text-muted-foreground shrink-0">{{ $t(`${LABEL_ROOT}.time`) }}</dt>
        <dd class="min-w-0 text-right">{{ timeText }}</dd>
      </div>
      <div v-if="cardText" class="flex justify-between gap-3" data-testid="ingest-card">
        <dt class="text-muted-foreground shrink-0">{{ $t(`${LABEL_ROOT}.card`) }}</dt>
        <dd class="min-w-0 text-right break-words">{{ cardText }}</dd>
      </div>
    </dl>

    <p v-if="payment.summary" class="text-muted-foreground text-sm" data-testid="ingest-note">{{ payment.summary }}</p>

    <div class="flex flex-col gap-1.5" data-testid="ingest-account">
      <AccountSelectField
        :model-value="selectedAccount"
        :accounts="lookups.accounts()"
        :label="$t(`${LABEL_ROOT}.account`)"
        :placeholder="$t(`${LABEL_ROOT}.accountPlaceholder`)"
        :disabled="disabled"
        required
        @update:model-value="emit('update:accountId', $event?.id ?? null)"
      />
      <p v-if="!selectedAccount" class="text-muted-foreground text-xs" data-testid="ingest-account-hint">
        {{ $t(`${LABEL_ROOT}.accountHint`) }}
      </p>
      <p v-else-if="lessonText" class="text-muted-foreground text-xs" data-testid="ingest-lesson">{{ lessonText }}</p>
    </div>
  </div>
</template>
