import { zoneOffsetMinutes } from './zone-offset';

export interface RecordedZone {
  timeZone: string | null;
  utcOffsetMinutes: number | null;
}

/** The widest offset the `utcOffsetMinutes` column holds (UTC+14:00 is the largest real one). */
export const MAX_UTC_OFFSET_MINUTES = 840;

/**
 * The stated offset when it can be an offset of a real zone, else `null`. A malformed or
 * buggy source can send `+23:59`; its instant is still right, but the offset is not stored.
 */
export const usableOffsetMinutes = ({ offsetMinutes }: { offsetMinutes?: number | null }): number | null =>
  offsetMinutes !== undefined &&
  offsetMinutes !== null &&
  Number.isInteger(offsetMinutes) &&
  Math.abs(offsetMinutes) <= MAX_UTC_OFFSET_MINUTES
    ? offsetMinutes
    : null;

/**
 * Decides which zone and offset a transaction records for `instant`:
 * 1. `explicitZone` given: that zone, offset derived from it;
 * 2. `offsetMinutes` given and `candidateZone` has that offset at `instant`: the candidate;
 * 3. `offsetMinutes` given otherwise: no zone, just the offset;
 * 4. `candidateZone` given: the candidate, offset derived from it;
 * 5. nothing: `null` / `null`.
 *
 * `offsetMinutes` is an offset the source stated about local time. A `Z` instant states
 * none, so callers leave it undefined (never 0). `candidateZone` is a zone somebody chose,
 * never a fallback.
 */
export function resolveRecordedZone({
  instant,
  explicitZone,
  offsetMinutes,
  candidateZone,
}: {
  instant: Date;
  explicitZone?: string | null;
  offsetMinutes?: number | null;
  candidateZone?: string | null;
}): RecordedZone {
  if (explicitZone) {
    return { timeZone: explicitZone, utcOffsetMinutes: zoneOffsetMinutes({ zone: explicitZone, instant }) };
  }

  const stated = usableOffsetMinutes({ offsetMinutes });

  if (stated !== null) {
    if (candidateZone && zoneOffsetMinutes({ zone: candidateZone, instant }) === stated) {
      return { timeZone: candidateZone, utcOffsetMinutes: stated };
    }
    return { timeZone: null, utcOffsetMinutes: stated };
  }

  if (candidateZone) {
    return { timeZone: candidateZone, utcOffsetMinutes: zoneOffsetMinutes({ zone: candidateZone, instant }) };
  }

  return { timeZone: null, utcOffsetMinutes: null };
}
