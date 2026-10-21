// Intl also accepts fixed offsets such as `+04:00`; an offset is not a zone, so only IANA-shaped names pass.
const IANA_NAME_PATTERN = /^(UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/** True when `zone` is an IANA zone name the runtime's Intl database knows. */
export function isValidTimeZone({ zone }: { zone: string }): boolean {
  if (!zone || zone.length > 64 || !IANA_NAME_PATTERN.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const getFormatter = ({ zone }: { zone: string }) => {
  let formatter = formatterCache.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(zone, formatter);
  }
  return formatter;
};

/**
 * Offset of `zone` from UTC at `instant`, in minutes, positive east of UTC.
 * Throws a RangeError when `zone` is not a valid zone name.
 */
export function zoneOffsetMinutes({ zone, instant }: { zone: string; instant: Date }): number {
  const lookup: Record<string, string> = {};
  for (const part of getFormatter({ zone }).formatToParts(instant)) {
    lookup[part.type] = part.value;
  }

  const hour = lookup.hour === '24' ? 0 : Number(lookup.hour);
  const wallAsUtcMs = Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day),
    hour,
    Number(lookup.minute),
    Number(lookup.second),
  );
  // The formatter drops sub-second precision; align the instant to whole seconds.
  const instantWholeSecondMs = Math.floor(instant.getTime() / 1000) * 1000;

  return Math.round((wallAsUtcMs - instantWholeSecondMs) / 60_000);
}
