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
import { useNotificationCenter } from '@/components/notification-center';
import { SmartphoneIcon } from '@lucide/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import {
  canShareShortcutFile,
  getShortcutSource,
  isShortcutFileHref,
  isStandalone,
  openShortcutLink,
  shareShortcutFile,
  type ShortcutKind,
} from '../ios-automation';
import { useShortcutFile, useShortcutLink } from '../composables/use-shortcut-link';

const LABEL_ROOT = 'settings.integrations.iosAutomation.setup';

const props = defineProps<{
  /** `payments` is the iOS 27 shortcut with the built-in triggers, `tap` the Wallet tap shortcut for iOS 26 and earlier. */
  shortcut: ShortcutKind;
}>();

const source = getShortcutSource({ shortcut: props.shortcut });
const { href } = useShortcutLink({
  filePath: source.filePath,
  icloudUrl: source.icloudUrl,
});

const { t } = useI18n({ useScope: 'global' });
const { addErrorNotification } = useNotificationCenter();

/**
 * A home-screen web app cannot hand a download to Shortcuts and a plain link would navigate away
 * from the app. Its in-app browser sheet does not take attachment downloads either, so the click
 * shares the already-fetched file through the share sheet when the browser can; only a browser that
 * cannot falls back to the system browser sheet there.
 */
const isInStandaloneApp = isStandalone();

const isFile = computed(() => !!href.value && isShortcutFileHref({ href: href.value, filePath: source.filePath }));
const isExternal = computed(() => !isFile.value);
const isDownload = computed(() => isFile.value && !isInStandaloneApp);

const { file } = useShortcutFile({
  filePath: source.filePath,
  downloadName: source.downloadName,
  enabled: isFile,
});

const share = async ({ shareable }: { shareable: File }) => {
  try {
    await shareShortcutFile({ file: shareable });
  } catch {
    addErrorNotification(t(`${LABEL_ROOT}.shareShortcutError`));
  }
};

const handleClick = (event: MouseEvent) => {
  // The share has to start inside this handler for the tap's activation to count, so the file is
  // fetched ahead of time and a tap before it arrives takes the link path below.
  const loadedFile = file.value;
  if (isFile.value && loadedFile && canShareShortcutFile({ file: loadedFile })) {
    event.preventDefault();
    void share({ shareable: loadedFile });
    return;
  }

  if (!isInStandaloneApp || !href.value) return;

  event.preventDefault();
  openShortcutLink({ href: href.value, filePath: source.filePath });
};
</script>
