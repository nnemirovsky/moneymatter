<script setup lang="ts">
import { bulkScanTransferRecommendations, dismissTransferSuggestion, linkTransactions } from '@/api/transactions';
import * as Dialog from '@/components/lib/ui/dialog';
import * as Drawer from '@/components/lib/ui/drawer';
import DocsLink from '@/components/common/docs-link.vue';
import ResponsiveDialog from '@/components/common/responsive-dialog.vue';
import { Button } from '@/components/lib/ui/button';
import { Card } from '@/components/lib/ui/card';
import { DesktopOnlyTooltip } from '@/components/lib/ui/tooltip';
import { useAiSettings } from '@/composable/data-queries/ai-settings';
import { ScrollArea } from '@/components/lib/ui/scroll-area';
import { SCROLL_AREA_IDS } from '@/components/lib/ui/scroll-area/types';
import { useScrollAreaContainer } from '@/composable/scroll-area-container';
import { useNotificationCenter } from '@/components/notification-center';
import { useManageTransactionDialog } from '@/components/transactions-list/use-manage-transaction-dialog';
import { cn } from '@/lib/utils';
import { VUE_QUERY_GLOBAL_PREFIXES } from '@/common/const/vue-query';
import { useWindowBreakpoints } from '@/composable/window-breakpoints';
import { useVirtualizedInfiniteScroll } from '@/composable/virtualized-infinite-scroll';
import { AI_FEATURE, type TransactionModel, type RecordId, type BulkTransferScanItem } from '@bt/shared/types';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import type { Period } from '@/composable/use-period-navigation';
import { endOfDay, endOfMonth, isValid, parseISO, startOfDay, startOfMonth, subMonths } from 'date-fns';
import { useRoute } from 'vue-router';
import { SearchXIcon, SparklesIcon } from '@lucide/vue';
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { createReusableTemplate, useLocalStorage, useResizeObserver } from '@vueuse/core';
import { ApiErrorResponseError } from '@/js/errors';

import ExpenseListItem from './components/expense-list-item.vue';
import ScanControls from './components/scan-controls.vue';
import SuggestionsPanel from './components/suggestions-panel.vue';
import DialogHeader from '@/components/lib/ui/dialog/DialogHeader.vue';

const { t } = useI18n();
const { addSuccessNotification, addErrorNotification } = useNotificationCenter();
const queryClient = useQueryClient();
const SINGLE_PANEL_BREAKPOINT = 1023;
const isSinglePanel = useWindowBreakpoints(SINGLE_PANEL_BREAKPOINT);

const ManageTransactionDialogContent = defineAsyncComponent(
  () => import('@/components/dialogs/manage-transaction/dialog-content.vue'),
);
const LoanPaymentDialog = defineAsyncComponent(() => import('@/pages/loans/components/loan-payment-dialog/index.vue'));

const [UseDialogTemplate, SlotContent] = createReusableTemplate();

const PAGE_SIZE = 20;

const route = useRoute();
const queryFrom = parseISO(String(route.query.from));
const queryTo = parseISO(String(route.query.to));
const hasQueryPeriod = isValid(queryFrom) && isValid(queryTo);

const period = ref<Period>(
  hasQueryPeriod
    ? { from: startOfDay(queryFrom), to: endOfDay(queryTo) }
    : { from: startOfMonth(subMonths(new Date(), 2)), to: endOfMonth(new Date()) },
);
const includeOutOfWallet = ref(false);
const aiReview = useLocalStorage('optimizations:transfers:ai-review', false);
// Automatic re-scans would spend the user's AI allowance behind their back, so only the Scan button runs one.
const lastScanUsedAi = ref(false);
const canAutoRescan = () => !lastScanUsedAi.value && !aiReview.value;

// Accumulated scan results across pages
const allItems = ref<BulkTransferScanItem[]>([]);
const totalCount = ref(0);
const currentOffset = ref(0);
const isFetchingPage = ref(false);

const selectedItemIndex = ref<number>(0);
const suggestionsDialogOpen = ref(false);

const selectedItem = computed<BulkTransferScanItem | null>(() => {
  if (allItems.value.length === 0) return null;
  return allItems.value[selectedItemIndex.value] ?? null;
});

const hasScanned = ref(false);
const hasNextPage = computed(() => !lastScanUsedAi.value && allItems.value.length < totalCount.value);

// Manage transaction dialog
const {
  isDialogVisible,
  dialogProps,
  isCompactDialog,
  handleRecordClick,
  closeDialog,
  isLoanDialogVisible,
  loanDialogProps,
  closeLoanDialog,
} = useManageTransactionDialog();

// Re-scan when either edit dialog closes (user may have edited amount/date)
watch([isDialogVisible, isLoanDialogVisible], ([visible, loanVisible]) => {
  if (!visible && !loanVisible && hasScanned.value && canAutoRescan()) {
    freshScan();
  }
});

// Desktop scrolls the list inside its panel; single-panel scrolls the whole page.
const leftScrollAreaRef = ref<InstanceType<typeof ScrollArea> | null>(null);
const pageScrollContainer = useScrollAreaContainer(SCROLL_AREA_IDS.dashboard);
const leftPanelScrollElement = computed<HTMLElement | null>(() =>
  isSinglePanel.value
    ? (pageScrollContainer.value?.viewportElement ?? null)
    : ((leftScrollAreaRef.value?.viewportRef as { viewportElement?: HTMLElement } | null)?.viewportElement ?? null),
);
const pageRef = ref<HTMLElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const scrollMargin = ref(0);
const measureScrollMargin = () => {
  const el = listRef.value;
  const scrollEl = leftPanelScrollElement.value;
  scrollMargin.value =
    isSinglePanel.value && el && scrollEl
      ? el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
      : 0;
};
watch([listRef, isSinglePanel], measureScrollMargin);
useResizeObserver(pageRef, measureScrollMargin);

const { virtualRows, totalSize } = useVirtualizedInfiniteScroll<BulkTransferScanItem>({
  items: allItems,
  hasNextPage,
  fetchNextPage: loadNextPage,
  isFetchingNextPage: isFetchingPage,
  parentRef: leftPanelScrollElement,
  scrollMargin,
  estimateSize: () => 52,
  overscan: 10,
  getItemKey: (index) => allItems.value[index]?.expense.id ?? index,
});

async function loadNextPage() {
  if (isFetchingPage.value) return;
  isFetchingPage.value = true;

  try {
    const data = await bulkScanTransferRecommendations({
      from: period.value.from.toISOString(),
      to: period.value.to.toISOString(),
      includeOutOfWallet: includeOutOfWallet.value,
      offset: currentOffset.value,
      limit: PAGE_SIZE,
    });

    allItems.value = [...allItems.value, ...data.items];
    totalCount.value = data.total;
    currentOffset.value = allItems.value.length;
  } catch {
    addErrorNotification(t('optimizations.transferSuggestions.notifications.loadError'));
  } finally {
    isFetchingPage.value = false;
  }
}

const WEAK_CONFIDENCE = 70;
const { getFeatureStatus } = useAiSettings();
const showAiRescanHint = computed(() => {
  if (lastScanUsedAi.value || !getFeatureStatus(AI_FEATURE.transferMatching)?.servedBy) return false;
  const weak = allItems.value.filter((item) => item.matches.every((m) => m.confidence < WEAK_CONFIDENCE)).length;
  return weak >= allItems.value.length / 4;
});

function rescanWithAi() {
  aiReview.value = true;
  scanFromScratch();
}

// Auto re-scans keep the stale list to avoid a flash; a user-started scan shows the loading state.
function scanFromScratch() {
  allItems.value = [];
  totalCount.value = 0;
  freshScan();
}

// Fresh scan (resets pagination)
const isScanning = ref(false);

async function freshScan() {
  if (isScanning.value) return;
  isScanning.value = true;
  const usedAi = aiReview.value;

  try {
    const data = await bulkScanTransferRecommendations({
      from: period.value.from.toISOString(),
      to: period.value.to.toISOString(),
      includeOutOfWallet: includeOutOfWallet.value,
      aiReview: usedAi,
      offset: 0,
      limit: PAGE_SIZE,
    });

    lastScanUsedAi.value = usedAi;
    allItems.value = data.items;
    totalCount.value = data.total;
    currentOffset.value = data.items.length;
    selectedItemIndex.value = 0;
    hasScanned.value = true;
  } catch (error) {
    addErrorNotification(
      (usedAi && error instanceof ApiErrorResponseError && error.data.message) ||
        t('optimizations.transferSuggestions.notifications.scanError'),
    );
  } finally {
    isScanning.value = false;
  }
}

if (hasQueryPeriod) freshScan();

// Link mutation
const linkMutation = useMutation({
  mutationFn: ({ expenseId, incomeId }: { expenseId: string; incomeId: string }) =>
    linkTransactions({ ids: [[expenseId as RecordId, incomeId as RecordId]] }),
  onMutate: async ({ expenseId, incomeId }) => {
    const previous = { items: [...allItems.value], total: totalCount.value };

    allItems.value = allItems.value
      .filter((item) => item.expense.id !== expenseId)
      .map((item) => ({
        ...item,
        matches: item.matches.filter((m) => m.transaction.id !== incomeId),
      }))
      .filter((item) => item.matches.length > 0);
    totalCount.value = Math.max(0, totalCount.value - 1);
    currentOffset.value = allItems.value.length;

    if (selectedItemIndex.value >= allItems.value.length) {
      selectedItemIndex.value = Math.max(0, allItems.value.length - 1);
    }

    suggestionsDialogOpen.value = false;

    return { previous };
  },
  onSuccess: () => {
    addSuccessNotification(t('optimizations.transferSuggestions.notifications.linkSuccess'));

    // Background re-fetch to recalculate confidence scores
    if (canAutoRescan()) freshScan();
  },
  onError: (_err, _vars, context) => {
    if (context?.previous) {
      allItems.value = context.previous.items;
      totalCount.value = context.previous.total;
      currentOffset.value = allItems.value.length;
    }
    addErrorNotification(t('optimizations.transferSuggestions.notifications.linkError'));
  },
  onSettled: () => {
    queryClient.invalidateQueries({
      queryKey: [VUE_QUERY_GLOBAL_PREFIXES.transactionChange],
    });
  },
});

// Skip (dismiss) mutation
const skipMutation = useMutation({
  mutationFn: ({ expenseId, incomeId }: { expenseId: string; incomeId: string }) =>
    dismissTransferSuggestion({
      expenseTransactionId: expenseId as RecordId,
      incomeTransactionId: incomeId as RecordId,
    }),
  onMutate: async ({ expenseId, incomeId }) => {
    const previous = { items: [...allItems.value], total: totalCount.value };

    // Optimistic: remove the skipped match from the expense's matches
    allItems.value = allItems.value
      .map((item) => {
        if (item.expense.id !== expenseId) return item;
        return {
          ...item,
          matches: item.matches.filter((m) => m.transaction.id !== incomeId),
        };
      })
      .filter((item) => item.matches.length > 0);

    // If expense lost all matches, decrement total
    if (allItems.value.length < previous.items.length) {
      totalCount.value = Math.max(0, totalCount.value - 1);
    }
    currentOffset.value = allItems.value.length;

    if (selectedItemIndex.value >= allItems.value.length) {
      selectedItemIndex.value = Math.max(0, allItems.value.length - 1);
    }

    return { previous };
  },
  onSuccess: () => {
    addSuccessNotification(t('optimizations.transferSuggestions.notifications.skipSuccess'));
  },
  onError: (_err, _vars, context) => {
    if (context?.previous) {
      allItems.value = context.previous.items;
      totalCount.value = context.previous.total;
      currentOffset.value = allItems.value.length;
    }
    addErrorNotification(t('optimizations.transferSuggestions.notifications.skipError'));
  },
  onSettled: () => {
    queryClient.invalidateQueries({
      queryKey: [VUE_QUERY_GLOBAL_PREFIXES.transactionChange],
    });
  },
});

function handleSelectExpense(index: number) {
  selectedItemIndex.value = index;
  if (isSinglePanel.value) {
    suggestionsDialogOpen.value = true;
  }
}

function handleLink(payload: { expenseId: string; incomeId: string }) {
  linkMutation.mutate(payload);
}

function handleSkip(payload: { expenseId: string; incomeId: string }) {
  skipMutation.mutate(payload);
}

function handleTransactionClick(tx: TransactionModel, oppositeTx: TransactionModel | undefined) {
  handleRecordClick([tx, oppositeTx]);
}
</script>

<template>
  <div
    ref="pageRef"
    :class="
      cn(
        'flex w-full max-w-5xl flex-col gap-4 p-4 md:p-6',
        !isSinglePanel && 'h-[calc(100dvh-var(--header-height))] overflow-hidden',
      )
    "
  >
    <header class="flex shrink-0 flex-wrap items-end justify-between gap-3">
      <div class="grid min-w-0 gap-1">
        <p class="text-muted-foreground text-xs font-bold tracking-widest uppercase">{{ $t('optimizations.title') }}</p>
        <h1 class="text-2xl font-bold tracking-tight">
          {{ $t('optimizations.cards.transfers.title') }}
        </h1>
        <p class="text-muted-foreground text-sm">{{ $t('optimizations.transferSuggestions.description') }}</p>
      </div>
      <DocsLink
        path="/transfers-and-refunds/link-existing-transactions/#find-pairs-with-transfer-matching"
        class="text-sm font-semibold"
      />
    </header>

    <!-- Main container — always rendered, holds either content or empty/initial/loading states -->
    <Card class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ScanControls
        v-model:period="period"
        v-model:include-out-of-wallet="includeOutOfWallet"
        v-model:ai-review="aiReview"
        :is-loading="isScanning"
        class="shrink-0"
        @scan="scanFromScratch"
      />

      <div
        v-if="hasScanned && totalCount > 0"
        class="text-muted-foreground flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 text-sm"
      >
        <span>
          <span class="text-foreground font-semibold">{{ totalCount }}</span>
          {{ $t('optimizations.transferSuggestions.potentialTransfersFound') }}
        </span>
        <DesktopOnlyTooltip
          v-if="showAiRescanHint && isSinglePanel"
          :content="$t('optimizations.transferSuggestions.aiReview.rescanHintTooltip')"
          content-class-name="max-w-xs"
        >
          <Button variant="ghost-primary" size="sm" class="-my-1 h-7 gap-1.5" @click="rescanWithAi">
            <SparklesIcon class="size-3.5" />
            {{ $t('optimizations.transferSuggestions.aiReview.rescanHint') }}
          </Button>
        </DesktopOnlyTooltip>
      </div>

      <div class="flex min-h-0 flex-1 overflow-hidden">
        <template v-if="hasScanned && allItems.length > 0">
          <!-- Left panel: virtualized expense list -->
          <component
            :is="isSinglePanel ? 'div' : ScrollArea"
            ref="leftScrollAreaRef"
            class="w-full shrink-0 lg:w-80 lg:border-r"
          >
            <div ref="listRef" :style="{ height: `${totalSize}px`, width: '100%', position: 'relative' }">
              <div
                v-for="virtualRow in virtualRows"
                :key="String(virtualRow.key)"
                :style="{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                }"
              >
                <template v-if="virtualRow.index < allItems.length">
                  <div class="px-2 py-0.5">
                    <ExpenseListItem
                      :item="allItems[virtualRow.index]!"
                      :is-selected="selectedItemIndex === virtualRow.index"
                      @select="handleSelectExpense(virtualRow.index)"
                    />
                  </div>
                </template>
                <template v-else>
                  <div class="text-muted-foreground flex items-center justify-center py-3 text-xs">
                    {{ $t('optimizations.transferSuggestions.scanning') }}
                  </div>
                </template>
              </div>
            </div>
          </component>

          <!-- Right panel: suggestions (desktop) -->
          <div class="hidden min-w-0 flex-1 flex-col overflow-hidden lg:flex">
            <div v-if="showAiRescanHint" class="bg-primary/10 @container shrink-0 border-b px-4 py-2.5 text-sm">
              <div class="flex flex-col gap-2 @lg:flex-row @lg:items-center @lg:gap-3">
                <div class="flex min-w-0 flex-1 gap-2.5">
                  <SparklesIcon class="text-primary-text mt-0.5 size-4 shrink-0" />
                  <div class="min-w-0">
                    <p class="font-semibold">
                      {{ $t('optimizations.transferSuggestions.aiReview.rescanBanner.title') }}
                    </p>
                    <p class="text-muted-foreground">
                      {{ $t('optimizations.transferSuggestions.aiReview.rescanBanner.body') }}
                    </p>
                  </div>
                </div>
                <Button size="sm" class="ml-6.5 shrink-0 self-start @lg:ml-0 @lg:self-center" @click="rescanWithAi">
                  {{ $t('optimizations.transferSuggestions.aiReview.rescanHint') }}
                </Button>
              </div>
            </div>
            <SuggestionsPanel
              :selected-item="selectedItem"
              :is-linking="linkMutation.isPending.value"
              :is-skipping="skipMutation.isPending.value"
              @link="handleLink"
              @skip="handleSkip"
              @record-click="handleTransactionClick"
            />
          </div>
        </template>

        <!-- Empty state (after scan, no results) -->
        <div
          v-else-if="hasScanned && allItems.length === 0 && !isScanning"
          class="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12"
        >
          <SearchXIcon class="text-muted-foreground size-12" />
          <div class="text-center">
            <p class="font-medium">{{ $t('optimizations.transferSuggestions.empty.title') }}</p>
            <p class="text-muted-foreground mt-1 text-sm">
              {{ $t('optimizations.transferSuggestions.empty.description') }}
            </p>
          </div>
        </div>

        <!-- Initial state (before first scan) -->
        <div
          v-else-if="!hasScanned && !isScanning"
          class="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12"
        >
          <SparklesIcon class="text-muted-foreground size-12" />
          <div class="text-center">
            <p class="font-medium">{{ $t('optimizations.transferSuggestions.initial.title') }}</p>
            <p class="text-muted-foreground mt-1 max-w-md text-sm">
              {{ $t('optimizations.transferSuggestions.initial.description') }}
            </p>
          </div>
        </div>

        <!-- Loading state -->
        <div v-else-if="isScanning && allItems.length === 0" class="flex flex-1 items-center justify-center py-12">
          <div class="flex flex-col items-center gap-3">
            <div class="bg-primary/30 size-8 animate-ping rounded-full" />
            <p class="text-muted-foreground text-sm">
              {{
                aiReview
                  ? $t('optimizations.transferSuggestions.aiReview.reviewing')
                  : $t('optimizations.transferSuggestions.scanning')
              }}
            </p>
          </div>
        </div>
      </div>
    </Card>

    <!-- Single-panel: suggestions in a dialog/drawer -->
    <ResponsiveDialog
      v-if="isSinglePanel"
      v-model:open="suggestionsDialogOpen"
      no-internal-scroll
      dialog-content-class="max-w-2xl max-h-[85vh] px-0 pb-0 overflow-hidden"
      drawer-content-class="max-h-[85vh] !px-0 !pb-0"
    >
      <template #title>
        <div class="px-4">
          {{ $t('optimizations.transferSuggestions.suggestionsFor') }}
        </div>
      </template>
      <SuggestionsPanel
        :selected-item="selectedItem"
        :is-linking="linkMutation.isPending.value"
        :is-skipping="skipMutation.isPending.value"
        @link="handleLink"
        @skip="handleSkip"
        @record-click="handleTransactionClick"
      />
    </ResponsiveDialog>

    <!-- Manage transaction dialog -->
    <UseDialogTemplate>
      <ManageTransactionDialogContent v-bind="dialogProps" @close-modal="closeDialog" />
    </UseDialogTemplate>

    <template v-if="isSinglePanel">
      <Drawer.Drawer v-model:open="isDialogVisible">
        <Drawer.DrawerContent custom-indicator>
          <Drawer.DrawerTitle class="sr-only">{{ $t('transactions.list.detailsTitle') }}</Drawer.DrawerTitle>
          <Drawer.DrawerDescription class="sr-only">{{
            $t('transactions.list.detailsDescription')
          }}</Drawer.DrawerDescription>
          <SlotContent />
        </Drawer.DrawerContent>
      </Drawer.Drawer>
    </template>
    <template v-else>
      <Dialog.Dialog v-model:open="isDialogVisible">
        <Dialog.DialogContent
          custom-close
          :class="cn('max-h-[90dvh] w-full overflow-hidden p-0', isCompactDialog ? 'max-w-lg' : 'max-w-225')"
        >
          <Dialog.DialogTitle class="sr-only">{{ $t('transactions.list.detailsTitle') }}</Dialog.DialogTitle>
          <Dialog.DialogDescription class="sr-only">{{
            $t('transactions.list.detailsDescription')
          }}</Dialog.DialogDescription>
          <SlotContent />
        </Dialog.DialogContent>
      </Dialog.Dialog>
    </template>

    <!-- Dedicated loan-payment dialog: handleRecordClick routes transfer_to_loan rows here. -->
    <LoanPaymentDialog
      v-if="loanDialogProps.loanAccount"
      :open="isLoanDialogVisible"
      :loan-account="loanDialogProps.loanAccount"
      :transaction="loanDialogProps.transaction"
      :opposite-transaction="loanDialogProps.oppositeTransaction"
      @update:open="(value) => !value && closeLoanDialog()"
    />
  </div>
</template>
