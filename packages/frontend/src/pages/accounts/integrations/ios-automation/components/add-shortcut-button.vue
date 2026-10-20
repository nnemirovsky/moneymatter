<template>
  <Button v-if="href" as-child variant="outline" :data-testid="`add-shortcut-${shortcut}`">
    <a
      :href="href"
      :target="isExternal ? '_blank' : undefined"
      :download="isDownload ? source.downloadName : undefined"
      rel="noopener noreferrer"
      @click="handleClick"
    >
      <SmartphoneIcon class="size-4" />
      {{ $t(`${LABEL_ROOT}.${shortcut}.addShortcut`) }}
    </a>
  </Button>
</template>

<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import { SmartphoneIcon } from '@lucide/vue';
import { computed } from 'vue';

import {
  getShortcutSource,
  isShortcutFileHref,
  isStandalone,
  openShortcutLink,
  type ShortcutKind,
} from '../ios-automation';
import { useShortcutLink } from '../composables/use-shortcut-link';

const LABEL_ROOT = 'settings.integrations.iosAutomation.setup';

const props = defineProps<{
  /** `payments` is the iOS 27 shortcut with the built-in triggers, `tap` the Wallet tap shortcut for iOS 26 and earlier. */
  shortcut: ShortcutKind;
}>();

const source = getShortcutSource({ shortcut: props.shortcut });
const { href } = useShortcutLink({ filePath: source.filePath, icloudUrl: source.icloudUrl });

/**
 * A home-screen web app cannot hand a download to Shortcuts and a plain link would navigate away
 * from the app, so there the click opens the link in the system browser sheet instead.
 */
const isInStandaloneApp = isStandalone();

const isFile = computed(() => !!href.value && isShortcutFileHref({ href: href.value, filePath: source.filePath }));
const isExternal = computed(() => !isFile.value);
const isDownload = computed(() => isFile.value && !isInStandaloneApp);

const handleClick = (event: MouseEvent) => {
  if (!isInStandaloneApp || !href.value) return;

  event.preventDefault();
  openShortcutLink({ href: href.value, filePath: source.filePath });
};
</script>
