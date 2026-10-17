<template>
  <section class="flex flex-col gap-4" data-testid="access-headers">
    <div class="max-w-xl">
      <h4 class="mb-1 font-medium">{{ $t(`${LABEL_ROOT}.title`) }}</h4>
      <p class="text-muted-foreground text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.description`) }}</p>
    </div>

    <Callout v-if="isError" variant="destructive" data-testid="access-headers-error">
      {{ $t(`${LABEL_ROOT}.loadError`) }}
    </Callout>

    <template v-else>
      <p class="text-muted-foreground text-sm" data-testid="access-headers-status">
        {{
          status?.configured
            ? $t(`${LABEL_ROOT}.statusConfigured`, { hint: status.clientIdHint ?? '' })
            : $t(`${LABEL_ROOT}.statusNotConfigured`)
        }}
      </p>

      <form class="grid gap-4 @lg/integrations:grid-cols-2" @submit.prevent="handleSave">
        <InputField
          v-model="form.clientId"
          :label="$t(`${LABEL_ROOT}.clientIdLabel`)"
          :placeholder="$t(`${LABEL_ROOT}.clientIdPlaceholder`)"
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
    </template>
  </section>
</template>

<script setup lang="ts">
import { getAccessHeaders, setAccessHeaders } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import InputField from '@/components/fields/input-field.vue';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { useNotificationCenter } from '@/components/notification-center';
import { notifyMutationError } from '@/composable/data-queries/use-invalidating-mutation';
import type { SetAccessHeadersPayload } from '@bt/shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { reactive, ref } from 'vue';
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

const { data: status, isError } = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.cardPaymentAccessHeaders,
  queryFn: getAccessHeaders,
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
