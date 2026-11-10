<script setup lang="ts">
import NotificationSourceLabel from '@/components/common/notification-source-label.vue';
import AccountSelectField from '@/components/fields/account-select-field.vue';
import InputField from '@/components/fields/input-field.vue';
import { Button } from '@/components/lib/ui/button';
import type { ChatCardField, ChatIngestRequestSummary, NotificationSourceDisplay } from '@bt/shared/types';
import { ArrowUpDownIcon } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { formatVisualDate, formatVisualValue } from '../visuals/format-visual-value';
import CardField from './card-field.vue';
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
  /** For a currency exchange or a transfer: the account of the other side's payment, `null` until one is chosen. */
  counterAccountId: string | null;
  /** The direction the card logs the payment with; for a transfer it says whether the card account sends or receives. */
  direction: 'debit' | 'credit' | null;
  /** The payment is logged as a transfer between the owner's accounts: both sides are chosen on the card. */
  transfer: boolean;
  /** For a transfer: what the other side takes in its own currency, `null` until the owner writes it. */
  counterAmount: number | null;
  /** For a transfer: the currency of the other side when it differs from the notice's, so it needs its own amount. */
  counterAmountCurrency: string | null;
  /** The note the card holds; empty until the history or the owner fills it. */
  note: string;
  /** For a plain payment: the card's payee and category fields, set once the owner chose them; `null` for a transfer. */
  payeeField: ChatCardField | null;
  categoryField: ChatCardField | null;
  /** The account cannot change: the card is closed, or a change is being saved. */
  disabled: boolean;
}>();

const emit = defineEmits<{
  'update:accountId': [value: string | null];
  'update:counterAccountId': [value: string | null];
  /** The owner finished writing the note: store it on the card. */
  'commit:note': [value: string];
  /** Whether the text in the field differs from the note on the card, so Approve can wait for the save. */
  'update:noteDirty': [value: boolean];
  /** The owner finished writing the other side's amount of a transfer: store it on the card. */
  'commit:counterAmount': [value: number];
  /** Whether the amount in that field differs from the one on the card, so Approve can wait for the save. */
  'update:counterAmountDirty': [value: boolean];
  /** The sides of the transfer are the other way round. */
  swap: [];
  /** Log the notice as a plain payment, without the other side. */
  'log-as-payment': [];
  /** Choose the other side, to log the notice as a transfer. */
  'log-as-transfer': [];
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

const draftCounterAmount = ref<number | null>(props.counterAmount);
watch(
  () => props.counterAmount,
  (amount) => {
    draftCounterAmount.value = amount;
  },
);

// Only a field on screen holds an edit: once the other side takes the notice's currency, the amount is not asked for.
const isCounterAmountDirty = computed(
  () => props.counterAmountCurrency !== null && draftCounterAmount.value !== props.counterAmount,
);
watch(isCounterAmountDirty, (isDirty) => emit('update:counterAmountDirty', isDirty), { immediate: true });

const commitCounterAmount = () => {
  const amount = draftCounterAmount.value;
  if (typeof amount === 'number' && amount > 0 && amount !== props.counterAmount) emit('commit:counterAmount', amount);
};

const { t } = useI18n();

/**
 * The payee and category a plain payment is logged with: the owner's choice, else the server's pick. A payee approving
 * would create has no id yet and is named by its name.
 */
const payeeRow = computed<ChatCardField | null>(() => {
  const field = props.payeeField;
  if (!field || hasTwoSides.value) return null;

  const chosen = typeof field.value === 'string' ? field.value : null;
  return { ...field, value: chosen ?? props.payment.payee?.id ?? props.payment.payee?.name ?? null };
});
const isNewPayee = computed(
  () => typeof props.payeeField?.value !== 'string' && props.payment.payee != null && props.payment.payee.id === null,
);

const categoryRow = computed<ChatCardField | null>(() => {
  const field = props.categoryField;
  if (!field || hasTwoSides.value) return null;

  const chosen = typeof field.value === 'string' ? field.value : null;
  return { ...field, value: chosen ?? props.payment.category?.id ?? null };
});
const isDefaultCategory = computed(
  () => typeof props.categoryField?.value !== 'string' && props.payment.category?.source === 'default',
);

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

/**
 * The card's own payment is the outgoing side, so its account is where the money left. An exchange's sides are the
 * bank's two notices; a transfer's follow the direction on the card, which the owner flips to swap them.
 */
const ownIsOutgoing = computed(
  () => (props.payment.conversion ? props.payment.direction : props.direction) !== 'credit',
);
const hasTwoSides = computed(() => Boolean(props.payment.conversion) || props.transfer);
const isOwnTransfer = computed(() => props.payment.reason === 'ownTransfer' && !props.payment.conversion);
const isTransferIncomplete = computed(
  () => !selectedCounterAccount.value || (props.counterAmountCurrency !== null && !props.counterAmount),
);
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
        v-else-if="transfer"
        class="border-border text-app-transfer-color rounded-[5px] border px-1.5 py-px text-[10.5px] font-bold tracking-wider uppercase"
        data-testid="ingest-transfer"
      >
        {{ $t(`${LABEL_ROOT}.transfer`) }}
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
        <dt class="text-muted-foreground shrink-0">
          {{ $t(payeeRow ? `${LABEL_ROOT}.merchant` : `${LABEL_ROOT}.payee`) }}
        </dt>
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

    <dl v-if="payeeRow || categoryRow" class="-mx-2 flex flex-col gap-0.5" data-testid="ingest-details">
      <div v-if="payeeRow" data-testid="ingest-payee">
        <CardField :field="payeeRow" :lookups="lookups" :currency-code="null" :depends-on="[]" disabled />
        <p v-if="isNewPayee" class="text-muted-foreground px-2 text-right text-xs" data-testid="ingest-new-payee">
          {{ $t(`${LABEL_ROOT}.newPayee`) }}
        </p>
      </div>
      <div v-if="categoryRow" data-testid="ingest-category">
        <CardField :field="categoryRow" :lookups="lookups" :currency-code="null" :depends-on="[]" disabled />
        <p
          v-if="isDefaultCategory"
          class="text-muted-foreground px-2 text-right text-xs"
          data-testid="ingest-default-category"
        >
          {{ $t(`${LABEL_ROOT}.categoryDefault`) }}
        </p>
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

    <div v-if="hasTwoSides" class="flex flex-col gap-3" data-testid="ingest-conversion-accounts">
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
      <template v-if="payment.conversion">
        <p class="text-muted-foreground text-xs" data-testid="ingest-conversion-hint">
          {{ $t(`${LABEL_ROOT}.conversionHint`) }}
        </p>
      </template>
      <template v-else>
        <div
          v-if="counterAmountCurrency"
          data-testid="ingest-counter-amount"
          @keydown.enter.prevent="commitCounterAmount"
          @focusout="commitCounterAmount"
        >
          <InputField
            v-model="draftCounterAmount"
            type="number"
            :label="$t(`${LABEL_ROOT}.counterAmountLabel`, { currency: counterAmountCurrency })"
            :placeholder="$t(`${LABEL_ROOT}.counterAmountPlaceholder`, { currency: counterAmountCurrency })"
            :disabled="disabled"
          />
        </div>
        <p class="text-muted-foreground text-xs" data-testid="ingest-transfer-hint">
          {{ $t(isTransferIncomplete ? `${LABEL_ROOT}.transferIncompleteHint` : `${LABEL_ROOT}.transferHint`) }}
        </p>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            :disabled="disabled"
            data-testid="ingest-swap"
            @click="emit('swap')"
          >
            <ArrowUpDownIcon class="size-4" aria-hidden="true" />
            {{ $t(`${LABEL_ROOT}.swapAccounts`) }}
          </Button>
          <Button
            type="button"
            variant="link"
            size="sm"
            :disabled="disabled"
            data-testid="ingest-log-as-payment"
            @click="emit('log-as-payment')"
          >
            {{ $t(`${LABEL_ROOT}.logAsPayment`) }}
          </Button>
        </div>
      </template>
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
      <Button
        v-if="isOwnTransfer"
        type="button"
        variant="link"
        size="sm"
        class="self-start px-0"
        :disabled="disabled"
        data-testid="ingest-log-as-transfer"
        @click="emit('log-as-transfer')"
      >
        {{ $t(`${LABEL_ROOT}.logAsTransfer`) }}
      </Button>
    </div>
  </div>
</template>
