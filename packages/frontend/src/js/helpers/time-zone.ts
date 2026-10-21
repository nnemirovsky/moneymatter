import type { HourCycle, TimeZoneSource } from '@bt/shared/types';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { ref } from 'vue';

export const deviceTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

// Module-level, like `currencyDisplayPreference`, so plain helpers follow the user's setting.
/** Zone every time on screen is shown in; `app.vue` keeps it in step with the settings. */
export const viewingTimeZone = ref<string>(deviceTimeZone());

/** `null` follows the UI language's 12/24-hour convention. */
export const hourCyclePreference = ref<HourCycle | null>(null);

export const resolveViewingTimeZone = ({
  settings,
  deviceZone,
}: {
  settings: { timeZone?: string; timeZoneSource?: TimeZoneSource } | undefined;
  deviceZone: string;
}): string => (settings?.timeZoneSource === 'manual' && settings.timeZone ? settings.timeZone : deviceZone);

export const formatInViewingZone = ({ date, pattern }: { date: Date; pattern: string }): string =>
  format(new TZDate(date, viewingTimeZone.value), pattern);

/** `HH:mm`, or `h:mm a` under `h12`; without a preference the locale's `p` decides. */
export const formatTime = ({ date, zone = viewingTimeZone.value }: { date: Date; zone?: string }): string => {
  const pattern = hourCyclePreference.value === 'h23' ? 'HH:mm' : hourCyclePreference.value === 'h12' ? 'h:mm a' : 'p';
  return format(new TZDate(date, zone), pattern);
};

/** Short offset label such as `GMT+4`, valid at the given instant (DST included). */
export const formatZoneLabel = ({ date, zone = viewingTimeZone.value }: { date: Date; zone?: string }): string => {
  const part = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? zone;
};

/** `21 Oct 2026, 16:00 GMT+4` */
export const formatDateTime = ({ date, zone = viewingTimeZone.value }: { date: Date; zone?: string }): string =>
  `${format(new TZDate(date, zone), 'd MMM y')}, ${formatTime({ date, zone })} ${formatZoneLabel({ date, zone })}`;
