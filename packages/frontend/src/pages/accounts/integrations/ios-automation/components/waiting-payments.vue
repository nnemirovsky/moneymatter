<template>
  <section class="flex flex-col gap-4" data-testid="waiting-payments">
    <div class="max-w-xl">
      <h3 class="mb-2 text-lg font-medium">{{ $t(`${LABEL_ROOT}.title`) }}</h3>
      <p class="text-muted-foreground text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.description`) }}</p>
    </div>

    <Callout v-if="isError" variant="destructive" data-testid="waiting-payments-error">
      {{ $t(`${LABEL_ROOT}.loadError`) }}
    </Callout>

    <div
      v-else-if="!isLoading && !waiting.length"
      class="text-muted-foreground flex flex-col items-center gap-1 py-6 text-center text-sm"
      data-testid="waiting-payments-empty"
    >
      <InboxIcon class="mb-2 size-8" />
      <p class="text-foreground font-medium">{{ $t(`${LABEL_ROOT}.empty.title`) }}</p>
      <p class="max-w-sm">{{ $t(`${LABEL_ROOT}.empty.description`) }}</p>
    </div>

    <ul v-else class="flex flex-col gap-3">
      <li
        v-for="request in waiting"
        :key="request.id"
        class="border-border flex flex-col gap-3 rounded-lg border p-4 @lg/integrations:flex-row @lg/integrations:items-center @lg/integrations:justify-between"
        data-testid="waiting-payment-row"
      >
        <PaymentRequestSummary :request="request" :inbox-thread-id="inboxThreadId" />

        <div class="flex gap-2 self-start @lg/integrations:self-center">
          <Button
            variant="outline"
            size="sm"
            :aria-label="
              $t(`${LABEL_ROOT}.${needsApproval({ request }) ? 'approveAria' : 'retryAria'}`, {
                name: merchantName({ request }),
              })
            "
            :disabled="isBusy"
            data-testid="waiting-payment-retry"
            @click="retry(request)"
          >
            {{ $t(`${LABEL_ROOT}.${needsApproval({ request }) ? 'approve' : 'retry'}`) }}
          </Button>
          <Button
            variant="soft-destructive"
            size="sm"
            :aria-label="$t(`${LABEL_ROOT}.dismissAria`, { name: merchantName({ request }) })"
            :disabled="isBusy"
            data-testid="waiting-payment-dismiss"
            @click="askToDismiss({ request })"
          >
            {{ $t(`${LABEL_ROOT}.dismiss`) }}
          </Button>
        </div>
      </li>
    </ul>

    <div class="flex flex-col gap-3">
      <Button
        variant="ghost"
        size="sm"
        class="self-start"
        data-testid="recent-payments-toggle"
        @click="isRecentShown = !isRecentShown"
      >
        <component :is="isRecentShown ? ChevronUpIcon : ChevronDownIcon" class="size-4" />
        {{ $t(`${LABEL_ROOT}.recent.${isRecentShown ? 'hide' : 'show'}`) }}
      </Button>

      <template v-if="isRecentShown">
        <Callout v-if="isRecentError" variant="destructive">{{ $t(`${LABEL_ROOT}.recent.loadError`) }}</Callout>

        <p v-else-if="!isRecentLoading && !recent.length" class="text-muted-foreground text-sm">
          {{ $t(`${LABEL_ROOT}.recent.empty`) }}
        </p>

        <ul v-else class="flex flex-col gap-3" data-testid="recent-payments">
          <li
            v-for="request in recent"
            :key="request.id"
            class="border-border flex flex-col gap-3 rounded-lg border p-4 @lg/integrations:flex-row @lg/integrations:items-center @lg/integrations:justify-between"
            data-testid="recent-payment-row"
          >
            <PaymentRequestSummary :request="request" :inbox-thread-id="inboxThreadId" />

            <StatusBadge :variant="STATUS_VARIANTS[request.status]" class="self-start">
              {{ $t(`${LABEL_ROOT}.statuses.${request.status}`) }}
            </StatusBadge>
          </li>
        </ul>
      </template>
    </div>
  </section>

  <ResponsiveAlertDialog
    v-model:open="isDismissOpen"
    :confirm-label="$t(`${LABEL_ROOT}.dismissDialog.confirm`)"
    confirm-variant="destructive"
    @confirm="confirmDismiss"
  >
    <template #title>{{ $t(`${LABEL_ROOT}.dismissDialog.title`) }}</template>
    <template #description>
      {{
        $t(`${LABEL_ROOT}.dismissDialog.description`, {
          name: dismissTarget ? merchantName({ request: dismissTarget }) : '',
        })
      }}
    </template>
  </ResponsiveAlertDialog>
</template>

<script setup lang="ts">
import { listChatThreads } from '@/api/chat';
import { dismissCardPaymentRequest, getCardPaymentRequests, retryCardPaymentRequest } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS, VUE_QUERY_GLOBAL_PREFIXES } from '@/common/const/vue-query';
import ResponsiveAlertDialog from '@/components/common/responsive-alert-dialog.vue';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { StatusBadge, type Variant } from '@/components/lib/ui/status-badge';
import { useNotificationCenter } from '@/components/notification-center';
import { useInvalidatingMutation } from '@/composable/data-queries/use-invalidating-mutation';
import type { CardPaymentRequestDto, IngestRequestStatus } from '@bt/shared/types';
import { ChevronDownIcon, ChevronUpIcon, InboxIcon } from '@lucide/vue';
import { useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { hasInboxCard } from '../ios-automation';
import PaymentRequestSummary from './payment-request-summary.vue';

defineOptions({
  name: 'settings-integrations-waiting-payments',
});

const LABEL_ROOT = 'settings.integrations.iosAutomation.waiting';

/** The pinned inbox thread sorts first, so a short page finds it. */
const INBOX_LOOKUP_LIMIT = 20;

const STATUS_VARIANTS: Record<IngestRequestStatus, Variant> = {
  received: 'info',
  logged: 'success',
  parked: 'warning',
  rejected: 'destructive',
  dismissed: 'info',
  ignored: 'info',
  held: 'warning',
  enriched: 'success',
};

const { t } = useI18n({ useScope: 'global' });
const { addWarningNotification } = useNotificationCenter();

const isRecentShown = ref(false);
const isDismissOpen = ref(false);
const dismissTarget = ref<CardPaymentRequestDto | null>(null);

const {
  data: waitingData,
  isLoading,
  isError,
} = useQuery({
  // The `parked` view is shared with `useLogWaitingPayments`, which reads it fresh before retrying.
  queryKey: [...VUE_QUERY_CACHE_KEYS.cardPaymentRequests, 'parked'],
  queryFn: () => getCardPaymentRequests({ status: 'parked' }),
});

const {
  data: recentData,
  isLoading: isRecentLoading,
  isError: isRecentError,
} = useQuery({
  queryKey: [...VUE_QUERY_CACHE_KEYS.cardPaymentRequests, 'recent'],
  queryFn: () => getCardPaymentRequests({ status: 'recent' }),
  enabled: isRecentShown,
});

const waiting = computed(() => waitingData.value ?? []);
const recent = computed(() => recentData.value ?? []);

/** The inbox thread is looked up only when a waiting request has a card there to link to. */
const hasWaitingCard = computed(() => waiting.value.some((request) => hasInboxCard({ request })));

const { data: threadsPage } = useQuery({
  queryKey: [...VUE_QUERY_CACHE_KEYS.chatThreads, 'inbox-link'],
  queryFn: () => listChatThreads({ limit: INBOX_LOOKUP_LIMIT }),
  enabled: hasWaitingCard,
});

const inboxThreadId = computed(
  () => threadsPage.value?.threads.find((thread) => thread.kind === 'automationInbox')?.id ?? null,
);

/** A payment parked for the owner's OK is logged with `force`; the card in the inbox does the same. */
const needsApproval = ({ request }: { request: CardPaymentRequestDto }) =>
  request.pipeline === 'notification' &&
  (request.reason === 'ownTransfer' || request.reason === 'lowConfidence' || request.reason === 'unverifiedParse');

const merchantName = ({ request }: { request: CardPaymentRequestDto }) =>
  request.merchant ?? t(`${LABEL_ROOT}.unknownMerchant`);

const { mutateAsync: retryRequest, isPending: isRetrying } = useInvalidatingMutation({
  mutationFn: (request: CardPaymentRequestDto) =>
    retryCardPaymentRequest({ id: request.id, ...(needsApproval({ request }) && { force: true }) }),
  invalidateKeys: [
    VUE_QUERY_CACHE_KEYS.cardPaymentRequests,
    VUE_QUERY_CACHE_KEYS.unlinkedCards,
    [VUE_QUERY_GLOBAL_PREFIXES.transactionChange],
  ],
  successMessage: (result) => (result.outcome === 'logged' ? t(`${LABEL_ROOT}.retryLogged`) : ''),
  errorKey: `${LABEL_ROOT}.retryError`,
  onSuccess: (result) => {
    if (result.outcome === 'parked') {
      addWarningNotification(t(`${LABEL_ROOT}.retryStillWaiting`, { summary: result.summary }));
    }
  },
});

const { mutateAsync: dismissRequest, isPending: isDismissing } = useInvalidatingMutation({
  mutationFn: (request: CardPaymentRequestDto) => dismissCardPaymentRequest({ id: request.id }),
  invalidateKeys: [VUE_QUERY_CACHE_KEYS.cardPaymentRequests, VUE_QUERY_CACHE_KEYS.unlinkedCards],
  successKey: `${LABEL_ROOT}.dismissDialog.success`,
  errorKey: `${LABEL_ROOT}.dismissDialog.error`,
});

const isBusy = computed(() => isRetrying.value || isDismissing.value);

const retry = async (request: CardPaymentRequestDto) => {
  try {
    await retryRequest(request);
  } catch {
    // useInvalidatingMutation already told the user what failed.
  }
};

const askToDismiss = ({ request }: { request: CardPaymentRequestDto }) => {
  dismissTarget.value = request;
  isDismissOpen.value = true;
};

const confirmDismiss = async () => {
  const request = dismissTarget.value;
  if (!request) return;

  try {
    await dismissRequest(request);
  } catch {
    // useInvalidatingMutation already told the user what failed.
  } finally {
    isDismissOpen.value = false;
    dismissTarget.value = null;
  }
};
</script>
