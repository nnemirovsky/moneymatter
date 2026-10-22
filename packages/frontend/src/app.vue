<template>
  <main class="bg-background">
    <router-view />

    <base-currency-change-overlay />
    <restore-in-progress-overlay />
    <import-batch-delete-overlay />
    <notification-toaster />
    <update-available-banner />
  </main>
</template>

<script setup lang="ts">
import BaseCurrencyChangeOverlay from '@/components/common/base-currency-change-overlay.vue';
import ImportBatchDeleteOverlay from '@/components/common/import-batch-delete-overlay.vue';
import RestoreInProgressOverlay from '@/components/common/restore-in-progress-overlay.vue';
import UpdateAvailableBanner from '@/components/common/update-available-banner.vue';
import NotificationToaster from '@/components/notification-center/notification-toaster.vue';
import { useExchangeRates } from '@/composable/data-queries/currencies';
import { useUserSettings } from '@/composable/data-queries/user-settings';
import { useAiCategorizationEvents } from '@/composable/use-ai-categorization-events';
import { useSSE } from '@/composable/use-sse';
import { useDeviceTimeZoneSync } from '@/composable/use-device-time-zone-sync';
import { currencyDisplayPreference } from '@/js/helpers';
import { deviceTimeZone, hourCyclePreference, resolveViewingTimeZone, viewingTimeZone } from '@/js/helpers/time-zone';
import { ROUTES_NAMES } from '@/routes';
import { useAuthStore, useCurrenciesStore, useRootStore } from '@/stores';
import { storeToRefs } from 'pinia';
import { watch } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const authStore = useAuthStore();
const rootStore = useRootStore();
const userCurrenciesStore = useCurrenciesStore();

const { isAppInitialized } = storeToRefs(rootStore);
const { isLoggedIn } = storeToRefs(authStore);
const { isBaseCurrencyExists } = storeToRefs(userCurrenciesStore);

// Prefetch exchange rates for components that need them
useExchangeRates({ enabled: isLoggedIn });

const { data: userSettings, patchAsync: patchUserSettings } = useUserSettings({ enabled: isLoggedIn });
watch(
  () => userSettings.value?.currencyDisplay,
  (value) => {
    currencyDisplayPreference.value = value ?? 'symbol';
  },
  { immediate: true },
);

watch(
  () => [userSettings.value?.timeZone, userSettings.value?.timeZoneSource] as const,
  () => {
    viewingTimeZone.value = resolveViewingTimeZone({ settings: userSettings.value, deviceZone: deviceTimeZone() });
  },
  { immediate: true },
);
watch(
  () => userSettings.value?.hourCycle,
  (value) => {
    hourCyclePreference.value = value ?? null;
  },
  { immediate: true },
);
useDeviceTimeZoneSync({ settings: userSettings, patch: patchUserSettings });

// SSE for real-time updates
const { disconnect: disconnectSSE } = useSSE();
const { initialize: initializeAiCategorizationEvents, cleanup: cleanupAiCategorizationEvents } =
  useAiCategorizationEvents();

watch(
  isLoggedIn,
  (value, prevValue) => {
    if (prevValue && !value) {
      // User logged out - cleanup SSE
      cleanupAiCategorizationEvents();
      disconnectSSE();
      router.push({ name: ROUTES_NAMES.signIn });
    }
  },
  { immediate: true },
);

watch(
  isLoggedIn,
  async (value) => {
    if (value) {
      await rootStore.fetchInitialData();

      // Initialize SSE for real-time updates (AI categorization, etc.)
      initializeAiCategorizationEvents();
    }
  },
  { immediate: true },
);

watch(isAppInitialized, (value) => {
  if (value && !isBaseCurrencyExists.value) {
    router.push({ name: ROUTES_NAMES.welcome });
  }
});
</script>
