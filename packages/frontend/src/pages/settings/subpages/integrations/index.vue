<template>
  <Card class="@container/integrations max-w-4xl">
    <CardHeader class="border-b">
      <h2 class="mb-2 text-2xl font-semibold">{{ $t('settings.integrations.title') }}</h2>
      <p class="text-sm opacity-80">{{ $t('settings.integrations.description') }}</p>
    </CardHeader>

    <CardContent class="mt-6 flex flex-col gap-6">
      <RouterTabs :items="tabs" />

      <router-view />
    </CardContent>
  </Card>
</template>

<script setup lang="ts">
import { Card, CardContent, CardHeader } from '@/components/lib/ui/card';
import { type RouterTabItem, RouterTabs } from '@/components/lib/ui/router-tabs';
import { ROUTES_NAMES } from '@/routes';
import { KeyRoundIcon } from '@lucide/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

defineOptions({
  name: 'settings-integrations',
});

const { t } = useI18n();

const tabs = computed<RouterTabItem[]>(() => [
  {
    value: ROUTES_NAMES.settingsIntegrationsIngestTokens,
    label: t('settings.integrations.tabs.ingestTokens'),
    icon: KeyRoundIcon,
  },
]);
</script>
