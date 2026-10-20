<script setup lang="ts">
import { updateSubscriptionPeriodNotes } from '@/api/subscriptions';
import ResponsiveDialog from '@/components/common/responsive-dialog.vue';
import TextareaField from '@/components/fields/textarea-field.vue';
import Button from '@/components/lib/ui/button/Button.vue';
import { Callout } from '@/components/lib/ui/callout';
import { useNotificationCenter } from '@/components/notification-center';
import { useInvalidateSubscriptionQueries } from '@/composable/data-queries/subscriptions';
import { ApiErrorResponseError } from '@/js/errors';
import type { SubscriptionPeriodModel } from '@bt/shared/types';
import { useMutation } from '@tanstack/vue-query';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

// Same cap as the backend (`updatePeriodNotesBodySchema`).
const MAX_NOTE_LENGTH = 5000;

const props = defineProps<{ subscriptionId: string; period: SubscriptionPeriodModel | null }>();
const open = defineModel<boolean>('open', { default: false });

const { t } = useI18n();
const { addSuccessNotification } = useNotificationCenter();
const invalidateSubscriptionQueries = useInvalidateSubscriptionQueries();

const note = ref('');
const formError = ref<string | null>(null);

watch(open, (isOpen) => {
  if (!isOpen) return;
  note.value = props.period?.notes ?? '';
  formError.value = null;
});

const { mutate, isPending } = useMutation({
  mutationFn: updateSubscriptionPeriodNotes,
  onSuccess: () => {
    invalidateSubscriptionQueries();
    addSuccessNotification(t('planned.subscriptions.periods.notifications.noteUpdated'));
    open.value = false;
  },
  onError: (err) => {
    const fallback = t('planned.subscriptions.periods.notifications.noteUpdateFailed');
    formError.value = err instanceof ApiErrorResponseError ? (err.data.message ?? fallback) : fallback;
  },
});

const handleSubmit = () => {
  if (!props.period) return;
  formError.value = null;
  mutate({ id: props.subscriptionId, periodId: props.period.id, notes: note.value.trim() || null });
};
</script>

<template>
  <ResponsiveDialog v-model:open="open" dialog-content-class="max-w-lg">
    <template #title>{{ $t('planned.subscriptions.periods.dialogs.editNoteTitle') }}</template>
    <template #description>
      {{ $t('planned.subscriptions.periods.dialogs.editNoteDescription', { date: period?.dueDate }) }}
    </template>

    <form id="edit-subscription-period-note" class="grid gap-4" @submit.prevent="handleSubmit">
      <TextareaField
        v-model="note"
        :label="$t('planned.subscriptions.periods.dialogs.noteLabel')"
        :placeholder="$t('planned.subscriptions.periods.dialogs.notePlaceholder')"
        :maxlength="MAX_NOTE_LENGTH"
      />

      <Callout v-if="formError" variant="destructive">
        <span>{{ formError }}</span>
      </Callout>
    </form>

    <template #footer>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" :disabled="isPending" @click="open = false">
          {{ $t('planned.subscriptions.cancel') }}
        </Button>
        <Button type="submit" form="edit-subscription-period-note" :disabled="isPending">
          {{ $t('planned.subscriptions.periods.dialogs.noteSave') }}
        </Button>
      </div>
    </template>
  </ResponsiveDialog>
</template>
