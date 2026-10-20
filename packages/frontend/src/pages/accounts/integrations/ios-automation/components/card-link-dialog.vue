<template>
  <ResponsiveDialog :open="open" dialog-content-class="max-w-md" @update:open="emit('update:open', $event)">
    <template #title>
      {{ $t(`${LABEL_ROOT}.${titleKey}`) }}
    </template>
    <template #description>{{ $t(`${LABEL_ROOT}.description`) }}</template>

    <form :id="FORM_ID" class="grid gap-4" @submit.prevent="handleSubmit">
      <InputField
        v-model="form.cardLabel"
        :label="$t(`${LABEL_ROOT}.cardLabel`)"
        :placeholder="$t(`${LABEL_ROOT}.cardLabelPlaceholder`)"
        :error-message="labelError ?? undefined"
        :disabled="isLabelLocked"
        data-testid="card-link-label"
        @update:model-value="labelError = null"
      />

      <InputField
        v-if="!lockLabel || mapping"
        v-model="form.lastDigits"
        :label="$t(`${LABEL_ROOT}.lastDigits`)"
        :placeholder="$t(`${LABEL_ROOT}.lastDigitsPlaceholder`)"
        :error-message="digitsError ?? undefined"
        inputmode="numeric"
        data-testid="card-link-last-digits"
        @update:model-value="digitsError = null"
      />
      <p v-if="!lockLabel || mapping" class="text-muted-foreground -mt-2 text-xs">
        {{ $t(`${LABEL_ROOT}.lastDigitsHint`) }}
      </p>

      <SelectField
        v-model="form.currency"
        :values="currencyOptions"
        :label="$t(`${LABEL_ROOT}.currency`)"
        :placeholder="$t(`${LABEL_ROOT}.currencyPlaceholder`)"
        :disabled="!!mapping"
        data-testid="card-link-currency-select"
      />
      <p class="text-muted-foreground -mt-2 text-xs" data-testid="card-link-currency-hint">
        {{ $t(`${LABEL_ROOT}.${selectedCurrencyCode ? 'currencyHint' : 'currencyDefaultHint'}`) }}
      </p>

      <AccountSelectField
        v-model="form.account"
        :accounts="selectableAccounts"
        :label="$t(`${LABEL_ROOT}.account`)"
        :placeholder="$t(`${LABEL_ROOT}.accountPlaceholder`)"
        :error-message="accountError ?? undefined"
        data-testid="card-link-account"
        @update:model-value="accountError = null"
      />
    </form>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <Button type="button" variant="outline" :disabled="isSaving" @click="emit('update:open', false)">
          {{ $t('common.actions.cancel') }}
        </Button>
        <Button type="submit" :form="FORM_ID" :disabled="isSaving" :loading="isSaving" data-testid="card-link-submit">
          {{ $t(`${LABEL_ROOT}.save`) }}
        </Button>
      </div>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { createCardMapping, updateCardMapping } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import ResponsiveDialog from '@/components/common/responsive-dialog.vue';
import AccountSelectField from '@/components/fields/account-select-field.vue';
import InputField from '@/components/fields/input-field.vue';
import SelectField from '@/components/fields/select-field.vue';
import { Button } from '@/components/lib/ui/button';
import { useInvalidatingMutation } from '@/composable/data-queries/use-invalidating-mutation';
import { useAccountsStore } from '@/stores/accounts';
import {
  CARD_LAST_DIGITS_PATTERN,
  type AccountModel,
  type CardMappingDto,
  type CreateCardMappingPayload,
} from '@bt/shared/types';
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { getMappableAccounts } from '../ios-automation';
import { getFreeLinkTargets } from '../card-links';

const LABEL_ROOT = 'settings.integrations.iosAutomation.cardLinks.dialog';
const FORM_ID = 'card-link-form';

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** The link being edited; absent when a new link is created. */
    mapping?: CardMappingDto | null;
    /** Pre-fills the card name of a new link, e.g. from an unlinked card. */
    initialLabel?: string;
    /** The other rows of the card being extended: their currencies are taken. */
    siblings?: CardMappingDto[];
    /** The card the new row joins; its name cannot change here. */
    lockLabel?: boolean;
  }>(),
  { mapping: null, initialLabel: '', siblings: () => [], lockLabel: false },
);

const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [mapping: CardMappingDto];
}>();

const { t } = useI18n({ useScope: 'global' });
const accountsStore = useAccountsStore();

const mappableAccounts = computed(() => getMappableAccounts({ accounts: accountsStore.accounts ?? [] }));

interface CurrencyOption {
  /** The currency code, or `DEFAULT_CURRENCY_VALUE` for the card's default row. */
  value: string;
  label: string;
}

/** A select option cannot have an empty value, and currency codes are upper-case, so this never collides. */
const DEFAULT_CURRENCY_VALUE = 'default';

const form = reactive<{
  cardLabel: string;
  lastDigits: string;
  currency: CurrencyOption | null;
  account: AccountModel | null;
}>({
  cardLabel: '',
  lastDigits: '',
  currency: null,
  account: null,
});
const labelError = ref<string | null>(null);
const digitsError = ref<string | null>(null);
const accountError = ref<string | null>(null);

const isLabelLocked = computed(() => props.lockLabel && !props.mapping);
const titleKey = computed(() => {
  if (props.mapping) return 'editTitle';

  return props.lockLabel ? 'addAccountTitle' : 'createTitle';
});

const toCurrencyOption = ({ code }: { code: string | null }): CurrencyOption => ({
  value: code ?? DEFAULT_CURRENCY_VALUE,
  label: code ?? t(`${LABEL_ROOT}.currencyDefault`),
});

/** An edited row keeps its currency; a new one chooses among what the card has no row for. */
const currencyOptions = computed<CurrencyOption[]>(() => {
  if (props.mapping) return [toCurrencyOption({ code: props.mapping.currencyCode })];

  const { currencies, defaultAvailable } = getFreeLinkTargets({
    accounts: mappableAccounts.value,
    siblings: props.siblings,
  });

  return [...(defaultAvailable ? [null] : []), ...currencies].map((code) => toCurrencyOption({ code }));
});

const selectedCurrencyCode = computed(() =>
  form.currency && form.currency.value !== DEFAULT_CURRENCY_VALUE ? form.currency.value : null,
);

/** A row for one currency can only point at an account in that currency. */
const selectableAccounts = computed(() =>
  selectedCurrencyCode.value
    ? mappableAccounts.value.filter((account) => account.currencyCode === selectedCurrencyCode.value)
    : mappableAccounts.value,
);

watch(selectedCurrencyCode, () => {
  if (form.account && !selectableAccounts.value.some((account) => account.id === form.account?.id)) {
    form.account = null;
  }
});

/** Starts from the edited link, or from the pre-filled label of a new one. */
const resetForm = () => {
  form.cardLabel = props.mapping?.cardLabel ?? props.initialLabel;
  form.lastDigits = props.mapping?.lastDigits ?? '';
  form.currency = currencyOptions.value[0] ?? null;
  form.account = mappableAccounts.value.find((account) => account.id === props.mapping?.accountId) ?? null;
  labelError.value = null;
  digitsError.value = null;
  accountError.value = null;
};

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) resetForm();
  },
  { immediate: true },
);

const invalidateKeys = [VUE_QUERY_CACHE_KEYS.cardMappings, VUE_QUERY_CACHE_KEYS.unlinkedCards];

const { mutateAsync: create, isPending: isCreating } = useInvalidatingMutation({
  mutationFn: (payload: CreateCardMappingPayload) => createCardMapping(payload),
  invalidateKeys,
  successKey: `${LABEL_ROOT}.createSuccess`,
  errorKey: `${LABEL_ROOT}.saveError`,
});

const { mutateAsync: update, isPending: isUpdating } = useInvalidatingMutation({
  mutationFn: (payload: Parameters<typeof updateCardMapping>[0]) => updateCardMapping(payload),
  invalidateKeys,
  successKey: `${LABEL_ROOT}.updateSuccess`,
  errorKey: `${LABEL_ROOT}.saveError`,
});

const isSaving = computed(() => isCreating.value || isUpdating.value);

const handleSubmit = async () => {
  const cardLabel = form.cardLabel.trim();
  const lastDigits = form.lastDigits.trim();
  const { account } = form;

  labelError.value = cardLabel ? null : t(`${LABEL_ROOT}.cardLabelRequired`);
  digitsError.value =
    !lastDigits || CARD_LAST_DIGITS_PATTERN.test(lastDigits) ? null : t(`${LABEL_ROOT}.lastDigitsInvalid`);
  accountError.value = account ? null : t(`${LABEL_ROOT}.accountRequired`);
  if (!cardLabel || !account || digitsError.value) return;

  try {
    const { mapping } = props;
    if (!mapping) {
      const currencyCode = selectedCurrencyCode.value;

      emit(
        'saved',
        await create({
          cardLabel,
          accountId: account.id,
          ...(currencyCode && { currencyCode }),
          ...(lastDigits && { lastDigits }),
        }),
      );
    } else {
      // Only what changed: the server refuses an empty patch.
      const changes = {
        ...(cardLabel !== mapping.cardLabel && { cardLabel }),
        ...(account.id !== mapping.accountId && { accountId: account.id }),
        ...((lastDigits || null) !== mapping.lastDigits && { lastDigits: lastDigits || null }),
      };

      if (Object.keys(changes).length) emit('saved', await update({ id: mapping.id, ...changes }));
    }

    emit('update:open', false);
  } catch {
    // The mutation already told the user what failed; the form stays open for another try.
  }
};
</script>
