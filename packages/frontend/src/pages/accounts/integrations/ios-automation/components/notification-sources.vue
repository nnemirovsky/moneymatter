<template>
  <section class="flex flex-col gap-4" data-testid="notification-sources">
    <div class="max-w-xl">
      <h3 class="mb-2 text-lg font-medium">{{ $t(`${LABEL_ROOT}.title`) }}</h3>
      <p class="text-muted-foreground text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.description`) }}</p>
    </div>

    <Callout v-if="isError" variant="destructive" data-testid="notification-sources-error">
      {{ $t(`${LABEL_ROOT}.loadError`) }}
    </Callout>

    <p
      v-else-if="!isLoading && !sources.length"
      class="text-muted-foreground text-sm"
      data-testid="notification-sources-empty"
    >
      {{ $t(`${LABEL_ROOT}.empty`) }}
    </p>

    <ul v-else class="flex flex-col gap-3">
      <li
        v-for="source in sources"
        :key="source.id"
        class="border-border flex flex-col gap-3 rounded-lg border p-4 @lg/integrations:flex-row @lg/integrations:items-center"
        data-testid="notification-source-row"
      >
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium break-words" data-testid="notification-source-name">
              {{ getSourceName({ source, fallback: $t(`${LABEL_ROOT}.unknownApp`) }) }}
            </span>
            <StatusBadge :variant="MODE_VARIANTS[source.mode]" data-testid="notification-source-mode">
              {{ $t(`${LABEL_ROOT}.modes.${source.mode}`) }}
            </StatusBadge>
          </div>
          <p v-if="source.sender" class="text-muted-foreground mt-1 text-sm break-words">
            {{ $t(`${LABEL_ROOT}.sender`, { sender: source.sender }) }}
          </p>
        </div>

        <!-- The picker is named for assistive tech instead of a visible label: a label above it would push it
             off the line the name and the buttons sit on. -->
        <div
          role="group"
          :aria-label="$t(`${LABEL_ROOT}.logTo`)"
          class="w-full @lg/integrations:w-64 @lg/integrations:shrink-0"
          data-testid="notification-source-log-to"
        >
          <AccountSelectField
            :model-value="defaultAccountOf({ source })"
            :accounts="mappableAccounts"
            :none-label="$t(`${LABEL_ROOT}.logToPlaceholder`)"
            :clearable="!!defaultAccountOf({ source })"
            :disabled="isBusy"
            @update:model-value="setDefaultAccount({ source, account: $event })"
          />
        </div>

        <!-- `md:h-9` is the picker's own height rule, so the buttons are as tall as the picker next to them. -->
        <div class="flex gap-2 @lg/integrations:shrink-0">
          <Button
            v-if="source.mode === 'muted'"
            variant="outline"
            class="md:h-9"
            :disabled="isBusy"
            :aria-label="$t(`${LABEL_ROOT}.approveAria`, { name: getSourceName({ source, fallback: '' }) })"
            data-testid="notification-source-approve"
            @click="setMode({ source, mode: 'approved' })"
          >
            {{ $t(`${LABEL_ROOT}.approve`) }}
          </Button>
          <Button
            v-else
            variant="outline"
            class="md:h-9"
            :disabled="isBusy"
            :aria-label="$t(`${LABEL_ROOT}.muteAria`, { name: getSourceName({ source, fallback: '' }) })"
            data-testid="notification-source-mute"
            @click="setMode({ source, mode: 'muted' })"
          >
            {{ $t(`${LABEL_ROOT}.mute`) }}
          </Button>
          <Button
            variant="soft-destructive"
            class="md:h-9"
            :disabled="isBusy"
            :aria-label="$t(`${LABEL_ROOT}.forgetAria`, { name: getSourceName({ source, fallback: '' }) })"
            data-testid="notification-source-forget"
            @click="askToForget({ source })"
          >
            {{ $t(`${LABEL_ROOT}.forget`) }}
          </Button>
        </div>
      </li>
    </ul>
  </section>

  <ResponsiveAlertDialog
    v-model:open="isForgetOpen"
    :confirm-label="$t(`${LABEL_ROOT}.forgetDialog.confirm`)"
    confirm-variant="destructive"
    @confirm="confirmForget"
  >
    <template #title>{{ $t(`${LABEL_ROOT}.forgetDialog.title`) }}</template>
    <template #description>
      {{
        $t(`${LABEL_ROOT}.forgetDialog.description`, {
          name: forgetTarget ? getSourceName({ source: forgetTarget, fallback: '' }) : '',
        })
      }}
    </template>
  </ResponsiveAlertDialog>
</template>

<script setup lang="ts">
import { deleteNotificationSource, getNotificationSources, updateNotificationSource } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import ResponsiveAlertDialog from '@/components/common/responsive-alert-dialog.vue';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { StatusBadge, type Variant } from '@/components/lib/ui/status-badge';
import { useInvalidatingMutation } from '@/composable/data-queries/use-invalidating-mutation';
import AccountSelectField from '@/components/fields/account-select-field.vue';
import { useAccountsStore } from '@/stores/accounts';
import type {
  AccountModel,
  NotificationSourceDto,
  NotificationSourceMode,
  UpdateNotificationSourcePayload,
} from '@bt/shared/types';
import { useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { getMappableAccounts } from '../ios-automation';
import { getSourceName } from '../notification-sources';

defineOptions({
  name: 'settings-integrations-notification-sources',
});

const LABEL_ROOT = 'settings.integrations.iosAutomation.sources';

const MODE_VARIANTS: Record<NotificationSourceMode, Variant> = {
  auto: 'info',
  pending: 'warning',
  approved: 'success',
  muted: 'destructive',
};

const { data, isLoading, isError } = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.notificationSources,
  queryFn: getNotificationSources,
});

/** The sources that already have an answer; the ones waiting for one are listed above, in their own section. */
const sources = computed(() => (data.value ?? []).filter((source) => source.mode !== 'pending'));

// Approving a source releases its held requests, so the request lists refresh with it.
const invalidateKeys = [VUE_QUERY_CACHE_KEYS.notificationSources, VUE_QUERY_CACHE_KEYS.cardPaymentRequests];

const { mutateAsync: update, isPending: isUpdating } = useInvalidatingMutation({
  mutationFn: (variables: { id: NotificationSourceDto['id'] } & UpdateNotificationSourcePayload) =>
    updateNotificationSource(variables),
  invalidateKeys,
  successMessage: (source) =>
    source.releasedCount ? t(`${LABEL_ROOT}.released`, { count: source.releasedCount }, source.releasedCount) : '',
  errorKey: `${LABEL_ROOT}.saveError`,
});

const { mutateAsync: forget, isPending: isForgetting } = useInvalidatingMutation({
  mutationFn: (source: NotificationSourceDto) => deleteNotificationSource({ id: source.id }),
  invalidateKeys,
  successKey: `${LABEL_ROOT}.forgetDialog.success`,
  errorKey: `${LABEL_ROOT}.forgetDialog.error`,
});

const { t } = useI18n({ useScope: 'global' });
const accountsStore = useAccountsStore();

/** The accounts a payment may be logged on: the ones the server accepts as a source default. */
const mappableAccounts = computed(() => getMappableAccounts({ accounts: accountsStore.accounts ?? [] }));

const defaultAccountOf = ({ source }: { source: NotificationSourceDto }): AccountModel | null =>
  mappableAccounts.value.find((account) => account.id === source.defaultAccountId) ?? null;

const isBusy = computed(() => isUpdating.value || isForgetting.value);

const isForgetOpen = ref(false);
const forgetTarget = ref<NotificationSourceDto | null>(null);

const setMode = async ({ source, mode }: { source: NotificationSourceDto; mode: 'approved' | 'muted' }) => {
  try {
    await update({ id: source.id, mode });
  } catch {
    // useInvalidatingMutation already told the user what failed.
  }
};

const setDefaultAccount = async ({
  source,
  account,
}: {
  source: NotificationSourceDto;
  account: AccountModel | null;
}) => {
  if ((account?.id ?? null) === source.defaultAccountId) return;

  try {
    await update({ id: source.id, defaultAccountId: account?.id ?? null });
  } catch {
    // useInvalidatingMutation already told the user what failed.
  }
};

const askToForget = ({ source }: { source: NotificationSourceDto }) => {
  forgetTarget.value = source;
  isForgetOpen.value = true;
};

const confirmForget = async () => {
  const source = forgetTarget.value;
  if (!source) return;

  try {
    await forget(source);
  } catch {
    // useInvalidatingMutation already told the user what failed.
  } finally {
    isForgetOpen.value = false;
    forgetTarget.value = null;
  }
};
</script>
