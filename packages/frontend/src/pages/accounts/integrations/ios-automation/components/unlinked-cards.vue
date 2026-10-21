<template>
  <section v-if="isError || cards.length" class="flex flex-col gap-4" data-testid="unlinked-cards">
    <div class="max-w-xl">
      <h3 class="mb-2 text-lg font-medium">{{ $t(`${LABEL_ROOT}.title`) }}</h3>
      <p class="text-muted-foreground text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.description`) }}</p>
    </div>

    <Callout v-if="isError" variant="destructive" data-testid="unlinked-cards-error">
      {{ $t(`${LABEL_ROOT}.loadError`) }}
    </Callout>

    <ul v-else class="flex flex-col gap-3">
      <li
        v-for="card in cards"
        :key="card.cardLabel"
        class="border-border flex flex-col gap-3 rounded-lg border p-4 @lg/integrations:flex-row @lg/integrations:items-center @lg/integrations:justify-between"
        data-testid="unlinked-card-row"
      >
        <div class="min-w-0 flex-1">
          <div class="font-medium break-words">{{ card.cardLabel }}</div>
          <div class="text-muted-foreground mt-1 text-sm" data-testid="unlinked-card-count">
            {{ $t(`${LABEL_ROOT}.count`, { count: card.count }) }}
          </div>
        </div>

        <Button
          size="sm"
          class="self-start @lg/integrations:self-center"
          :aria-label="$t(`${LABEL_ROOT}.linkAria`, { name: card.cardLabel })"
          data-testid="unlinked-card-link"
          @click="emit('link', { cardLabel: card.cardLabel, count: card.count, lastDigits: card.lastDigits })"
        >
          <LinkIcon class="size-4" />
          {{ $t(`${LABEL_ROOT}.link`) }}
        </Button>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { getUnlinkedCards } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { LinkIcon } from '@lucide/vue';
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';

defineOptions({
  name: 'settings-integrations-unlinked-cards',
});

const LABEL_ROOT = 'settings.integrations.iosAutomation.unlinked';

const emit = defineEmits<{ link: [card: { cardLabel: string; count: number; lastDigits: string | null }] }>();

const { data, isError } = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.unlinkedCards,
  queryFn: getUnlinkedCards,
});

const cards = computed(() => data.value ?? []);
</script>
