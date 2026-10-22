import { formatZoneLabel } from '@/js/helpers/time-zone';
import { zoneOffsetMinutes } from '@bt/shared/time-zone';

interface TimeZoneOption {
  value: string;
  label: string;
  offsetMinutes: number;
}

/** Zones the runtime knows, plus `UTC`, which `supportedValuesOf` leaves out. */
export const listSupportedTimeZones = (): string[] => {
  const zones = Intl.supportedValuesOf('timeZone');
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
};

/** `GMT+4 · Asia/Tbilisi`, ordered west to east and then by name. The offset is the one in force at `now`. */
export const buildTimeZoneOptions = ({
  zones = listSupportedTimeZones(),
  now = new Date(),
}: { zones?: string[]; now?: Date } = {}): TimeZoneOption[] =>
  zones
    .map((zone) => ({
      value: zone,
      label: `${formatZoneLabel({ date: now, zone })} · ${zone}`,
      offsetMinutes: zoneOffsetMinutes({ zone, instant: now }),
    }))
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.value.localeCompare(b.value));

export const filterTimeZoneOptions = ({
  options,
  searchTerm,
}: {
  options: TimeZoneOption[];
  searchTerm: string;
}): TimeZoneOption[] => {
  const needle = searchTerm.trim().toLowerCase().replaceAll(' ', '_');
  if (!needle) return options;
  return options.filter((option) => option.label.toLowerCase().replaceAll(' ', '_').includes(needle));
};
