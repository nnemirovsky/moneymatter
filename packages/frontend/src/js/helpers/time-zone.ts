import { formatOffset, zoneOffsetMinutes } from '@bt/shared/time-zone';
import type { HourCycle, TimeZoneSource } from '@bt/shared/types';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { Locale } from 'date-fns';
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

export const formatInViewingZone = ({
  date,
  pattern,
  locale,
}: {
  date: Date;
  pattern: string;
  locale?: Locale;
}): string => format(new TZDate(date, viewingTimeZone.value), pattern, { locale });

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

const recordedOffsetMinutes = ({
  timeZone,
  utcOffsetMinutes,
  instant,
}: {
  timeZone: string | null | undefined;
  utcOffsetMinutes: number | null | undefined;
  instant: Date;
}): number | null => (timeZone ? zoneOffsetMinutes({ zone: timeZone, instant }) : (utcOffsetMinutes ?? null));

/**
 * The only gate for showing a transaction's own zone beside the viewing-zone time. An unknown zone
 * (`null`/`null`) and a zone whose offset equals the viewing zone's at that instant show nothing.
 */
export const hasDistinctRecordedZone = ({
  timeZone,
  utcOffsetMinutes,
  viewingZone,
  instant,
}: {
  timeZone: string | null | undefined;
  utcOffsetMinutes: number | null | undefined;
  viewingZone: string;
  instant: Date;
}): boolean => {
  const recorded = recordedOffsetMinutes({ timeZone, utcOffsetMinutes, instant });
  if (recorded === null) return false;
  return recorded !== zoneOffsetMinutes({ zone: viewingZone, instant });
};

/** `America/New_York: 08:00 GMT-4`, or `UTC+02:00: 14:00` for a row that stored only an offset. */
export const formatRecordedZoneLine = ({
  timeZone,
  utcOffsetMinutes,
  instant,
}: {
  timeZone: string | null | undefined;
  utcOffsetMinutes: number | null | undefined;
  instant: Date;
}): string => {
  if (timeZone) {
    return `${timeZone}: ${formatTime({ date: instant, zone: timeZone })} ${formatZoneLabel({ date: instant, zone: timeZone })}`;
  }
  const offset = utcOffsetMinutes ?? 0;
  const shifted = new Date(instant.getTime() + offset * 60_000);
  return `${formatOffset({ minutes: offset })}: ${formatTime({ date: shifted, zone: 'UTC' })}`;
};

/** Locale-aware date with the clock setting's time: `Oct 21, 2026, 16:00`. */
export const formatDateWithTime = ({
  date,
  zone = viewingTimeZone.value,
  locale,
}: {
  date: Date;
  zone?: string;
  locale?: Locale;
}): string => `${format(new TZDate(date, zone), 'PP', { locale })}, ${formatTime({ date, zone })}`;

/**
 * Lines of a transaction date tooltip: the instant in the viewing zone and, only when the row's own
 * zone differs from it, that zone's rendering of the same instant (`null` otherwise).
 */
export const getTransactionTimeTooltip = ({
  time,
  timeZone,
  utcOffsetMinutes,
}: {
  time: string | number | Date;
  timeZone: string | null | undefined;
  utcOffsetMinutes: number | null | undefined;
}): { primary: string; recordedLine: string | null } => {
  const instant = new Date(time);
  const distinct = hasDistinctRecordedZone({
    timeZone,
    utcOffsetMinutes,
    viewingZone: viewingTimeZone.value,
    instant,
  });
  return {
    primary: formatDateTime({ date: instant }),
    recordedLine: distinct ? formatRecordedZoneLine({ timeZone, utcOffsetMinutes, instant }) : null,
  };
};
