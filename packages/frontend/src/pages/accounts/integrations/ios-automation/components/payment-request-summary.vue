<template>
  <div class="min-w-0 flex-1" data-testid="payment-request">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span class="font-medium break-words" data-testid="payment-request-merchant">
        {{ request.merchant ?? $t(`${LABEL_ROOT}.unknownMerchant`) }}
      </span>
      <span class="text-sm tabular-nums" data-testid="payment-request-amount">
        {{ request.amountText ?? $t(`${LABEL_ROOT}.unknownAmount`) }}
      </span>
      <span
        class="border-border text-muted-foreground shrink-0 rounded-[5px] border px-1.5 py-px text-[10.5px] font-bold tracking-wider uppercase"
        data-testid="payment-request-kind"
      >
        {{ $t(`${LABEL_ROOT}.kinds.${request.pipeline}`) }}
      </span>
    </div>

    <div class="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
      <span data-testid="payment-request-card">{{ request.cardLabel ?? $t(`${LABEL_ROOT}.unknownCard`) }}</span>
      <span data-testid="payment-request-time">{{
        formatDateWithTime({ date: new Date(request.time), locale: getDateFnsLocale() })
      }}</span>
    </div>

    <p v-if="reasonKey" class="text-muted-foreground mt-2 text-sm" data-testid="payment-request-reason">
      {{ $t(reasonKey) }}
    </p>

    <RouterLink
      v-if="inboxThreadId && hasCard"
      :to="{ name: ROUTES_NAMES.chatThread, params: { threadId: inboxThreadId } }"
      class="text-primary-text mt-2 inline-block text-sm underline-offset-2 hover:underline"
      data-testid="payment-request-inbox-link"
    >
      {{ $t(`${LABEL_ROOT}.openInbox`) }}
    </RouterLink>
  </div>
</template>

<script setup lang="ts">
import { getDateFnsLocale } from '@/composable/use-date-locale';
import { formatDateWithTime } from '@/js/helpers/time-zone';
import { ROUTES_NAMES } from '@/routes';
import type { CardPaymentRequestDto } from '@bt/shared/types';
import { computed } from 'vue';

import { getRequestReasonKey, hasInboxCard } from '../ios-automation';

const LABEL_ROOT = 'settings.integrations.iosAutomation.waiting';

const props = defineProps<{
  request: CardPaymentRequestDto;
  /** The Automation inbox thread; the link to the request's card shows only when it is known. */
  inboxThreadId?: string | null;
}>();

const reasonKey = computed(() => getRequestReasonKey({ reason: props.request.reason }));
const hasCard = computed(() => hasInboxCard({ request: props.request }));
</script>
