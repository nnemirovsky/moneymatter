<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import { Card } from '@/components/lib/ui/card';
import { ScrollArea } from '@/components/lib/ui/scroll-area';
import type { DuplicateSuggestionItem, RecordId, TransactionModel } from '@bt/shared/types';
import { SparklesIcon, TriangleAlertIcon } from '@lucide/vue';
import { computed, ref } from 'vue';

import { useDuplicateSuggestions, useReconciliationActions } from '../use-reconciliation';
import MergeDialog from './merge-dialog.vue';
import SuggestionCard from './suggestion-card.vue';

const SKELETON_ROW_COUNT = 3;
const I18N = 'optimizations.reconciliation.suggestions';

const { data, isFetched, isError, refetch } = useDuplicateSuggestions();
const { dismissSuggestion } = useReconciliationActions();

const items = computed(() => data.value ?? []);

const isMergeOpen = ref(false);
const mergeTargets = ref<TransactionModel[]>([]);
const mergeSurvivorId = ref<RecordId | undefined>(undefined);

const openMerge = ({ suggestion }: { suggestion: DuplicateSuggestionItem }) => {
  mergeTargets.value = [suggestion.transaction, suggestion.candidate];
  mergeSurvivorId.value = suggestion.suggestedSurvivorId;
  isMergeOpen.value = true;
};

const isDismissingRow = ({ id }: { id: RecordId }) =>
  dismissSuggestion.isPending.value && dismissSuggestion.variables.value?.suggestionId === id;
</script>

<template>
  <div class="flex min-h-0 w-full max-w-5xl flex-1 flex-col">
    <Card v-if="isError" class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <TriangleAlertIcon class="text-destructive-text size-8" />
      <p class="text-destructive-text text-sm">{{ $t(`${I18N}.loadError`) }}</p>
      <Button variant="outline" size="sm" @click="refetch()">{{ $t('common.actions.retry') }}</Button>
    </Card>

    <Card v-else-if="!isFetched" class="flex flex-col gap-2 p-3" data-testid="suggestions-skeleton">
      <div v-for="index in SKELETON_ROW_COUNT" :key="index" class="bg-muted h-28 animate-pulse rounded-md" />
    </Card>

    <Card
      v-else-if="!items.length"
      class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      data-testid="suggestions-empty"
    >
      <div class="bg-muted flex size-12 items-center justify-center rounded-full">
        <SparklesIcon class="text-muted-foreground size-6" />
      </div>
      <p class="font-medium">{{ $t(`${I18N}.emptyTitle`) }}</p>
      <p class="text-muted-foreground max-w-sm text-sm">{{ $t(`${I18N}.emptyDescription`) }}</p>
    </Card>

    <ScrollArea v-else class="min-h-0 flex-1">
      <div class="flex flex-col gap-4">
        <p class="text-muted-foreground text-sm">{{ $t(`${I18N}.intro`) }}</p>
        <SuggestionCard
          v-for="suggestion in items"
          :key="suggestion.id"
          :suggestion="suggestion"
          :is-dismissing="isDismissingRow({ id: suggestion.id })"
          @merge="openMerge({ suggestion })"
          @dismiss="dismissSuggestion.mutate({ suggestionId: suggestion.id })"
        />
      </div>
    </ScrollArea>

    <MergeDialog v-model:open="isMergeOpen" :transactions="mergeTargets" :default-survivor-id="mergeSurvivorId" />
  </div>
</template>
