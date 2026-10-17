<template>
  <ResponsiveDialog
    :open="open"
    :dismissible="!secret"
    :custom-close="!!secret"
    dialog-content-class="max-w-md"
    @update:open="handleOpenChange"
  >
    <template #title>
      {{ secret ? $t(`${LABEL_ROOT}.secret.title`) : $t(`${LABEL_ROOT}.create.title`) }}
    </template>
    <template #description>
      {{ secret ? $t(`${LABEL_ROOT}.secret.description`) : $t(`${LABEL_ROOT}.create.description`) }}
    </template>

    <div v-if="secret" class="grid gap-4">
      <Callout variant="warning">{{ $t(`${LABEL_ROOT}.secret.warning`) }}</Callout>

      <div class="grid gap-1.5">
        <span class="text-sm font-medium">{{ $t(`${LABEL_ROOT}.secret.label`) }}</span>
        <code
          class="bg-muted block rounded-md px-3 py-2 font-mono text-sm break-all select-all"
          data-testid="ingest-token-secret"
        >
          {{ secret }}
        </code>
      </div>
    </div>

    <form v-else :id="FORM_ID" class="grid gap-4" @submit.prevent="handleSubmit">
      <InputField
        v-model="form.name"
        :label="$t(`${LABEL_ROOT}.create.nameLabel`)"
        :placeholder="$t(`${LABEL_ROOT}.create.namePlaceholder`)"
        :error-message="nameError ?? undefined"
        data-testid="ingest-token-name"
        @update:model-value="nameError = null"
      />

      <SelectField
        v-model="form.expiry"
        :label="$t(`${LABEL_ROOT}.create.expiresLabel`)"
        :placeholder="$t(`${LABEL_ROOT}.create.expiresPlaceholder`)"
        :values="expiryOptions"
        label-key="label"
        value-key="id"
      />
    </form>

    <template #footer>
      <div v-if="secret" class="flex w-full flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" data-testid="ingest-token-copy" @click="copySecret">
          <CopyIcon class="size-4" />
          {{ $t(`${LABEL_ROOT}.secret.copy`) }}
        </Button>
        <Button type="button" data-testid="ingest-token-done" @click="handleDone">
          {{ $t(`${LABEL_ROOT}.secret.done`) }}
        </Button>
      </div>
      <div v-else class="flex w-full justify-end gap-2">
        <Button type="button" variant="outline" :disabled="isCreating" @click="handleDone">
          {{ $t('common.actions.cancel') }}
        </Button>
        <Button
          type="submit"
          :form="FORM_ID"
          :disabled="isCreating"
          :loading="isCreating"
          data-testid="ingest-token-submit"
        >
          {{ $t(`${LABEL_ROOT}.create.submit`) }}
        </Button>
      </div>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import ResponsiveDialog from '@/components/common/responsive-dialog.vue';
import InputField from '@/components/fields/input-field.vue';
import SelectField from '@/components/fields/select-field.vue';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { useNotificationCenter } from '@/components/notification-center';
import { CopyIcon } from '@lucide/vue';
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { useCreateIngestToken } from '../composables/use-create-ingest-token';
import { INGEST_TOKEN_EXPIRY_OPTIONS, type IngestTokenExpiryOption, buildCreateTokenPayload } from '../ingest-tokens';

const LABEL_ROOT = 'settings.integrations.ingestTokens';
const FORM_ID = 'create-ingest-token-form';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const { t } = useI18n({ useScope: 'global' });
const { addSuccessNotification, addErrorNotification } = useNotificationCenter();
const { createToken, isCreating, secret, clear } = useCreateIngestToken();

const expiryOptions = computed(() =>
  INGEST_TOKEN_EXPIRY_OPTIONS.map((option) => ({ ...option, label: t(option.labelKey) })),
);

const [DEFAULT_EXPIRY] = INGEST_TOKEN_EXPIRY_OPTIONS;

const form = reactive<{ name: string; expiry: (IngestTokenExpiryOption & { label?: string }) | null }>({
  name: '',
  expiry: { ...DEFAULT_EXPIRY!, label: t(DEFAULT_EXPIRY!.labelKey) },
});
const nameError = ref<string | null>(null);

/** Drops the secret and the typed values, so a reopened dialog starts clean. */
const reset = () => {
  clear();
  form.name = '';
  form.expiry = { ...DEFAULT_EXPIRY!, label: t(DEFAULT_EXPIRY!.labelKey) };
  nameError.value = null;
};

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) reset();
  },
);

const handleOpenChange = (isOpen: boolean) => {
  if (!isOpen) reset();
  emit('update:open', isOpen);
};

const handleDone = () => handleOpenChange(false);

const handleSubmit = async () => {
  if (!form.name.trim()) {
    nameError.value = t(`${LABEL_ROOT}.create.nameRequired`);
    return;
  }

  try {
    await createToken(buildCreateTokenPayload({ name: form.name, expiresInDays: form.expiry?.days }));
  } catch {
    // The mutation already reported the failure; the form stays open for another try.
  }
};

const copySecret = async () => {
  if (!secret.value) return;

  try {
    await navigator.clipboard.writeText(secret.value);
    addSuccessNotification(t(`${LABEL_ROOT}.secret.copied`));
  } catch {
    addErrorNotification(t('common.errors.copyToClipboardFailed'));
  }
};
</script>
