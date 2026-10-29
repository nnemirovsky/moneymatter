<script setup lang="ts">
import NotificationSourceLabel from '@/components/common/notification-source-label.vue';
import AccountSelectField from '@/components/fields/account-select-field.vue';
import InputField from '@/components/fields/input-field.vue';
import type { ChatIngestRequestSummary, NotificationSourceDisplay } from '@bt/shared/types';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { formatVisualDate, formatVisualValue } from '../visuals/format-visual-value';
import { conversionMoney } from './card-summary';
import type { CardLookups } from './use-card-lookups';

const LABEL_ROOT = 'chat.cards.ingest';

const props = defineProps<{
  payment: ChatIngestRequestSummary;
  /** The source the payment came from, with its app icon; absent when the server did not attach it. */
  source?: NotificationSourceDisplay | null;
  lookups: CardLookups;
  /** The account the card will log the payment on, `null` until one is chosen. */
  accountId: string | null;
  /** For a currency exchange: the account of the other side's payment, `null` until one is chosen. */
  counterAccountId: string | null;
  /** The account cannot change: the card is closed, or a change is being saved. */
  /** The note the card holds; empty until the history or the owner fills it. */
  note: string;
  disabled: boolean;
}>();

const emit = defineEmits<{
  'update:accountId': [value: string | null];
  'update:counterAccountId': [value: string | null];
  /** The owner finished writing the note: store it on the card. */
  'commit:note': [value: string];
  /** Whether the text in the field differs from the note on the card, so Approve can wait for the save. */
  'update:noteDirty': [value: boolean];
}>();

const draftNote = ref(props.note);
watch(
  () => props.note,
  (note) => {
    draftNote.value = note;
  },
);

const isNoteDirty = computed(() => draftNote.value !== props.note);
watch(isNoteDirty, (isDirty) => emit('update:noteDirty', isDirty), { immediate: true });

const commitNote = () => {
  if (isNoteDirty.value) emit('commit:note', draftNote.value);
};

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

const selectedAccount = computed(
  () => props.lookups.accounts().find((account) => account.id === props.accountId) ?? null,
);
const selectedCounterAccount = computed(
  () => props.lookups.accounts().find((account) => account.id === props.counterAccountId) ?? null,
);

/** The card's own payment is the outgoing side of the exchange, so its account is where the money left. */
const ownIsOutgoing = computed(() => props.payment.direction !== 'credit');
const fromAccount = computed(() => (ownIsOutgoing.value ? selectedAccount.value : selectedCounterAccount.value));
const toAccount = computed(() => (ownIsOutgoing.value ? selectedCounterAccount.value : selectedAccount.value));

const chooseFrom = ({ id }: { id: string | null }) =>
  ownIsOutgoing.value ? emit('update:accountId', id) : emit('update:counterAccountId', id);
const chooseTo = ({ id }: { id: string | null }) =>
  ownIsOutgoing.value ? emit('update:counterAccountId', id) : emit('update:accountId', id);

const conversionAmountText = computed(() => {
  const { conversion } = props.payment;

  return conversion
    ? `${conversionMoney({ amount: conversion.fromAmount, currencyCode: conversion.fromCurrencyCode })} → ${conversionMoney({ amount: conversion.toAmount, currencyCode: conversion.toCurrencyCode })}`
    : null;
});

const conversionRateText = computed(() => {
  const { conversion } = props.payment;
  if (!conversion?.rate || !conversion.fromCurrencyCode || !conversion.toCurrencyCode) return null;

  return t(`${LABEL_ROOT}.conversionRate`, {
    from: conversion.fromCurrencyCode,
    rate: conversion.rate,
    to: conversion.toCurrencyCode,
  });
});

/** The other sources that told of this same payment, and the cards approving links to the account. */
const alsoSeenText = computed(() => {
  const others = props.payment.alsoSeenIn ?? [];
  if (!others.length) return null;

  const names = others
    .map((other) => [other.sourceName, other.cardName ?? (other.cardLastDigits ? `•${other.cardLastDigits}` : null)])
    .map((parts) => parts.filter(Boolean).join(' '))
    .filter(Boolean)
    .join(', ');

  return t(`${LABEL_ROOT}.alsoSeenIn`, { sources: names });
});

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
      <p class="text-xl font-semibold tabular-nums" data-testid="ingest-amount">
        {{ conversionAmountText ?? amountText ?? '—' }}
      </p>
      <span
        v-if="payment.conversion"
        class="border-border text-muted-foreground rounded-[5px] border px-1.5 py-px text-[10.5px] font-bold tracking-wider uppercase"
        data-testid="ingest-conversion"
      >
        {{ $t(`${LABEL_ROOT}.exchange`) }}
      </span>
      <span
        v-else-if="directionKey"
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
        <dd class="min-w-0 text-right break-words">
          {{ payment.counterparty ?? $t(`${LABEL_ROOT}.unknownCounterparty`) }}
        </dd>
      </div>
      <div v-if="conversionRateText" class="flex justify-between gap-3" data-testid="ingest-rate">
        <dt class="text-muted-foreground shrink-0">{{ $t(`${LABEL_ROOT}.rate`) }}</dt>
        <dd class="min-w-0 text-right">{{ conversionRateText }}</dd>
      </div>
      <div v-if="payment.sourceName" class="flex justify-between gap-3" data-testid="ingest-source">
        <dt class="text-muted-foreground shrink-0">{{ $t(`${LABEL_ROOT}.source`) }}</dt>
        <dd class="min-w-0 text-right break-words">
          <NotificationSourceLabel
            v-if="source"
            v-bind="source"
            class="justify-end"
            data-testid="ingest-source-label"
          />
          <template v-else>{{ payment.sourceName }}</template>
        </dd>
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

    <div data-testid="ingest-note-field" @keydown.enter.prevent="commitNote" @focusout="commitNote">
      <InputField
        v-model="draftNote"
        :label="$t(`${LABEL_ROOT}.noteLabel`)"
        :placeholder="payment.conversion?.suggestedNote ?? $t(`${LABEL_ROOT}.notePlaceholder`)"
        :disabled="disabled"
      />
    </div>

    <div v-if="payment.conversion" class="flex flex-col gap-3" data-testid="ingest-conversion-accounts">
      <AccountSelectField
        :model-value="fromAccount"
        :accounts="lookups.accounts()"
        :label="$t(`${LABEL_ROOT}.fromAccount`)"
        :placeholder="$t(`${LABEL_ROOT}.accountPlaceholder`)"
        :disabled="disabled"
        required
        @update:model-value="chooseFrom({ id: $event?.id ?? null })"
      />
      <AccountSelectField
        :model-value="toAccount"
        :accounts="lookups.accounts()"
        :label="$t(`${LABEL_ROOT}.toAccount`)"
        :placeholder="$t(`${LABEL_ROOT}.accountPlaceholder`)"
        :disabled="disabled"
        required
        @update:model-value="chooseTo({ id: $event?.id ?? null })"
      />
      <p class="text-muted-foreground text-xs" data-testid="ingest-conversion-hint">
        {{ $t(`${LABEL_ROOT}.conversionHint`) }}
      </p>
    </div>

    <div v-else class="flex flex-col gap-1.5" data-testid="ingest-account">
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
        {{
          $t(payment.reason === 'unknownAccount' ? `${LABEL_ROOT}.accountHint` : `${LABEL_ROOT}.accountOptionalHint`)
        }}
      </p>
      <template v-else-if="lessonText">
        <p v-if="alsoSeenText" class="text-muted-foreground text-xs" data-testid="ingest-also-seen">
          {{ alsoSeenText }}
        </p>
        <p class="text-muted-foreground text-xs" data-testid="ingest-lesson">{{ lessonText }}</p>
        <p v-if="payment.alsoWaiting > 0" class="text-muted-foreground text-xs" data-testid="ingest-siblings">
          {{
            $t(
              `${LABEL_ROOT}.siblings`,
              { count: payment.alsoWaiting, account: selectedAccount?.name ?? '' },
              payment.alsoWaiting,
            )
          }}
        </p>
      </template>
    </div>
  </div>
</template>
