<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import { Card } from '@/components/lib/ui/card';
import { StatusBadge } from '@/components/lib/ui/status-badge';
import TransactionRecord from '@/components/transactions-list/transaction-record.vue';
import type { DuplicateSuggestionItem, TransactionModel } from '@bt/shared/types';
import { GitMergeIcon, Loader2Icon, XIcon } from '@lucide/vue';
import { computed } from 'vue';

import { describeSuggestionSlot } from '../suggestion-sources';

const props = defineProps<{
  suggestion: DuplicateSuggestionItem;
  /** The dismissal of this suggestion is running. */
  isDismissing: boolean;
}>();

const emit = defineEmits<{ merge: []; dismiss: [] }>();

const PERCENT = 100;
/** Below this the judge was unsure: the badge warns instead of informing. */
const CONFIDENT_FROM = 0.85;

const percent = computed(() => Math.round(props.suggestion.confidence * PERCENT));
const badgeVariant = computed(() => (props.suggestion.confidence >= CONFIDENT_FROM ? 'info' : 'warning'));

const sides = computed<{ tx: TransactionModel; slots: string[] }[]>(() => [
  { tx: props.suggestion.transaction, slots: props.suggestion.transactionSlots },
  { tx: props.suggestion.candidate, slots: props.suggestion.candidateSlots },
]);
</script>

<template>
  <Card class="overflow-hidden" data-testid="suggestion-card">
    <div class="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <StatusBadge :variant="badgeVariant" data-testid="suggestion-confidence">
          {{ $t('optimizations.reconciliation.suggestions.confidence', { percent }) }}
        </StatusBadge>
        <p
          v-if="suggestion.reason"
          class="text-muted-foreground min-w-0 text-sm wrap-anywhere"
          data-testid="suggestion-reason"
        >
          {{ suggestion.reason }}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          data-testid="suggestion-dismiss"
          :disabled="isDismissing"
          @click="emit('dismiss')"
        >
          <Loader2Icon v-if="isDismissing" class="size-4 animate-spin" />
          <XIcon v-else class="size-4" />
          {{ $t('optimizations.reconciliation.suggestions.dismiss') }}
        </Button>
        <Button
          variant="soft-primary"
          size="sm"
          data-testid="suggestion-merge"
          :disabled="isDismissing"
          @click="emit('merge')"
        >
          <GitMergeIcon class="size-4" />
          {{ $t('optimizations.reconciliation.actions.merge') }}
        </Button>
      </div>
    </div>

    <div class="flex flex-col gap-3 px-4 py-3">
      <div v-for="side in sides" :key="side.tx.id" class="flex flex-col gap-1" data-testid="suggestion-side">
        <TransactionRecord :tx="side.tx" :as-button="false" />
        <ul v-if="side.slots.length" class="flex flex-wrap gap-1.5 px-2" data-testid="suggestion-sources">
          <li
            v-for="slot in side.slots"
            :key="slot"
            class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] font-medium"
          >
            {{ $t(describeSuggestionSlot({ slot }).key) }}
            <template v-if="describeSuggestionSlot({ slot }).stageKey">
              · {{ $t(describeSuggestionSlot({ slot }).stageKey!) }}
            </template>
          </li>
        </ul>
      </div>
    </div>
  </Card>
</template>
