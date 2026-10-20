<template>
  <section v-if="isError || sources.length" class="flex flex-col gap-4" data-testid="pending-sources">
    <div class="max-w-xl">
      <h3 class="mb-2 text-lg font-medium">{{ $t(`${LABEL_ROOT}.title`) }}</h3>
      <p class="text-muted-foreground text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.description`) }}</p>
    </div>

    <Callout v-if="isError" variant="destructive" data-testid="pending-sources-error">
      {{ $t(`${LABEL_ROOT}.loadError`) }}
    </Callout>

    <ul v-else class="flex flex-col gap-3">
      <li
        v-for="source in sources"
        :key="source.id"
        class="border-border flex flex-col gap-3 rounded-lg border p-4 @lg/integrations:flex-row @lg/integrations:items-center @lg/integrations:justify-between"
        data-testid="pending-source-row"
      >
        <div class="min-w-0 flex-1">
          <span class="font-medium break-words" data-testid="pending-source-name">
            {{ getSourceName({ source, fallback: $t(`${LABEL_ROOT}.unknownApp`) }) }}
          </span>
          <p v-if="source.sender" class="text-muted-foreground mt-1 text-sm break-words">
            {{ $t(`${LABEL_ROOT}.sender`, { sender: source.sender }) }}
          </p>
        </div>

        <div class="flex gap-2 self-start @lg/integrations:self-center">
          <Button
            size="sm"
            :disabled="isUpdating"
            :aria-label="$t(`${LABEL_ROOT}.approveAria`, { name: getSourceName({ source, fallback: '' }) })"
            data-testid="pending-source-approve"
            @click="setMode({ source, mode: 'approved' })"
          >
            {{ $t(`${LABEL_ROOT}.approve`) }}
          </Button>
          <Button
            variant="soft-destructive"
            size="sm"
            :disabled="isUpdating"
            :aria-label="$t(`${LABEL_ROOT}.muteAria`, { name: getSourceName({ source, fallback: '' }) })"
            data-testid="pending-source-mute"
            @click="setMode({ source, mode: 'muted' })"
          >
            {{ $t(`${LABEL_ROOT}.mute`) }}
          </Button>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { getNotificationSources, updateNotificationSource } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { useInvalidatingMutation } from '@/composable/data-queries/use-invalidating-mutation';
import type { NotificationSourceDto } from '@bt/shared/types';
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';

import { getSourceName } from '../notification-sources';

defineOptions({
  name: 'settings-integrations-pending-sources',
});

const LABEL_ROOT = 'settings.integrations.iosAutomation.pending';

const { data, isError } = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.notificationSources,
  queryFn: getNotificationSources,
});

const sources = computed(() => (data.value ?? []).filter((source) => source.mode === 'pending'));

// Approving releases the requests held for the source and muting deletes their text, so both lists refresh.
const { mutateAsync: update, isPending: isUpdating } = useInvalidatingMutation({
  mutationFn: (variables: { id: NotificationSourceDto['id']; mode: 'approved' | 'muted' }) =>
    updateNotificationSource(variables),
  invalidateKeys: [VUE_QUERY_CACHE_KEYS.notificationSources, VUE_QUERY_CACHE_KEYS.cardPaymentRequests],
  errorKey: `${LABEL_ROOT}.saveError`,
});

const setMode = async ({ source, mode }: { source: NotificationSourceDto; mode: 'approved' | 'muted' }) => {
  try {
    await update({ id: source.id, mode });
  } catch {
    // useInvalidatingMutation already told the user what failed.
  }
};
</script>
