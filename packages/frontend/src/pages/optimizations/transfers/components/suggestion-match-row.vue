<script setup lang="ts">
import TransactionRecord from '@/components/transactions-list/transaction-record.vue';
import { Button } from '@/components/lib/ui/button';
import { DesktopOnlyTooltip } from '@/components/lib/ui/tooltip';
import { cn } from '@/lib/utils';
import type { TransactionModel, BulkTransferScanMatch } from '@bt/shared/types';
import { LinkIcon, LoaderCircleIcon, SparklesIcon, XIcon } from '@lucide/vue';
import { computed } from 'vue';

const props = defineProps<{
  match: BulkTransferScanMatch;
  isLinking: boolean;
  isSkipping: boolean;
}>();

const emit = defineEmits<{
  link: [];
  skip: [];
  'record-click': [value: TransactionModel, oppositeTx: TransactionModel | undefined];
}>();

const CONFIDENCE_HIGH = 75;
const CONFIDENCE_MEDIUM = 50;

function getConfidenceColors(confidence: number): { bg: string; text: string } {
  if (confidence >= CONFIDENCE_HIGH) return { bg: 'bg-success-text', text: 'text-success-text' };
  if (confidence >= CONFIDENCE_MEDIUM) return { bg: 'bg-warning-text', text: 'text-warning-text' };
  return { bg: 'bg-destructive-text', text: 'text-destructive-text' };
}

const isBusy = computed(() => props.isLinking || props.isSkipping);

const confidenceColors = computed(() => getConfidenceColors(props.match.confidence));

function handleRecordClick([tx, oppositeTx]: [TransactionModel, TransactionModel | undefined]) {
  emit('record-click', tx, oppositeTx);
}
</script>

<template>
  <div class="@container/match rounded-md border px-2 py-1">
    <div class="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 @[500px]/match:grid-cols-[auto_1fr_auto]">
      <!-- Transaction: spans full row in narrow, middle column in wide -->
      <div class="col-span-2 min-w-0 @[500px]/match:col-span-1 @[500px]/match:col-start-2">
        <TransactionRecord :tx="match.transaction" @record-click="handleRecordClick" />
      </div>

      <!-- Confidence -->
      <div
        class="ml-2 flex shrink-0 items-center gap-1.5 @[500px]/match:col-start-1 @[500px]/match:row-start-1 @[500px]/match:ml-0"
      >
        <div :class="cn('size-2 rounded-full', confidenceColors.bg)" />
        <span :class="cn('text-xs font-semibold tabular-nums', confidenceColors.text)"> {{ match.confidence }}% </span>
      </div>

      <!-- Actions -->
      <div class="flex shrink-0 justify-end gap-1 @[500px]/match:col-start-3 @[500px]/match:row-start-1">
        <Button variant="soft-destructive" size="sm" :disabled="isBusy" class="gap-1.5" @click.stop="$emit('skip')">
          <LoaderCircleIcon v-if="isSkipping" class="size-3.5 animate-spin" />
          <XIcon v-else class="size-3.5" />

          {{ $t('optimizations.transferSuggestions.skip.action') }}
        </Button>

        <Button variant="default" size="sm" :disabled="isBusy" class="gap-1.5" @click.stop="$emit('link')">
          <LoaderCircleIcon v-if="isLinking" class="size-3.5 animate-spin" />
          <LinkIcon v-else class="size-3.5" />

          {{ $t('common.actions.link') }}
        </Button>
      </div>

      <!-- AI verdict: its own row under the transaction -->
      <div
        v-if="match.ai"
        class="text-muted-foreground col-span-full flex min-w-0 items-center gap-2 pb-1 text-sm @[500px]/match:row-start-2"
      >
        <span
          :class="
            cn(
              'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-bold',
              match.ai.verdict === 'likely'
                ? 'bg-success-text/15 text-success-text'
                : 'bg-warning-text/15 text-warning-text',
            )
          "
        >
          <SparklesIcon class="size-3" />
          {{ $t(`optimizations.transferSuggestions.aiReview.verdict.${match.ai.verdict}`) }}
        </span>
        <DesktopOnlyTooltip :content="match.ai.reason" content-class-name="max-w-sm" only-when-truncated>
          <span class="min-w-0 truncate">{{ match.ai.reason }}</span>
        </DesktopOnlyTooltip>
      </div>
    </div>
  </div>
</template>
