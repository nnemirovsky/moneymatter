<template>
  <div class="flex flex-col gap-4" data-testid="setup-checklist">
    <div class="max-w-xl">
      <h4 class="mb-1 font-medium">{{ $t(`${LABEL_ROOT}.title`) }}</h4>
      <p class="text-muted-foreground text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.description`) }}</p>
    </div>

    <ol class="flex flex-col gap-3">
      <li v-for="(step, index) in STEPS" :key="step" class="flex items-start gap-3" data-testid="setup-checklist-step">
        <span
          class="bg-primary/10 text-primary-text flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
          aria-hidden="true"
        >
          {{ index + 1 }}
        </span>
        <span class="pt-0.5 text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.${step}`) }}</span>
      </li>
    </ol>

    <Callout variant="info" :title="$t(`${LABEL_ROOT}.testTitle`)" data-testid="setup-checklist-test">
      {{ $t(`${LABEL_ROOT}.test`) }}
    </Callout>
  </div>
</template>

<script setup lang="ts">
import { Callout } from '@/components/lib/ui/callout';

const LABEL_ROOT = 'settings.integrations.iosAutomation.checklist';

const STEPS = ['step1', 'step2', 'step3'] as const;
</script>
