import { zoneOffsetMinutes } from './zone-offset';

export interface RecordedZone {
  timeZone: string | null;
  utcOffsetMinutes: number | null;
}

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

  const hasOffset = offsetMinutes !== undefined && offsetMinutes !== null;

  if (hasOffset) {
    if (candidateZone && zoneOffsetMinutes({ zone: candidateZone, instant }) === offsetMinutes) {
      return { timeZone: candidateZone, utcOffsetMinutes: offsetMinutes };
    }
    return { timeZone: null, utcOffsetMinutes: offsetMinutes };
  }

  if (candidateZone) {
    return { timeZone: candidateZone, utcOffsetMinutes: zoneOffsetMinutes({ zone: candidateZone, instant }) };
  }

  return { timeZone: null, utcOffsetMinutes: null };
}
