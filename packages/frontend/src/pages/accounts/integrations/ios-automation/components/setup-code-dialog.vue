<template>
  <ResponsiveDialog
    :open="code !== null"
    :dismissible="false"
    custom-close
    dialog-content-class="max-w-md"
    @update:open="handleOpenChange"
  >
    <template #title>{{ $t(`${LABEL_ROOT}.title`) }}</template>
    <template #description>{{ $t(`${LABEL_ROOT}.description`) }}</template>

    <div v-if="code" class="grid gap-4">
      <Callout variant="warning">{{ $t(`${LABEL_ROOT}.warning`) }}</Callout>

      <div class="grid gap-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-medium">{{ $t(`${LABEL_ROOT}.codeLabel`) }}</span>
          <Button type="button" variant="outline" size="sm" data-testid="setup-code-copy" @click="copyCode">
            <CopyIcon class="size-4" />
            {{ $t(`${LABEL_ROOT}.copy`) }}
          </Button>
        </div>
        <code
          ref="codeElement"
          :class="[
            'bg-muted block rounded-md px-3 py-2 font-mono text-xs break-all select-all',
            { 'line-clamp-3': !isManualCopy },
          ]"
          data-testid="setup-code-text"
        >
          {{ code }}
        </code>
        <p v-if="isManualCopy" class="text-muted-foreground text-xs" data-testid="setup-code-manual-copy">
          {{ $t(`${LABEL_ROOT}.manualCopy`) }}
        </p>
      </div>

      <div class="mx-auto aspect-square w-full max-w-56 overflow-hidden rounded-lg">
        <SetupCodeQr :text="code" :label="$t(`${LABEL_ROOT}.qrLabel`)" />
      </div>
    </div>

    <template #footer>
      <div class="@container/setup-actions grid w-full gap-2">
        <AddShortcutButton shortcut="payments" class="w-full" />
        <AddShortcutButton shortcut="tap" class="w-full" />
        <Button
          type="button"
          class="w-full @sm/setup-actions:w-auto @sm/setup-actions:justify-self-end"
          data-testid="setup-code-done"
          @click="emit('close')"
        >
          {{ $t(`${LABEL_ROOT}.done`) }}
        </Button>
      </div>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { copyText } from '@/common/utils/copy-text';
import ResponsiveDialog from '@/components/common/responsive-dialog.vue';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { useNotificationCenter } from '@/components/notification-center';
import { CopyIcon } from '@lucide/vue';
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import AddShortcutButton from './add-shortcut-button.vue';
import SetupCodeQr from './setup-code-qr.vue';

const LABEL_ROOT = 'settings.integrations.iosAutomation.codeDialog';

const props = defineProps<{
  /** The setup code, or `null` while the dialog is closed. It is a credential: show it, never keep it. */
  code: string | null;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n({ useScope: 'global' });
const { addSuccessNotification } = useNotificationCenter();

const codeElement = ref<HTMLElement | null>(null);
/** Both automatic ways to copy were refused, so the code is selected for the user to copy by hand. */
const isManualCopy = ref(false);

watch(
  () => props.code,
  () => {
    isManualCopy.value = false;
  },
);

const handleOpenChange = (isOpen: boolean) => {
  if (!isOpen) emit('close');
};

const selectCode = () => {
  const element = codeElement.value;
  const selection = window.getSelection();
  if (!element || !selection) return;

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
};

const copyCode = async () => {
  if (!props.code) return;

  // `copyText` starts the clipboard write before it awaits anything, so iOS still sees the tap.
  if (await copyText({ text: props.code })) {
    isManualCopy.value = false;
    addSuccessNotification(t(`${LABEL_ROOT}.copied`));
    return;
  }

  isManualCopy.value = true;
  await nextTick();
  selectCode();
};
</script>
