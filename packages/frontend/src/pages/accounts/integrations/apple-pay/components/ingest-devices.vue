<template>
  <div class="flex flex-col gap-6">
    <div
      class="flex flex-col gap-4 @lg/integrations:flex-row @lg/integrations:items-start @lg/integrations:justify-between"
    >
      <div class="max-w-xl">
        <h3 class="mb-2 text-lg font-medium">{{ $t(`${LABEL_ROOT}.title`) }}</h3>
        <p class="text-muted-foreground text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.description`) }}</p>
      </div>

      <Button class="shrink-0" data-testid="ingest-token-create" @click="isCreateOpen = true">
        <PlusIcon class="size-4" />
        {{ $t(`${LABEL_ROOT}.createButton`) }}
      </Button>
    </div>

    <div v-if="isLoading" class="flex flex-col gap-3" data-testid="ingest-tokens-loading">
      <div v-for="i in 2" :key="i" class="border-border flex items-center justify-between rounded-lg border p-4">
        <div class="flex-1 space-y-2">
          <div class="bg-muted/50 h-5 w-36 animate-pulse rounded" />
          <div class="bg-muted/30 h-3 w-28 animate-pulse rounded" />
          <div class="bg-muted/30 h-3 w-56 animate-pulse rounded" />
        </div>
        <div class="bg-muted/40 h-8 w-20 animate-pulse rounded" />
      </div>
    </div>

    <Callout v-else-if="isError" variant="destructive" data-testid="ingest-tokens-error">
      {{ $t(`${LABEL_ROOT}.loadError`) }}
    </Callout>

    <div
      v-else-if="!tokens.length"
      class="text-muted-foreground flex flex-col items-center gap-1 py-8 text-center text-sm"
      data-testid="ingest-tokens-empty"
    >
      <KeyRoundIcon class="mb-2 size-8" />
      <p class="text-foreground font-medium">{{ $t(`${LABEL_ROOT}.empty.title`) }}</p>
      <p class="mb-3 max-w-sm">{{ $t(`${LABEL_ROOT}.empty.description`) }}</p>
      <Button variant="outline" @click="isCreateOpen = true">
        <PlusIcon class="size-4" />
        {{ $t(`${LABEL_ROOT}.createButton`) }}
      </Button>
    </div>

    <ul v-else class="flex flex-col gap-3">
      <li
        v-for="token in tokens"
        :key="token.id"
        class="border-border flex flex-col gap-3 rounded-lg border p-4 @lg/integrations:flex-row @lg/integrations:items-center @lg/integrations:justify-between"
        data-testid="ingest-token-row"
      >
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="font-medium break-words">{{ token.name }}</span>
            <code class="text-muted-foreground font-mono text-xs">{{ formatTokenStart({ start: token.start }) }}</code>
          </div>

          <dl class="text-muted-foreground mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt>{{ $t(`${LABEL_ROOT}.fields.scope`) }}</dt>
            <dd class="text-foreground" data-testid="ingest-token-scope">
              {{ formatScopes({ scopes: token.scopes }) }}
            </dd>

            <dt>{{ $t(`${LABEL_ROOT}.fields.lastUsed`) }}</dt>
            <dd class="text-foreground" data-testid="ingest-token-last-used">
              {{
                token.lastUsedAt
                  ? formatDistanceToNow(new Date(token.lastUsedAt), { addSuffix: true })
                  : $t(`${LABEL_ROOT}.never`)
              }}
            </dd>

            <dt>{{ $t(`${LABEL_ROOT}.fields.created`) }}</dt>
            <dd class="text-foreground" data-testid="ingest-token-created">{{ format(token.createdAt, 'PP') }}</dd>

            <template v-if="token.expiresAt">
              <dt>{{ $t(`${LABEL_ROOT}.fields.expires`) }}</dt>
              <dd class="text-foreground" data-testid="ingest-token-expires">{{ format(token.expiresAt, 'PP') }}</dd>
            </template>
          </dl>
        </div>

        <Button
          variant="soft-destructive"
          size="sm"
          class="self-start @lg/integrations:self-center"
          :aria-label="$t(`${LABEL_ROOT}.revoke.buttonAria`, { name: token.name })"
          :disabled="isRevoking"
          data-testid="ingest-token-revoke"
          @click="askToRevoke({ token })"
        >
          {{ $t(`${LABEL_ROOT}.revoke.button`) }}
        </Button>
      </li>
    </ul>
  </div>

  <CreateTokenDialog v-model:open="isCreateOpen" />

  <ResponsiveAlertDialog
    v-model:open="isRevokeOpen"
    :confirm-label="$t(`${LABEL_ROOT}.revoke.confirm`)"
    confirm-variant="destructive"
    @confirm="confirmRevoke"
  >
    <template #title>{{ $t(`${LABEL_ROOT}.revoke.title`) }}</template>
    <template #description>
      {{ $t(`${LABEL_ROOT}.revoke.description`, { name: revokeTarget?.name ?? '' }) }}
    </template>
  </ResponsiveAlertDialog>
</template>

<script setup lang="ts">
import { getIngestTokens, revokeIngestToken } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import ResponsiveAlertDialog from '@/components/common/responsive-alert-dialog.vue';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { useInvalidatingMutation } from '@/composable/data-queries/use-invalidating-mutation';
import { useDateLocale } from '@/composable/use-date-locale';
import type { IngestTokenDto } from '@bt/shared/types';
import { KeyRoundIcon, PlusIcon } from '@lucide/vue';
import { useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import CreateTokenDialog from './create-token-dialog.vue';
import { formatTokenStart, getIngestScopeLabelKey } from '../ingest-tokens';

defineOptions({
  name: 'apple-pay-ingest-devices',
});

const LABEL_ROOT = 'settings.integrations.ingestTokens';

const { t } = useI18n({ useScope: 'global' });
const { format, formatDistanceToNow } = useDateLocale();

const isCreateOpen = ref(false);
const isRevokeOpen = ref(false);
const revokeTarget = ref<IngestTokenDto | null>(null);

const { data, isLoading, isError } = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.ingestTokens,
  queryFn: getIngestTokens,
});

const tokens = computed(() => data.value ?? []);

const { mutateAsync: revoke, isPending: isRevoking } = useInvalidatingMutation({
  mutationFn: (token: IngestTokenDto) => revokeIngestToken({ id: token.id }),
  invalidateKeys: [VUE_QUERY_CACHE_KEYS.ingestTokens],
  successKey: `${LABEL_ROOT}.revoke.success`,
  errorKey: `${LABEL_ROOT}.revoke.error`,
});

const formatScopes = ({ scopes }: { scopes: string[] }) =>
  scopes
    .map((scope) => {
      const labelKey = getIngestScopeLabelKey({ scope });
      return labelKey ? t(labelKey) : scope;
    })
    .join(', ');

const askToRevoke = ({ token }: { token: IngestTokenDto }) => {
  revokeTarget.value = token;
  isRevokeOpen.value = true;
};

const confirmRevoke = async () => {
  const token = revokeTarget.value;
  if (!token) return;

  try {
    await revoke(token);
  } catch {
    // useInvalidatingMutation already told the user what failed.
  } finally {
    isRevokeOpen.value = false;
    revokeTarget.value = null;
  }
};
</script>
