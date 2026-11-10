<script setup lang="ts">
import AccountSelectField from '@/components/fields/account-select-field.vue';
import CategorySelectField from '@/components/fields/category-select-field.vue';
import InputField from '@/components/fields/input-field.vue';
import PayeeSelectField from '@/components/fields/payee-select-field.vue';
import SelectField from '@/components/fields/select-field.vue';
import type { ChatIngestRequestSummary } from '@bt/shared/types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { useChatText } from '../chat-text';
import { findCategory } from './card-values';
import type { CardLookups } from './use-card-lookups';

const LABEL_ROOT = 'chat.cards.ingest';

const props = defineProps<{
  payment: ChatIngestRequestSummary;
  lookups: CardLookups;
  /** The account the card logs the payment on now, chosen or suggested; `null` until there is one. */
  accountId: string | null;
  /** The direction the card logs the payment with now. */
  direction: 'debit' | 'credit' | null;
}>();

/**
 * The card's arguments being edited. A payee or category left alone stays out of them, so the server's pick still
 * decides; clearing one hands it back to the server.
 */
const draft = defineModel<Record<string, unknown>>({ required: true });

const { t } = useI18n();
const { keyText, enumValueText } = useChatText();

const set = ({ path, value }: { path: string; value: unknown }) => {
  draft.value = { ...draft.value, [path]: value ?? undefined };
};

const draftString = ({ path }: { path: string }) =>
  typeof draft.value[path] === 'string' ? (draft.value[path] as string) : null;

const payeeId = computed(() => draftString({ path: 'payeeId' }) ?? props.payment.payee?.id ?? null);
/** A payee approving would create has no id yet: its name stands in the empty picker. */
const payeePlaceholder = computed(() =>
  props.payment.payee && props.payment.payee.id === null
    ? t(`${LABEL_ROOT}.newPayeePlaceholder`, { name: props.payment.payee.name })
    : t('chat.cards.edit.placeholders.payee'),
);

const selectedCategory = computed(() =>
  findCategory({
    list: props.lookups.categories(),
    id: draftString({ path: 'categoryId' }) ?? props.payment.category?.id ?? null,
  }),
);

const selectedAccount = computed(() => {
  const id = draftString({ path: 'accountId' }) ?? props.accountId;
  return props.lookups.accounts().find((account) => account.id === id) ?? null;
});

const directions = computed(() =>
  (['debit', 'credit'] as const).map((value) => ({ value, label: enumValueText({ path: 'direction', value }) })),
);
const selectedDirection = computed(() => {
  const value = draftString({ path: 'direction' }) ?? props.direction;
  return directions.value.find((item) => item.value === value) ?? null;
});

const note = computed(() => draftString({ path: 'note' }) ?? '');

const label = ({ path }: { path: string }) => keyText({ key: `chat.fields.${path}` }) ?? path;
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="ingest-request-editor">
    <div data-testid="field-editor-payeeId">
      <PayeeSelectField
        :model-value="payeeId"
        :label="label({ path: 'payeeId' })"
        :placeholder="payeePlaceholder"
        @update:model-value="set({ path: 'payeeId', value: $event })"
      />
    </div>
    <div data-testid="field-editor-categoryId">
      <CategorySelectField
        :model-value="selectedCategory"
        :values="lookups.categories()"
        :label="label({ path: 'categoryId' })"
        :placeholder="$t('chat.cards.edit.placeholders.category')"
        @update:model-value="set({ path: 'categoryId', value: $event?.id })"
      />
    </div>
    <div data-testid="field-editor-accountId">
      <AccountSelectField
        :model-value="selectedAccount"
        :accounts="lookups.accounts()"
        :label="$t(`${LABEL_ROOT}.account`)"
        :placeholder="$t(`${LABEL_ROOT}.accountPlaceholder`)"
        @update:model-value="set({ path: 'accountId', value: $event?.id })"
      />
    </div>
    <div data-testid="field-editor-direction">
      <SelectField
        :model-value="selectedDirection"
        :values="directions"
        :label="label({ path: 'direction' })"
        @update:model-value="set({ path: 'direction', value: $event?.value })"
      />
    </div>
    <div data-testid="field-editor-note">
      <InputField
        :model-value="note"
        :label="$t(`${LABEL_ROOT}.noteLabel`)"
        :placeholder="$t(`${LABEL_ROOT}.notePlaceholder`)"
        @update:model-value="set({ path: 'note', value: $event })"
      />
    </div>
  </div>
</template>
