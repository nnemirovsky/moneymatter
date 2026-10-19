<template>
  <section v-if="isError || plans.length" class="flex flex-col gap-4" data-testid="unconfirmed-payments">
    <div class="max-w-xl">
      <h3 class="mb-2 text-lg font-medium">{{ $t(`${LABEL_ROOT}.title`) }}</h3>
      <p class="text-muted-foreground text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.description`) }}</p>
    </div>

    <Callout v-if="isError" variant="destructive" data-testid="unconfirmed-payments-error">
      {{ $t(`${LABEL_ROOT}.loadError`) }}
    </Callout>

    <ul v-else class="flex flex-col gap-3">
      <li
        v-for="plan in plans"
        :key="plan.transactionId"
        class="border-border flex flex-col gap-3 rounded-lg border p-4 @lg/integrations:flex-row @lg/integrations:items-center @lg/integrations:justify-between"
        data-testid="unconfirmed-payment-row"
      >
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="font-medium break-words" data-testid="unconfirmed-payment-merchant">
              {{ merchantName({ plan }) }}
            </span>
            <span class="text-sm tabular-nums" data-testid="unconfirmed-payment-amount">
              {{ formatUIAmount(plan.amount, { currency: plan.currencyCode }) }}
            </span>
          </div>
          <div class="text-muted-foreground mt-1 text-xs" data-testid="unconfirmed-payment-date">
            {{ format(plan.time, 'PP') }}
          </div>
        </div>

        <Button
          variant="soft-destructive"
          size="sm"
          class="self-start @lg/integrations:self-center"
          :aria-label="$t(`${LABEL_ROOT}.deleteAria`, { name: merchantName({ plan }) })"
          :disabled="isDeleting"
          data-testid="unconfirmed-payment-delete"
          @click="askToDelete({ plan })"
        >
          {{ $t(`${LABEL_ROOT}.delete`) }}
        </Button>
      </li>
    </ul>
  </section>

  <ResponsiveAlertDialog
    v-model:open="isDeleteOpen"
    :confirm-label="$t(`${LABEL_ROOT}.deleteDialog.confirm`)"
    confirm-variant="destructive"
    @confirm="confirmDelete"
  >
    <template #title>{{ $t(`${LABEL_ROOT}.deleteDialog.title`) }}</template>
    <template #description>
      {{
        $t(`${LABEL_ROOT}.deleteDialog.description`, { name: deleteTarget ? merchantName({ plan: deleteTarget }) : '' })
      }}
    </template>
  </ResponsiveAlertDialog>
</template>

<script setup lang="ts">
import { getUnconfirmedCardPayments } from '@/api/ingest';
import { deleteTransaction } from '@/api/transactions';
import { VUE_QUERY_CACHE_KEYS, VUE_QUERY_GLOBAL_PREFIXES } from '@/common/const/vue-query';
import ResponsiveAlertDialog from '@/components/common/responsive-alert-dialog.vue';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { useInvalidatingMutation } from '@/composable/data-queries/use-invalidating-mutation';
import { useDateLocale } from '@/composable/use-date-locale';
import { formatUIAmount } from '@/js/helpers';
import type { UnconfirmedCardPaymentDto } from '@bt/shared/types';
import { useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

defineOptions({
  name: 'settings-integrations-unconfirmed-payments',
});

const LABEL_ROOT = 'settings.integrations.applePay.unconfirmed';

const { t } = useI18n({ useScope: 'global' });
const { format } = useDateLocale();

const isDeleteOpen = ref(false);
const deleteTarget = ref<UnconfirmedCardPaymentDto | null>(null);

const { data, isError } = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.unconfirmedCardPayments,
  queryFn: getUnconfirmedCardPayments,
});

const plans = computed(() => data.value ?? []);

const merchantName = ({ plan }: { plan: UnconfirmedCardPaymentDto }) =>
  plan.merchant ?? t(`${LABEL_ROOT}.unknownMerchant`);

// Deleting the plan is a transaction change: balances and lists refresh through the transaction prefix.
const { mutateAsync: remove, isPending: isDeleting } = useInvalidatingMutation({
  mutationFn: (plan: UnconfirmedCardPaymentDto) => deleteTransaction(plan.transactionId),
  invalidateKeys: [[VUE_QUERY_GLOBAL_PREFIXES.transactionChange]],
  successKey: 'common.transactions.delete.success',
  errorKey: 'common.transactions.delete.error',
});

const askToDelete = ({ plan }: { plan: UnconfirmedCardPaymentDto }) => {
  deleteTarget.value = plan;
  isDeleteOpen.value = true;
};

const confirmDelete = async () => {
  const plan = deleteTarget.value;
  if (!plan) return;

  try {
    await remove(plan);
  } catch {
    // useInvalidatingMutation already told the user what failed.
  } finally {
    isDeleteOpen.value = false;
    deleteTarget.value = null;
  }
};
</script>
