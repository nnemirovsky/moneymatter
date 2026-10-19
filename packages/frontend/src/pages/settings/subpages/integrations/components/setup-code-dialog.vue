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

      <div class="mx-auto aspect-square w-full max-w-56 overflow-hidden rounded-lg">
        <SetupCodeQr :text="code" :label="$t(`${LABEL_ROOT}.qrLabel`)" />
      </div>

      <div class="grid gap-1.5">
        <span class="text-sm font-medium">{{ $t(`${LABEL_ROOT}.codeLabel`) }}</span>
        <code
          class="bg-muted line-clamp-3 block rounded-md px-3 py-2 font-mono text-xs break-all select-all"
          data-testid="setup-code-text"
        >
          {{ code }}
        </code>
      </div>
    </div>

    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" data-testid="setup-code-copy" @click="copyCode">
          <CopyIcon class="size-4" />
          {{ $t(`${LABEL_ROOT}.copy`) }}
        </Button>
        <AddShortcutButton />
        <Button type="button" data-testid="setup-code-done" @click="emit('close')">
          {{ $t(`${LABEL_ROOT}.done`) }}
        </Button>
      </div>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import ResponsiveDialog from '@/components/common/responsive-dialog.vue';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { useNotificationCenter } from '@/components/notification-center';
import { CopyIcon } from '@lucide/vue';
import { useI18n } from 'vue-i18n';

import AddShortcutButton from './add-shortcut-button.vue';
import SetupCodeQr from './setup-code-qr.vue';

const LABEL_ROOT = 'settings.integrations.applePay.codeDialog';

const props = defineProps<{
  /** The setup code, or `null` while the dialog is closed. It is a credential: show it, never keep it. */
  code: string | null;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n({ useScope: 'global' });
const { addSuccessNotification, addErrorNotification } = useNotificationCenter();

const handleOpenChange = (isOpen: boolean) => {
  if (!isOpen) emit('close');
};

const copyCode = async () => {
  if (!props.code) return;

  try {
    await navigator.clipboard.writeText(props.code);
    addSuccessNotification(t(`${LABEL_ROOT}.copied`));
  } catch {
    addErrorNotification(t('common.errors.copyToClipboardFailed'));
  }
};
</script>
