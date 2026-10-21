<template>
  <div v-if="href" class="grid gap-1.5">
    <Button
      as-child
      variant="outline"
      :class="fullWidth ? 'w-full' : 'justify-self-start'"
      :data-testid="`add-shortcut-${shortcut}`"
    >
      <a
        :href="href"
        :download="isInStandaloneApp ? undefined : source.downloadName"
        rel="noopener noreferrer"
        @click="handleClick"
      >
        <SmartphoneIcon class="size-4" />
        {{ $t(`${LABEL_ROOT}.${shortcut}.addShortcut`) }}
      </a>
    </Button>
    <p class="text-muted-foreground text-xs" :data-testid="`add-shortcut-${shortcut}-hint`">
      {{ $t(`${LABEL_ROOT}.${isShareable ? 'shareHint' : 'downloadHint'}`) }}
    </p>
  </div>
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
  isStandalone,
  openShortcutFile,
  shareShortcutFile,
  type ShortcutKind,
} from '../ios-automation';
import { useShortcutFile, useShortcutLink } from '../composables/use-shortcut-link';

const LABEL_ROOT = 'settings.integrations.iosAutomation.setup';

const props = defineProps<{
  /** `payments` is the iOS 27 shortcut with the built-in triggers, `tap` the Wallet tap shortcut for iOS 26 and earlier. */
  shortcut: ShortcutKind;
  /** Stretches the button to its container, for a stacked layout. */
  fullWidth?: boolean;
}>();

const source = getShortcutSource({ shortcut: props.shortcut });
const { href } = useShortcutLink({ filePath: source.filePath });

const { t } = useI18n({ useScope: 'global' });
const { addErrorNotification } = useNotificationCenter();

/**
 * A home-screen web app cannot hand a download to Shortcuts and a plain link would navigate away
 * from the app. Its in-app browser sheet does not take attachment downloads either, so the click
 * shares the already-fetched file through the share sheet when the browser can; only a browser that
 * cannot falls back to the system browser sheet there.
 */
const isInStandaloneApp = isStandalone();

const { file } = useShortcutFile({
  filePath: source.filePath,
  downloadName: source.downloadName,
  enabled: () => !!href.value,
});

const hasShareApi = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';

/**
 * Whether the tap opens the share sheet. The share sheet has no "Open in Shortcuts", so the hint
 * under the button says how to finish. Until the file has loaded the browser's capability decides,
 * so the hint does not change when the file arrives.
 */
const isShareable = computed(() => (file.value ? canShareShortcutFile({ file: file.value }) : hasShareApi));

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
  if (loadedFile && canShareShortcutFile({ file: loadedFile })) {
    event.preventDefault();
    void share({ shareable: loadedFile });
    return;
  }

  if (!isInStandaloneApp) return;

  event.preventDefault();
  openShortcutFile({ filePath: source.filePath });
};
</script>
