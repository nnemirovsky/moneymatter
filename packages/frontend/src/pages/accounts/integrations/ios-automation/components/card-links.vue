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
        v-for="card in cards"
        :key="card.cardLabel"
        class="border-border flex flex-col gap-2 rounded-lg border p-4"
        data-testid="card-link-row"
      >
        <div
          class="flex flex-col gap-2 @lg/integrations:flex-row @lg/integrations:items-center @lg/integrations:justify-between"
        >
          <div class="min-w-0 font-medium break-words" data-testid="card-link-label-text">
            {{ card.cardLabel }}
            <span v-if="card.lastDigits" class="text-muted-foreground ml-1 text-sm font-normal">
              •••• {{ card.lastDigits }}
            </span>
          </div>

          <Button
            variant="outline"
            size="sm"
            :class="ACTIONS_WIDTH"
            :aria-label="$t(`${LABEL_ROOT}.addAccountAria`, { name: card.cardLabel })"
            data-testid="card-link-add-account"
            @click="openAddAccount({ card })"
          >
            <PlusIcon class="size-4" />
            {{ $t(`${LABEL_ROOT}.addAccount`) }}
          </Button>
        </div>

        <ul class="divide-border flex flex-col divide-y">
          <li
            v-for="mapping in card.mappings"
            :key="mapping.id"
            class="flex flex-col gap-2 py-2 first:pt-0 last:pb-0 @lg/integrations:flex-row @lg/integrations:items-center"
            data-testid="card-link-account-row"
          >
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <span class="flex shrink-0 items-center gap-1.5">
                <span :class="CHIP_CLASSES" data-testid="card-link-currency">
                  {{ mapping.currencyCode ?? $t(`${LABEL_ROOT}.defaultChip`) }}
                </span>
                <span
                  v-if="mapping.currencyCode === null && accountCurrency({ accountId: mapping.accountId })"
                  :class="CHIP_CLASSES"
                  data-testid="card-link-default-currency"
                >
                  {{ accountCurrency({ accountId: mapping.accountId }) }}
                </span>
              </span>
              <span class="text-muted-foreground min-w-0 flex-1 truncate text-sm" data-testid="card-link-account-name">
                {{ accountName({ accountId: mapping.accountId }) }}
              </span>
            </div>

            <div :class="cn('grid grid-cols-2 gap-2', ACTIONS_WIDTH)" data-testid="card-link-actions">
              <Button
                variant="outline"
                size="sm"
                :aria-label="$t(`${LABEL_ROOT}.editAria`, { name: rowName({ mapping }) })"
                data-testid="card-link-edit"
                @click="openEdit({ mapping })"
              >
                {{ $t(`${LABEL_ROOT}.edit`) }}
              </Button>
              <Button
                variant="soft-destructive"
                size="sm"
                :aria-label="$t(`${LABEL_ROOT}.deleteAria`, { name: rowName({ mapping }) })"
                :disabled="isDeleting"
                data-testid="card-link-delete"
                @click="askToDelete({ mapping })"
              >
                {{ $t(`${LABEL_ROOT}.delete`) }}
              </Button>
            </div>
          </li>
        </ul>

        <p
          v-if="!hasDefaultLink({ group: card })"
          class="text-muted-foreground text-xs"
          data-testid="card-link-no-default"
        >
          {{ $t(`${LABEL_ROOT}.noDefault`) }}
        </p>
      </li>
    </ul>
  </section>

  <CardLinkDialog
    v-model:open="isDialogOpen"
    :mapping="editTarget"
    :siblings="dialogSiblings"
    :lock-label="!!addTarget"
    :initial-label="addTarget?.cardLabel ?? ''"
  />

  <ResponsiveAlertDialog
    v-model:open="isDeleteOpen"
    :confirm-label="$t(`${LABEL_ROOT}.deleteDialog.confirm`)"
    confirm-variant="destructive"
    @confirm="confirmDelete"
  >
    <template #title>{{ $t(`${LABEL_ROOT}.deleteDialog.title`) }}</template>
    <template #description>
      {{ deleteDescription }}
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
import { cn } from '@/lib/utils';
import { useAccountsStore } from '@/stores/accounts';
import type { CardMappingDto } from '@bt/shared/types';
import { CreditCardIcon, PlusIcon } from '@lucide/vue';
import { useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { type CardLinkGroup, groupCardMappings, hasDefaultLink } from '../card-links';
import CardLinkDialog from './card-link-dialog.vue';

defineOptions({
  name: 'settings-integrations-card-links',
});

const LABEL_ROOT = 'settings.integrations.iosAutomation.cardLinks';

/**
 * One width for the Edit and Delete pair of a row and for the card's Add account button, so the
 * button above lines up with the pair below on a wide container; both fill the row on a narrow one.
 */
const ACTIONS_WIDTH = 'w-full @lg/integrations:w-52 @lg/integrations:shrink-0';
const CHIP_CLASSES =
  'border-border text-muted-foreground shrink-0 rounded-[5px] border px-1.5 py-px text-[10.5px] font-bold tracking-wider';

const { t } = useI18n({ useScope: 'global' });
const accountsStore = useAccountsStore();

const isDialogOpen = ref(false);
const editTarget = ref<CardMappingDto | null>(null);
/** The card a new account is being added to; `null` while a whole new card is linked. */
const addTarget = ref<CardLinkGroup | null>(null);
const isDeleteOpen = ref(false);
const deleteTarget = ref<CardMappingDto | null>(null);

const { data, isLoading, isError } = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.cardMappings,
  queryFn: getCardMappings,
});

const mappings = computed(() => data.value ?? []);
const cards = computed(() => groupCardMappings({ mappings: mappings.value }));

/** The rows of the card the dialog works on: its currencies are not offered again. */
const dialogSiblings = computed(() => addTarget.value?.mappings ?? []);

/** The row as the buttons name it: the card, and its currency when it has one. */
const rowName = ({ mapping }: { mapping: CardMappingDto }) =>
  mapping.currencyCode ? `${mapping.cardLabel} ${mapping.currencyCode}` : mapping.cardLabel;

const accountName = ({ accountId }: { accountId: CardMappingDto['accountId'] }) =>
  accountsStore.accountsRecord?.[accountId]?.name ?? t(`${LABEL_ROOT}.accountMissing`);

const accountCurrency = ({ accountId }: { accountId: CardMappingDto['accountId'] }): string | null =>
  accountsStore.accountsRecord?.[accountId]?.currencyCode ?? null;

const { mutateAsync: remove, isPending: isDeleting } = useInvalidatingMutation({
  mutationFn: (mapping: CardMappingDto) => deleteCardMapping({ id: mapping.id }),
  invalidateKeys: [VUE_QUERY_CACHE_KEYS.cardMappings, VUE_QUERY_CACHE_KEYS.unlinkedCards],
  successKey: `${LABEL_ROOT}.deleteDialog.success`,
  errorKey: `${LABEL_ROOT}.deleteDialog.error`,
});

const openCreate = () => {
  editTarget.value = null;
  addTarget.value = null;
  isDialogOpen.value = true;
};

const openAddAccount = ({ card }: { card: CardLinkGroup }) => {
  editTarget.value = null;
  addTarget.value = card;
  isDialogOpen.value = true;
};

const openEdit = ({ mapping }: { mapping: CardMappingDto }) => {
  editTarget.value = mapping;
  addTarget.value = null;
  isDialogOpen.value = true;
};

const deleteDescription = computed(() => {
  const mapping = deleteTarget.value;
  if (!mapping) return '';

  return mapping.currencyCode
    ? t(`${LABEL_ROOT}.deleteDialog.descriptionCurrency`, { name: mapping.cardLabel, currency: mapping.currencyCode })
    : t(`${LABEL_ROOT}.deleteDialog.description`, { name: mapping.cardLabel });
});

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
