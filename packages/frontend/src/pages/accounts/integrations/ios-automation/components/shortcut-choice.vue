<template>
  <div class="@container/shortcut-choice flex flex-col gap-4" data-testid="shortcut-choice">
    <div class="grid grid-cols-1 gap-4 @xl/shortcut-choice:grid-cols-2">
      <div
        v-for="option in options"
        :key="option.shortcut"
        class="border-border flex min-w-0 flex-col gap-3 rounded-lg border p-4"
        :data-testid="`shortcut-option-${option.shortcut}`"
      >
        <div>
          <h5 class="font-medium">{{ $t(`${LABEL_ROOT}.${option.shortcut}.title`) }}</h5>
          <p class="text-muted-foreground mt-1 text-sm leading-relaxed">
            {{ $t(`${LABEL_ROOT}.${option.shortcut}.summary`) }}
          </p>
        </div>

        <div class="flex flex-col items-start gap-2">
          <AddShortcutButton :shortcut="option.shortcut" />
          <Callout
            v-if="option.isResolved && !option.href"
            variant="info"
            :data-testid="`shortcut-unavailable-${option.shortcut}`"
          >
            {{ $t(`${LABEL_ROOT}.unavailable`, { name: $t(`${LABEL_ROOT}.${option.shortcut}.title`) }) }}
          </Callout>
        </div>

        <Collapsible v-model:open="openOptions[option.shortcut]" as="div" class="flex flex-col gap-3">
          <CollapsibleTrigger
            class="focus-visible:ring-ring/40 flex w-full items-center gap-2 rounded text-left text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
            :data-testid="`shortcut-instructions-toggle-${option.shortcut}`"
          >
            <ChevronRightIcon
              :class="[
                'size-4 shrink-0 transition-transform duration-200',
                { 'rotate-90': openOptions[option.shortcut] },
              ]"
            />
            {{ $t(`${LABEL_ROOT}.${openOptions[option.shortcut] ? 'hideInstructions' : 'showInstructions'}`) }}
          </CollapsibleTrigger>

          <CollapsibleContent :data-testid="`shortcut-instructions-${option.shortcut}`">
            <TriggeredShortcutSetup v-if="option.shortcut === 'payments'" />
            <SetupChecklist v-else />
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>

    <p v-if="hasAnyLink" class="text-muted-foreground max-w-xl text-sm" data-testid="shortcut-choice-hint">
      {{ $t(`${LABEL_ROOT}.hint`) }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { Callout } from '@/components/lib/ui/callout';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/lib/ui/collapsible';
import { ChevronRightIcon } from '@lucide/vue';
import { computed, reactive } from 'vue';

import { getShortcutSource, type ShortcutKind } from '../ios-automation';
import { useShortcutLink } from '../composables/use-shortcut-link';
import AddShortcutButton from './add-shortcut-button.vue';
import SetupChecklist from './setup-checklist.vue';
import TriggeredShortcutSetup from './triggered-shortcut-setup.vue';

defineOptions({
  name: 'settings-integrations-shortcut-choice',
});

const LABEL_ROOT = 'settings.integrations.iosAutomation.choice';

/**
 * Two buttons, side by side: nothing here reads the user agent or remembers a choice, because the
 * browser cannot tell the iOS version (Safari freezes it, a home-screen app has no Safari at all).
 */
const SHORTCUTS: ShortcutKind[] = ['payments', 'tap'];

const links = Object.fromEntries(
  SHORTCUTS.map((shortcut) => {
    const { filePath } = getShortcutSource({ shortcut });

    return [shortcut, useShortcutLink({ filePath })];
  }),
) as Record<ShortcutKind, ReturnType<typeof useShortcutLink>>;

const options = computed(() =>
  SHORTCUTS.map((shortcut) => ({
    shortcut,
    href: links[shortcut].href.value,
    isResolved: links[shortcut].isResolved.value,
  })),
);

const hasAnyLink = computed(() => options.value.some((option) => option.href));

const openOptions = reactive<Record<ShortcutKind, boolean>>({ payments: false, tap: false });
</script>
