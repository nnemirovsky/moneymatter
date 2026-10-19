<template>
  <section class="flex flex-col gap-4" data-testid="card-links">
    <div
      class="flex flex-col gap-4 @lg/integrations:flex-row @lg/integrations:items-start @lg/integrations:justify-between"
    >
      <div class="max-w-xl">
        <h3 class="mb-2 text-lg font-medium">{{ $t(`${LABEL_ROOT}.title`) }}</h3>
        <p class="text-muted-foreground text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.description`) }}</p>
      </div>

      <Button class="shrink-0" data-testid="card-link-add" @click="openCreate">
        <PlusIcon class="size-4" />
        {{ $t(`${LABEL_ROOT}.add`) }}
      </Button>
    </div>

    <div v-if="isLoading" class="flex flex-col gap-3" data-testid="card-links-loading">
      <div v-for="i in 2" :key="i" class="border-border flex items-center justify-between rounded-lg border p-4">
        <div class="flex-1 space-y-2">
          <div class="bg-muted/50 h-5 w-32 animate-pulse rounded" />
          <div class="bg-muted/30 h-3 w-24 animate-pulse rounded" />
        </div>
        <div class="bg-muted/40 h-8 w-20 animate-pulse rounded" />
      </div>
    </div>

    <Callout v-else-if="isError" variant="destructive" data-testid="card-links-error">
      {{ $t(`${LABEL_ROOT}.loadError`) }}
    </Callout>

    <div
      v-else-if="!mappings.length"
      class="text-muted-foreground flex flex-col items-center gap-1 py-8 text-center text-sm"
      data-testid="card-links-empty"
    >
      <CreditCardIcon class="mb-2 size-8" />
      <p class="text-foreground font-medium">{{ $t(`${LABEL_ROOT}.empty.title`) }}</p>
      <p class="max-w-sm">{{ $t(`${LABEL_ROOT}.empty.description`) }}</p>
    </div>

    <ul v-else class="flex flex-col gap-3">
      <li
        v-for="mapping in mappings"
        :key="mapping.id"
        class="border-border flex flex-col gap-3 rounded-lg border p-4 @lg/integrations:flex-row @lg/integrations:items-center @lg/integrations:justify-between"
        data-testid="card-link-row"
      >
        <div class="min-w-0 flex-1">
          <div class="font-medium break-words" data-testid="card-link-label-text">{{ mapping.cardLabel }}</div>
          <div class="text-muted-foreground mt-1 text-sm" data-testid="card-link-account-name">
            {{ accountName({ accountId: mapping.accountId }) }}
          </div>
        </div>

        <div class="flex gap-2 self-start @lg/integrations:self-center">
          <Button
            variant="outline"
            size="sm"
            :aria-label="$t(`${LABEL_ROOT}.editAria`, { name: mapping.cardLabel })"
            data-testid="card-link-edit"
            @click="openEdit({ mapping })"
          >
            {{ $t(`${LABEL_ROOT}.edit`) }}
          </Button>
          <Button
            variant="soft-destructive"
            size="sm"
            :aria-label="$t(`${LABEL_ROOT}.deleteAria`, { name: mapping.cardLabel })"
            :disabled="isDeleting"
            data-testid="card-link-delete"
            @click="askToDelete({ mapping })"
          >
            {{ $t(`${LABEL_ROOT}.delete`) }}
          </Button>
        </div>
      </li>
    </ul>
  </section>

  <CardLinkDialog v-model:open="isDialogOpen" :mapping="editTarget" />

  <ResponsiveAlertDialog
    v-model:open="isDeleteOpen"
    :confirm-label="$t(`${LABEL_ROOT}.deleteDialog.confirm`)"
    confirm-variant="destructive"
    @confirm="confirmDelete"
  >
    <template #title>{{ $t(`${LABEL_ROOT}.deleteDialog.title`) }}</template>
    <template #description>
      {{ $t(`${LABEL_ROOT}.deleteDialog.description`, { name: deleteTarget?.cardLabel ?? '' }) }}
    </template>
  </ResponsiveAlertDialog>
</template>

<script setup lang="ts">
import { deleteCardMapping, getCardMappings } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import ResponsiveAlertDialog from '@/components/common/responsive-alert-dialog.vue';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { useInvalidatingMutation } from '@/composable/data-queries/use-invalidating-mutation';
import { useAccountsStore } from '@/stores/accounts';
import type { CardMappingDto } from '@bt/shared/types';
import { CreditCardIcon, PlusIcon } from '@lucide/vue';
import { useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import CardLinkDialog from './card-link-dialog.vue';

defineOptions({
  name: 'settings-integrations-card-links',
});

const LABEL_ROOT = 'settings.integrations.applePay.cardLinks';

const { t } = useI18n({ useScope: 'global' });
const accountsStore = useAccountsStore();

const isDialogOpen = ref(false);
const editTarget = ref<CardMappingDto | null>(null);
const isDeleteOpen = ref(false);
const deleteTarget = ref<CardMappingDto | null>(null);

const { data, isLoading, isError } = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.cardMappings,
  queryFn: getCardMappings,
});

const mappings = computed(() => data.value ?? []);

const accountName = ({ accountId }: { accountId: CardMappingDto['accountId'] }) =>
  accountsStore.accountsRecord?.[accountId]?.name ?? t(`${LABEL_ROOT}.accountMissing`);

const { mutateAsync: remove, isPending: isDeleting } = useInvalidatingMutation({
  mutationFn: (mapping: CardMappingDto) => deleteCardMapping({ id: mapping.id }),
  invalidateKeys: [VUE_QUERY_CACHE_KEYS.cardMappings, VUE_QUERY_CACHE_KEYS.unlinkedCards],
  successKey: `${LABEL_ROOT}.deleteDialog.success`,
  errorKey: `${LABEL_ROOT}.deleteDialog.error`,
});

const openCreate = () => {
  editTarget.value = null;
  isDialogOpen.value = true;
};

const openEdit = ({ mapping }: { mapping: CardMappingDto }) => {
  editTarget.value = mapping;
  isDialogOpen.value = true;
};

const askToDelete = ({ mapping }: { mapping: CardMappingDto }) => {
  deleteTarget.value = mapping;
  isDeleteOpen.value = true;
};

const confirmDelete = async () => {
  const mapping = deleteTarget.value;
  if (!mapping) return;

  try {
    await remove(mapping);
  } catch {
    // useInvalidatingMutation already told the user what failed.
  } finally {
    isDeleteOpen.value = false;
    deleteTarget.value = null;
  }
};
</script>
