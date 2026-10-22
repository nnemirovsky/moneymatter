<template>
  <div class="space-y-4 border-t pt-6">
    <div>
      <h3 class="text-lg font-semibold">{{ $t('settings.language.timeZone.title') }}</h3>
      <p class="text-muted-foreground mt-1 text-sm">{{ $t('settings.language.timeZone.description') }}</p>
    </div>

    <div class="max-w-md">
      <FieldLabel :label="$t('settings.language.timeZone.zoneLabel')">
        <TimeZoneSelectField
          :model-value="selectedZoneValue"
          :special-options="specialOptions"
          :placeholder="$t('settings.language.timeZone.placeholder')"
          :disabled="isPatching || !userSettings"
          @update:model-value="handleZoneChange"
        />
      </FieldLabel>
    </div>

    <div>
      <div class="text-muted-foreground mb-1 text-[13px]/[1.3] font-medium">
        {{ $t('settings.language.timeZone.clockLabel') }}
      </div>
      <div class="flex flex-wrap gap-2">
        <Button
          v-for="option in clockOptions"
          :key="option.value ?? 'automatic'"
          :variant="(userSettings?.hourCycle ?? null) === option.value ? 'default' : 'outline'"
          size="sm"
          :disabled="isPatching || !userSettings"
          @click="handleClockChange(option.value)"
        >
          {{ option.label }}
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import FieldLabel from '@/components/fields/components/field-label.vue';
import TimeZoneSelectField from '@/components/fields/time-zone-select-field.vue';
import Button from '@/components/lib/ui/button/Button.vue';
import { useNotificationCenter } from '@/components/notification-center';
import { useUserSettings } from '@/composable/data-queries/user-settings';
import { deviceTimeZone } from '@/js/helpers/time-zone';
import type { HourCycle } from '@bt/shared/types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

// Stands for "follow the device" in the zone picker; it cannot collide with an IANA name.
const AUTOMATIC_VALUE = '__automatic__';

const { t } = useI18n();
const { addSuccessNotification } = useNotificationCenter();
const { data: userSettings, patchAsync, isPatching } = useUserSettings();

const specialOptions = computed(() => [
  { value: AUTOMATIC_VALUE, label: t('settings.language.timeZone.automatic', { zone: deviceTimeZone() }) },
]);

const selectedZoneValue = computed(() =>
  userSettings.value?.timeZoneSource === 'manual' && userSettings.value.timeZone
    ? userSettings.value.timeZone
    : AUTOMATIC_VALUE,
);

const clockOptions = computed<{ value: HourCycle | null; label: string }[]>(() => [
  { value: null, label: t('settings.language.timeZone.clock.automatic') },
  { value: 'h23', label: t('settings.language.timeZone.clock.h23') },
  { value: 'h12', label: t('settings.language.timeZone.clock.h12') },
]);

// The patch error handler of `useUserSettings` already reports a failure.
const savePatch = async ({
  patch,
  successMessage,
}: {
  patch: Parameters<typeof patchAsync>[0];
  successMessage: string;
}) => {
  try {
    await patchAsync(patch);
    addSuccessNotification(successMessage);
  } catch {
    // reported by the mutation's onError
  }
};

const handleZoneChange = (value: string) =>
  savePatch({
    patch:
      value === AUTOMATIC_VALUE
        ? { timeZoneSource: 'device', timeZone: deviceTimeZone() }
        : { timeZoneSource: 'manual', timeZone: value },
    successMessage: t('settings.language.timeZone.zoneSaved'),
  });

const handleClockChange = (value: HourCycle | null) =>
  savePatch({ patch: { hourCycle: value }, successMessage: t('settings.language.timeZone.clockSaved') });
</script>
