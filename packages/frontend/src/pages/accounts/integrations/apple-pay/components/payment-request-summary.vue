<template>
  <div class="min-w-0 flex-1" data-testid="payment-request">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span class="font-medium break-words" data-testid="payment-request-merchant">
        {{ request.merchant ?? $t(`${LABEL_ROOT}.unknownMerchant`) }}
      </span>
      <span class="text-sm tabular-nums" data-testid="payment-request-amount">
        {{ request.amountText ?? $t(`${LABEL_ROOT}.unknownAmount`) }}
      </span>
    </div>

    <div class="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
      <span data-testid="payment-request-card">{{ request.cardLabel ?? $t(`${LABEL_ROOT}.unknownCard`) }}</span>
      <span data-testid="payment-request-time">{{ format(request.time, 'PPp') }}</span>
    </div>

    <p v-if="reasonKey" class="text-muted-foreground mt-2 text-sm" data-testid="payment-request-reason">
      {{ $t(reasonKey) }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { useDateLocale } from '@/composable/use-date-locale';
import type { CardPaymentRequestDto } from '@bt/shared/types';
import { computed } from 'vue';

import { getRequestReasonKey } from '../apple-pay';

const LABEL_ROOT = 'settings.integrations.applePay.waiting';

const props = defineProps<{ request: CardPaymentRequestDto }>();

const { format } = useDateLocale();

const reasonKey = computed(() => getRequestReasonKey({ reason: props.request.reason }));
</script>
