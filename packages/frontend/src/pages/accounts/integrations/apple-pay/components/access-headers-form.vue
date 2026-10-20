<template>
  <Collapsible v-model:open="isOpen" as="section" class="flex flex-col gap-4" data-testid="access-headers">
    <CollapsibleTrigger
      class="focus-visible:ring-ring/40 flex w-full max-w-xl items-center gap-2 rounded text-left focus-visible:ring-2 focus-visible:outline-none"
      data-testid="access-headers-toggle"
    >
      <ChevronRightIcon :class="['size-4 shrink-0 transition-transform duration-200', { 'rotate-90': isOpen }]" />
      <h4 class="font-medium">{{ $t(`${LABEL_ROOT}.title`) }}</h4>
      <span v-if="stateHintKey" class="text-muted-foreground ml-auto text-sm" data-testid="access-headers-status">
        {{ $t(stateHintKey) }}
      </span>
    </CollapsibleTrigger>

    <CollapsibleContent>
      <div class="flex flex-col gap-4">
        <p class="text-muted-foreground max-w-xl text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.description`) }}</p>

        <Callout v-if="isError" variant="destructive" data-testid="access-headers-error">
          {{ $t(`${LABEL_ROOT}.loadError`) }}
        </Callout>

        <form v-else class="grid gap-4 @lg/integrations:grid-cols-2" @submit.prevent="handleSave">
          <InputField
            v-model="form.clientId"
            :label="$t(`${LABEL_ROOT}.clientIdLabel`)"
            :placeholder="clientIdPlaceholder"
            data-testid="access-headers-client-id"
          />
          <InputField
            v-model="form.clientSecret"
            type="password"
            :label="$t(`${LABEL_ROOT}.clientSecretLabel`)"
            :placeholder="
              $t(
                status?.configured
                  ? `${LABEL_ROOT}.clientSecretStoredPlaceholder`
                  : `${LABEL_ROOT}.clientSecretPlaceholder`,
              )
            "
            data-testid="access-headers-client-secret"
          />

          <p
            v-if="error"
            class="text-destructive-text text-sm @lg/integrations:col-span-2"
            data-testid="access-headers-form-error"
          >
            {{ error }}
          </p>

          <div class="flex flex-wrap gap-2 @lg/integrations:col-span-2">
            <Button type="submit" :disabled="isSaving" :loading="isSaving" data-testid="access-headers-save">
              {{ $t(`${LABEL_ROOT}.save`) }}
            </Button>
            <Button
              v-if="status?.configured"
              type="button"
              variant="soft-destructive"
              :disabled="isSaving"
              data-testid="access-headers-remove"
              @click="handleRemove"
            >
              {{ $t(`${LABEL_ROOT}.remove`) }}
            </Button>
          </div>
        </form>
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>

<script setup lang="ts">
import { getAccessHeaders, setAccessHeaders } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import InputField from '@/components/fields/input-field.vue';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/lib/ui/collapsible';
import { useNotificationCenter } from '@/components/notification-center';
import { notifyMutationError } from '@/composable/data-queries/use-invalidating-mutation';
import type { SetAccessHeadersPayload } from '@bt/shared/types';
import { ChevronRightIcon } from '@lucide/vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';

defineOptions({
  name: 'settings-integrations-access-headers',
});

const LABEL_ROOT = 'settings.integrations.applePay.accessHeaders';

const { t } = useI18n({ useScope: 'global' });
const queryClient = useQueryClient();
const { addSuccessNotification } = useNotificationCenter();

const form = reactive({ clientId: '', clientSecret: '' });
const error = ref<string | null>(null);
// Collapsed by default, even when headers are stored: the folded header carries the state hint.
const isOpen = ref(false);

const { data: status, isError } = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.cardPaymentAccessHeaders,
  queryFn: getAccessHeaders,
});

const stateHintKey = computed(() => {
  if (isError.value || !status.value) return null;
  return status.value.configured ? `${LABEL_ROOT}.stateConfigured` : `${LABEL_ROOT}.stateNotSet`;
});

const clientIdPlaceholder = computed(() => {
  if (!status.value?.configured) return t(`${LABEL_ROOT}.clientIdPlaceholder`);
  return status.value.clientIdHint
    ? t(`${LABEL_ROOT}.clientIdStoredPlaceholder`, { hint: status.value.clientIdHint })
    : t(`${LABEL_ROOT}.clientIdStoredNoHintPlaceholder`);
});

// The secret is a mutation variable, and vue-query keeps variables in its mutation cache while the
// observer is mounted and for five minutes after. `gcTime: 0` plus a reset once a save settles
// leaves nothing behind.
const {
  mutateAsync: sendHeaders,
  reset: forgetSentHeaders,
  isPending: isSaving,
} = useMutation({
  mutationFn: (payload: SetAccessHeadersPayload) => setAccessHeaders(payload),
  gcTime: 0,
  onSuccess: (next) => queryClient.setQueryData(VUE_QUERY_CACHE_KEYS.cardPaymentAccessHeaders, next),
  onError: (mutationError) => notifyMutationError({ error: mutationError, fallbackKey: `${LABEL_ROOT}.saveError` }),
});

const save = async (payload: SetAccessHeadersPayload) => {
  try {
    await sendHeaders(payload);
  } finally {
    forgetSentHeaders();
  }
};

const clearForm = () => {
  form.clientId = '';
  form.clientSecret = '';
  error.value = null;
};

const handleSave = async () => {
  const clientId = form.clientId.trim();
  const clientSecret = form.clientSecret.trim();

  if (!clientId || !clientSecret) {
    error.value = t(`${LABEL_ROOT}.bothRequired`);
    return;
  }

  try {
    await save({ clientId, clientSecret });
    clearForm();
    addSuccessNotification(t(`${LABEL_ROOT}.saved`));
  } catch {
    // The mutation already told the user what failed.
  }
};

const handleRemove = async () => {
  try {
    await save({ clientId: null, clientSecret: null });
    clearForm();
    addSuccessNotification(t(`${LABEL_ROOT}.removed`));
  } catch {
    // The mutation already told the user what failed.
  }
};
</script>
