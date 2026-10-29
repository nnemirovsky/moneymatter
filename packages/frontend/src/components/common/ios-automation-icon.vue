<script setup lang="ts">
import { getIosAutomationIcons } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';

import ShortcutsAppIcon from './icons/shortcuts-app-icon.vue';
import WalletIcon from './icons/wallet-icon.vue';

defineOptions({ inheritAttrs: false });

const { data } = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.iosAutomationIcons,
  queryFn: getIosAutomationIcons,
  // The two icons change with an App Store artwork update at most; the server keeps them for weeks.
  staleTime: 12 * 60 * 60 * 1000,
  retry: false,
});

const brokenShortcuts = ref(false);
const brokenWallet = ref(false);

const shortcutsUrl = computed(() => (brokenShortcuts.value ? null : (data.value?.shortcuts ?? null)));
const walletUrl = computed(() => (brokenWallet.value ? null : (data.value?.wallet ?? null)));

// Until the server has answered, and when it found neither icon, the integration keeps its own single drawing.
const isSplit = computed(() => Boolean(data.value) && Boolean(shortcutsUrl.value || walletUrl.value));

// The iOS Automation integration: Shortcuts in the top-left half and Wallet in the bottom-right half of one rounded
// square. Each half falls back to its own drawing when its image is missing or does not load.
// Wallet fills the whole square underneath and only Shortcuts is clipped, so the diagonal shows no seam.
const TOP_LEFT = 'polygon(0 0, 100% 0, 0 100%)';
</script>

<template>
  <span
    v-if="isSplit"
    :class="cn('relative inline-block size-7 overflow-hidden rounded-[22%]', $attrs.class as string)"
    data-testid="ios-automation-icon"
    aria-hidden="true"
  >
    <span class="absolute inset-0 bg-[#1c1c1e]" data-testid="ios-automation-wallet">
      <img
        v-if="walletUrl"
        :src="walletUrl"
        alt=""
        class="size-full object-cover"
        referrerpolicy="no-referrer"
        @error="brokenWallet = true"
      />
      <WalletIcon v-else class="size-full" />
    </span>
    <span class="absolute inset-0 bg-[#7b5cf0]" :style="{ clipPath: TOP_LEFT }" data-testid="ios-automation-shortcuts">
      <img
        v-if="shortcutsUrl"
        :src="shortcutsUrl"
        alt=""
        class="size-full object-cover"
        referrerpolicy="no-referrer"
        @error="brokenShortcuts = true"
      />
      <ShortcutsAppIcon v-else class="size-full" />
    </span>
  </span>
  <WalletIcon v-else :class="$attrs.class as string" data-testid="ios-automation-icon-fallback" />
</template>
