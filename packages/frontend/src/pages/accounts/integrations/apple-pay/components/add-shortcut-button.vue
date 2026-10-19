<template>
  <Button v-if="href" as-child variant="outline" data-testid="add-shortcut">
    <a
      :href="href"
      :target="isExternal ? '_blank' : undefined"
      :download="isExternal ? undefined : CARD_PAYMENT_SHORTCUT_DOWNLOAD_NAME"
      rel="noopener noreferrer"
    >
      <SmartphoneIcon class="size-4" />
      {{ $t('settings.integrations.applePay.setup.addShortcut') }}
    </a>
  </Button>
</template>

<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import { SmartphoneIcon } from '@lucide/vue';
import { computed } from 'vue';

import { CARD_PAYMENT_SHORTCUT_DOWNLOAD_NAME, CARD_PAYMENT_SHORTCUT_FILE_PATH } from '../apple-pay';
import { useShortcutLink } from '../composables/use-shortcut-link';

const { href } = useShortcutLink();

/** The signed file is served as a download by the frontend's nginx; only the iCloud link leaves the app. */
const isExternal = computed(() => href.value !== CARD_PAYMENT_SHORTCUT_FILE_PATH);
</script>
