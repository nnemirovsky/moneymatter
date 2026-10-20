<template>
  <section class="flex flex-col gap-4" data-testid="gate-strictness">
    <div class="max-w-xl">
      <h3 class="mb-2 text-lg font-medium">{{ $t(`${LABEL_ROOT}.title`) }}</h3>
      <p class="text-muted-foreground text-sm leading-relaxed">{{ $t(`${LABEL_ROOT}.description`) }}</p>
    </div>

    <Callout v-if="isError" variant="destructive" data-testid="gate-strictness-error">
      {{ $t(`${LABEL_ROOT}.loadError`) }}
    </Callout>

    <RadioGroup
      v-else
      :model-value="selected"
      :disabled="isLoading || isSaving"
      class="max-w-xl gap-3"
      data-testid="gate-strictness-levels"
      @update:model-value="handleChange"
    >
      <div v-for="level in GATE_STRICTNESS_LEVELS" :key="level" class="flex items-start gap-3">
        <RadioGroupItem :id="`gate-strictness-${level}`" :value="level" class="mt-0.5" :data-testid="`gate-${level}`" />
        <Label :for="`gate-strictness-${level}`" class="cursor-pointer font-normal">
          <span class="block font-medium">{{ $t(`${LABEL_ROOT}.levels.${level}.title`) }}</span>
          <span class="text-muted-foreground block text-sm leading-relaxed">
            {{ $t(`${LABEL_ROOT}.levels.${level}.description`) }}
          </span>
        </Label>
      </div>
    </RadioGroup>

    <Callout v-if="selected === 'loose'" variant="warning" data-testid="gate-strictness-warning">
      {{ $t(`${LABEL_ROOT}.looseWarning`) }}
    </Callout>

    <Callout v-if="hasChanged" variant="info" data-testid="gate-strictness-new-code">
      {{ $t(`${LABEL_ROOT}.newCodeHint`) }}
    </Callout>
  </section>
</template>

<script setup lang="ts">
import { getGateStrictness, setGateStrictness } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import { Callout } from '@/components/lib/ui/callout';
import { Label } from '@/components/lib/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/lib/ui/radio-group';
import { useInvalidatingMutation } from '@/composable/data-queries/use-invalidating-mutation';
import { GATE_STRICTNESS_LEVELS, type GateStrictness } from '@bt/shared/types';
import { useQuery } from '@tanstack/vue-query';
import { computed, ref, watch } from 'vue';

defineOptions({
  name: 'settings-integrations-gate-strictness',
});

const LABEL_ROOT = 'settings.integrations.iosAutomation.gate';

const { data, isLoading, isError } = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.cardPaymentGateStrictness,
  queryFn: getGateStrictness,
});

const strictness = computed(() => data.value?.strictness);

/** What the radios show: the stored level, or the one just chosen while it is being saved. */
const selected = ref<GateStrictness | undefined>(undefined);
watch(strictness, (level) => (selected.value = level), { immediate: true });

/** The level is baked into the shortcut by the setup code, so a change needs a new code. */
const hasChanged = ref(false);

const { mutateAsync: save, isPending: isSaving } = useInvalidatingMutation({
  mutationFn: (level: GateStrictness) => setGateStrictness({ strictness: level }),
  invalidateKeys: [VUE_QUERY_CACHE_KEYS.cardPaymentGateStrictness],
  successKey: `${LABEL_ROOT}.saved`,
  errorKey: `${LABEL_ROOT}.saveError`,
});

const handleChange = async (value: unknown) => {
  const level = GATE_STRICTNESS_LEVELS.find((candidate) => candidate === value);
  if (!level || level === strictness.value) return;

  selected.value = level;
  try {
    await save(level);
    hasChanged.value = true;
  } catch {
    // useInvalidatingMutation already told the user what failed.
    selected.value = strictness.value;
  }
};
</script>
