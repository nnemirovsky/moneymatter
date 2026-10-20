<template>
  <PageWrapper class="w-full max-w-5xl">
    <div class="@container/integrations flex flex-col gap-8">
      <div class="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          :aria-label="$t(`${LABEL_ROOT}.back`)"
          data-testid="apple-pay-back"
          @click="router.push({ name: ROUTES_NAMES.accounts })"
        >
          <ArrowLeftIcon class="size-4" />
        </Button>

        <WalletIcon class="size-7 shrink-0" />
        <h1 class="truncate text-xl font-semibold tracking-tight">{{ $t(`${LABEL_ROOT}.title`) }}</h1>
      </div>

      <div class="max-w-xl">
        <p class="text-muted-foreground text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.description`) }}</p>
        <i18n-t
          :keypath="`${LABEL_ROOT}.manualGuide`"
          tag="p"
          class="text-muted-foreground mt-2 text-sm leading-relaxed"
          data-testid="manual-guide"
        >
          <template #link>
            <DocsLink :path="MANUAL_GUIDE_DOCS_PATH">{{ $t(`${LABEL_ROOT}.manualGuideLink`) }}</DocsLink>
          </template>
        </i18n-t>
      </div>

      <Callout variant="warning" data-testid="apple-pay-limitation">
        {{ $t(`${LABEL_ROOT}.limitation`) }}
      </Callout>

      <section class="border-border flex flex-col gap-6 rounded-lg border p-4" data-testid="apple-pay-setup">
        <div class="max-w-xl">
          <h4 class="mb-1 text-base font-medium">{{ $t(`${LABEL_ROOT}.setup.title`) }}</h4>
          <p class="text-muted-foreground text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.setup.description`) }}</p>
        </div>

        <AccessHeadersForm v-if="config.isSelfHost" />

        <div class="flex flex-col gap-4">
          <label class="flex max-w-xl items-start gap-3">
            <Checkbox v-model="revokePrevious" class="mt-0.5" data-testid="revoke-previous" />
            <span class="text-sm leading-relaxed">
              {{ $t(`${LABEL_ROOT}.setup.revokePrevious`) }}
              <span class="text-muted-foreground block">{{ $t(`${LABEL_ROOT}.setup.revokePreviousHint`) }}</span>
            </span>
          </label>

          <div class="flex flex-wrap items-center gap-2">
            <Button
              :disabled="isGenerating"
              :loading="isGenerating"
              data-testid="generate-setup-code"
              @click="handleGenerate"
            >
              <QrCodeIcon class="size-4" />
              {{ $t(`${LABEL_ROOT}.setup.generate`) }}
            </Button>
          </div>
        </div>

        <ShortcutChoice />
      </section>

      <GateStrictness />
      <CardLinks />
      <UnlinkedCards @link="startLink" />
      <PendingSources />
      <NotificationSources />
      <WaitingPayments />
      <UnconfirmedPayments />
      <IngestDevices />
    </div>
  </PageWrapper>

  <SetupCodeDialog :code="setupCode" @close="clear" />

  <CardLinkDialog v-model:open="isLinkOpen" :initial-label="linkTarget?.cardLabel ?? ''" @saved="handleLinked" />

  <ResponsiveAlertDialog
    v-model:open="isOfferOpen"
    :confirm-label="offer ? $t(`${LABEL_ROOT}.unlinked.offer.confirm`, { count: offer.count }) : ''"
    :confirm-disabled="isLogging"
    @confirm="confirmOffer"
  >
    <template #title>{{ $t(`${LABEL_ROOT}.unlinked.offer.title`) }}</template>
    <template #description>
      {{ offer ? $t(`${LABEL_ROOT}.unlinked.offer.description`, { count: offer.count, name: offer.cardLabel }) : '' }}
    </template>
  </ResponsiveAlertDialog>
</template>

<script setup lang="ts">
import { config } from '@/common/config';
import PageWrapper from '@/components/common/page-wrapper.vue';
import DocsLink from '@/components/common/docs-link.vue';
import ResponsiveAlertDialog from '@/components/common/responsive-alert-dialog.vue';
import { Button } from '@/components/lib/ui/button';
import { Callout } from '@/components/lib/ui/callout';
import { Checkbox } from '@/components/lib/ui/checkbox';
import { useNotificationCenter } from '@/components/notification-center';
import { normalizeCardLabel, type CardMappingDto } from '@bt/shared/types';
import { ROUTES_NAMES } from '@/routes';
import { ArrowLeftIcon, QrCodeIcon } from '@lucide/vue';
import WalletIcon from '@/components/common/icons/wallet-icon.vue';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

import AccessHeadersForm from './components/access-headers-form.vue';
import CardLinkDialog from './components/card-link-dialog.vue';
import CardLinks from './components/card-links.vue';
import GateStrictness from './components/gate-strictness.vue';
import IngestDevices from './components/ingest-devices.vue';
import NotificationSources from './components/notification-sources.vue';
import PendingSources from './components/pending-sources.vue';
import ShortcutChoice from './components/shortcut-choice.vue';
import SetupCodeDialog from './components/setup-code-dialog.vue';
import UnconfirmedPayments from './components/unconfirmed-payments.vue';
import UnlinkedCards from './components/unlinked-cards.vue';
import WaitingPayments from './components/waiting-payments.vue';
import { useGenerateSetupCode } from './composables/use-generate-setup-code';
import { useLogWaitingPayments } from './composables/use-log-waiting-payments';
import { buildIngestUrl } from './ingest-url';

defineOptions({
  name: 'account-ios-automation-details',
});

const LABEL_ROOT = 'settings.integrations.iosAutomation';
const MANUAL_GUIDE_DOCS_PATH = '/integrations/ios-automation/';

interface LinkOffer {
  cardLabel: string;
  count: number;
}

const { t } = useI18n({ useScope: 'global' });
const router = useRouter();
const { addErrorNotification } = useNotificationCenter();

const { generate, isGenerating, setupCode, clear } = useGenerateSetupCode();
const { logWaitingPayments, isLogging } = useLogWaitingPayments();

const revokePrevious = ref(true);

const handleGenerate = async () => {
  try {
    await generate({ ingestUrl: buildIngestUrl(), revokePrevious: revokePrevious.value });
  } catch {
    // The mutation already told the user what failed.
  }
};

const isLinkOpen = ref(false);
const linkTarget = ref<LinkOffer | null>(null);
const offer = ref<LinkOffer | null>(null);

const isOfferOpen = computed({
  get: () => offer.value !== null,
  set: (isOpen) => {
    if (!isOpen) offer.value = null;
  },
});

const startLink = (card: LinkOffer) => {
  linkTarget.value = card;
  isLinkOpen.value = true;
};

/** Offers to log the waiting payments, unless the user linked a different card than the one they started from. */
const handleLinked = (mapping: CardMappingDto) => {
  const target = linkTarget.value;
  linkTarget.value = null;

  if (target && normalizeCardLabel({ label: mapping.cardLabel }) === normalizeCardLabel({ label: target.cardLabel })) {
    offer.value = { cardLabel: mapping.cardLabel, count: target.count };
  }
};

const confirmOffer = async () => {
  const current = offer.value;
  if (!current) return;

  try {
    await logWaitingPayments({ cardLabel: current.cardLabel });
  } catch {
    addErrorNotification(t(`${LABEL_ROOT}.unlinked.logError`));
  } finally {
    offer.value = null;
  }
};
</script>
