<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import { useNotificationCenter } from '@/components/notification-center';
import { useChatCardActions } from '@/composable/data-queries/chat';
import type { ChatApproveAllResponse, ChatProposalCard } from '@bt/shared/types';
import { CheckCheckIcon } from '@lucide/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { useChatText } from '../chat-text';

export interface ApproveAllGroup {
  /** An assistant message; the server approves per message. */
  messageId: string;
  /** Every card of that message. */
  cards: ChatProposalCard[];
}

const props = defineProps<{
  /** The messages the bar covers: one in a conversation, every message of the thread in the automation inbox. */
  groups: ApproveAllGroup[];
  /** Only counts what is left for the user; the thread shows those cards itself (the pinned inbox bar). */
  compact?: boolean;
}>();

const { t } = useI18n();
const { keyText, titleText } = useChatText();
const { addSuccessNotification } = useNotificationCenter();
const { approveAllMessages } = useChatCardActions();

/**
 * Why a card is not part of the pass, as the server words it for a card it skips: the order is the
 * server's, so what the bar names is what the server would say.
 */
const skipReasonKey = ({ card }: { card: ChatProposalCard }): string => {
  if (card.stale) return card.stale.reasonKey;
  if (!card.canApply.ok) return card.canApply.reasonKey;
  if (card.egress) return 'chat.cards.needsHostConfirmation';
  if (card.confirmation.mode !== 'none' || card.danger !== 'none') return 'chat.cards.needsConfirmation';
  if (card.fields.some((field) => field.uncertain)) return 'chat.cards.hasUncertainFields';
  return 'chat.cards.needsReview';
};

const pendingOf = ({ group }: { group: ApproveAllGroup }) => group.cards.filter((card) => card.status === 'pending');
const pending = computed(() => props.groups.flatMap((group) => pendingOf({ group })));
const safeCount = computed(() => pending.value.filter((card) => card.safe).length);
// With one card waiting, its own Approve does the same thing.
const isShown = computed(() => pending.value.length > 1 && safeCount.value > 0);
const skipped = computed(() =>
  pending.value
    .filter((card) => !card.safe)
    .map((card) => ({
      id: card.id,
      title: titleText({ title: card.title }),
      reason: keyText({ key: skipReasonKey({ card }), fallbackKey: 'chat.cards.needsReview' }) ?? '',
    })),
);

const announce = ({ responses }: { responses: ChatApproveAllResponse[] }) => {
  const results = responses.flatMap((response) => response.results);
  const applied = results.filter((result) => result.outcome === 'applied').length;
  const left = results.length - applied;

  addSuccessNotification(
    left === 0
      ? t('chat.cards.approveAll.applied', { count: applied })
      : t('chat.cards.approveAll.partial', { applied, left }),
  );
};

const approve = async () => {
  // The server decides which cards are safe; it needs the revision the user saw of each pending one.
  const calls = props.groups
    .map((group) => ({ messageId: group.messageId, cards: pendingOf({ group }) }))
    .filter(({ cards }) => cards.some((card) => card.safe))
    .map(({ messageId, cards }) => ({
      messageId,
      payload: { revisions: Object.fromEntries(cards.map((card) => [card.id, card.revision])) },
    }));
  const { responses } = await approveAllMessages.mutateAsync({ groups: calls }).catch(() => ({ responses: [] }));
  if (responses.length > 0) announce({ responses });
};
</script>

<template>
  <div v-if="isShown" class="bg-card flex flex-col gap-2 rounded-xl border p-3">
    <div class="flex flex-wrap items-center gap-3">
      <Button
        variant="soft-success"
        size="sm"
        data-testid="approve-all"
        :disabled="approveAllMessages.isPending.value"
        @click="approve"
      >
        <CheckCheckIcon class="size-4" aria-hidden="true" />
        {{ $t('chat.cards.approveAll.button', { count: safeCount }) }}
      </Button>
    </div>

    <p v-if="skipped.length > 0 && compact" class="text-muted-foreground text-sm" data-testid="skipped-count">
      {{ $t('chat.cards.approveAll.skippedTitle', { count: skipped.length }) }}
    </p>
    <div v-else-if="skipped.length > 0" class="text-muted-foreground text-sm">
      <p class="font-medium">{{ $t('chat.cards.approveAll.skippedTitle', { count: skipped.length }) }}</p>
      <ul class="mt-1 flex flex-col gap-0.5">
        <li v-for="item in skipped" :key="item.id" data-testid="skipped-card">
          <span class="text-foreground">{{ item.title }}</span>
          <span> · {{ item.reason }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
