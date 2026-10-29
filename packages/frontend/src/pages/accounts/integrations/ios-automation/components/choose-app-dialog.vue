<template>
  <ResponsiveDialog :open="open" dialog-content-class="max-w-md" @update:open="emit('update:open', $event)">
    <template #title>{{ $t(`${LABEL_ROOT}.title`) }}</template>
    <template #description>{{ $t(`${LABEL_ROOT}.description`) }}</template>

    <div class="grid gap-4" data-testid="choose-app-dialog">
      <InputField
        v-model="term"
        :label="$t(`${LABEL_ROOT}.searchLabel`)"
        :placeholder="$t(`${LABEL_ROOT}.searchPlaceholder`)"
        data-testid="choose-app-search"
      />

      <SelectField
        :model-value="selectedStorefront"
        :values="storefrontOptions"
        :label="$t(`${LABEL_ROOT}.storefrontLabel`)"
        with-search
        :search-keys="['label']"
        data-testid="choose-app-storefront"
        @update:model-value="storefront = $event?.value ?? null"
      />

      <p v-if="isError" class="text-destructive-text text-sm" data-testid="choose-app-error">
        {{ $t(`${LABEL_ROOT}.searchError`) }}
      </p>
      <p v-else-if="!canSearch" class="text-muted-foreground text-sm" data-testid="choose-app-hint">
        {{ $t(`${LABEL_ROOT}.hint`) }}
      </p>
      <p v-else-if="!isFetching && !apps.length" class="text-muted-foreground text-sm" data-testid="choose-app-empty">
        {{ $t(`${LABEL_ROOT}.empty`) }}
      </p>

      <ul v-if="apps.length" class="-mx-1 flex max-h-72 flex-col overflow-y-auto" data-testid="choose-app-results">
        <li v-for="app in apps" :key="app.bundleId">
          <button
            type="button"
            class="hover:bg-muted focus-visible:ring-ring/40 flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
            :disabled="isSaving"
            :aria-label="$t(`${LABEL_ROOT}.pickAria`, { name: app.name })"
            data-testid="choose-app-result"
            @click="choose({ app })"
          >
            <AppIcon :app-name="app.name" :bundle-id="app.bundleId" :icon-url="app.iconUrl" :size="36" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ app.name }}</span>
              <span v-if="app.developer" class="text-muted-foreground block truncate text-xs">{{ app.developer }}</span>
            </span>
          </button>
        </li>
      </ul>
    </div>

    <template #footer>
      <div class="flex w-full justify-between gap-2">
        <Button
          v-if="source?.iconOverride"
          type="button"
          variant="outline"
          :disabled="isSaving"
          data-testid="choose-app-reset"
          @click="reset"
        >
          {{ $t(`${LABEL_ROOT}.reset`) }}
        </Button>
        <span v-else />
        <Button type="button" variant="outline" :disabled="isSaving" @click="emit('update:open', false)">
          {{ $t('common.actions.cancel') }}
        </Button>
      </div>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { chooseSourceApp, resetSourceApp, searchSourceApps } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import AppIcon from '@/components/common/app-icon.vue';
import ResponsiveDialog from '@/components/common/responsive-dialog.vue';
import InputField from '@/components/fields/input-field.vue';
import SelectField from '@/components/fields/select-field.vue';
import { Button } from '@/components/lib/ui/button';
import { useInvalidatingMutation } from '@/composable/data-queries/use-invalidating-mutation';
import { APP_STORE_STOREFRONTS, type AppStoreAppDto, type NotificationSourceDto } from '@bt/shared/types';
import { useQuery } from '@tanstack/vue-query';
import { refDebounced } from '@vueuse/core';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const LABEL_ROOT = 'settings.integrations.iosAutomation.sources.chooseApp';
const MIN_TERM_LENGTH = 2;

const props = defineProps<{
  open: boolean;
  /** The source whose app is chosen. */
  source: NotificationSourceDto | null;
}>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const { locale } = useI18n({ useScope: 'global' });

const term = ref('');
const storefront = ref<string | null>(null);
const debouncedTerm = refDebounced(term, 400);

// Each time the dialog opens it starts from the app name the source has, in the user's own storefront.
watch(
  () => [props.open, props.source?.id] as const,
  ([open]) => {
    if (!open) return;
    term.value = props.source?.appName ?? '';
    storefront.value = null;
  },
  { immediate: true },
);

const canSearch = computed(() => debouncedTerm.value.trim().length >= MIN_TERM_LENGTH);

const { data, isError, isFetching } = useQuery({
  queryKey: [...VUE_QUERY_CACHE_KEYS.notificationSources, 'app-search', debouncedTerm, storefront],
  queryFn: () => searchSourceApps({ term: debouncedTerm.value.trim(), storefront: storefront.value }),
  enabled: computed(() => props.open && canSearch.value),
  staleTime: 5 * 60 * 1000,
  retry: false,
});

const apps = computed(() => (canSearch.value ? (data.value?.apps ?? []) : []));

const storefrontOptions = computed(() => {
  const names = new Intl.DisplayNames([locale.value], { type: 'region' });

  return APP_STORE_STOREFRONTS.map((code) => ({ value: code, label: `${names.of(code.toUpperCase()) ?? code}` }));
});
const selectedStorefront = computed(() => {
  const code = storefront.value ?? data.value?.storefront ?? null;

  return storefrontOptions.value.find((option) => option.value === code) ?? null;
});

const close = () => emit('update:open', false);

const { mutateAsync: choose$, isPending: isChoosing } = useInvalidatingMutation({
  mutationFn: (variables: { id: NotificationSourceDto['id']; bundleId: string; storefront: string }) =>
    chooseSourceApp(variables),
  invalidateKeys: [VUE_QUERY_CACHE_KEYS.notificationSources],
  successKey: `${LABEL_ROOT}.saved`,
  errorKey: `${LABEL_ROOT}.saveError`,
});

const { mutateAsync: reset$, isPending: isResetting } = useInvalidatingMutation({
  mutationFn: (variables: { id: NotificationSourceDto['id'] }) => resetSourceApp(variables),
  invalidateKeys: [VUE_QUERY_CACHE_KEYS.notificationSources],
  successKey: `${LABEL_ROOT}.resetDone`,
  errorKey: `${LABEL_ROOT}.saveError`,
});

const isSaving = computed(() => isChoosing.value || isResetting.value);

const choose = async ({ app }: { app: AppStoreAppDto }) => {
  if (!props.source) return;

  try {
    await choose$({
      id: props.source.id,
      bundleId: app.bundleId,
      storefront: storefront.value ?? data.value?.storefront ?? 'us',
    });
    close();
  } catch {
    // useInvalidatingMutation already told the user what failed.
  }
};

const reset = async () => {
  if (!props.source) return;

  try {
    await reset$({ id: props.source.id });
    close();
  } catch {
    // useInvalidatingMutation already told the user what failed.
  }
};
</script>
