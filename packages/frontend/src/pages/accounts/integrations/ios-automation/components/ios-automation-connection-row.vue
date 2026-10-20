<template>
  <div class="hover:bg-muted/40 flex items-center gap-3 px-4 py-3 transition-colors" data-testid="apple-pay-row">
    <button
      type="button"
      class="focus-visible:ring-ring/40 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded text-left focus-visible:ring-2 focus-visible:outline-none"
      @click="goToDetails"
    >
      <WalletIcon class="size-7 shrink-0" />

      <span class="min-w-0">
        <span class="block truncate text-sm font-semibold">{{ $t('accounts.applePay.name') }}</span>
        <span class="text-muted-foreground block truncate text-xs">
          {{ $t('accounts.applePay.cardsLinked', { count: linkedCardsCount }) }}
        </span>
      </span>
    </button>

    <span
      v-if="waitingCount"
      class="bg-warning/20 text-warning-text shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold"
      data-testid="apple-pay-waiting"
    >
      {{ $t('accounts.applePay.waiting', { count: waitingCount }) }}
    </span>

    <DesktopOnlyTooltip :content="$t('accounts.manageConnection')">
      <UiButton variant="ghost" size="icon-sm" :aria-label="$t('accounts.manageConnection')" @click="goToDetails">
        <Settings2Icon class="size-4" />
      </UiButton>
    </DesktopOnlyTooltip>
  </div>
</template>

<script setup lang="ts">
import UiButton from '@/components/lib/ui/button/Button.vue';
import { DesktopOnlyTooltip } from '@/components/lib/ui/tooltip';
import { ROUTES_NAMES } from '@/routes';
import { Settings2Icon } from '@lucide/vue';
import WalletIcon from '@/components/common/icons/wallet-icon.vue';
import { useRouter } from 'vue-router';

defineProps<{
  linkedCardsCount: number;
  waitingCount: number;
}>();

const router = useRouter();

const goToDetails = () => router.push({ name: ROUTES_NAMES.accountIosAutomation });
</script>
