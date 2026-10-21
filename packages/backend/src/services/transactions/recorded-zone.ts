import { zoneOffsetMinutes } from '@bt/shared/time-zone';

interface StoredZonePair {
  timeZone: string | null;
  utcOffsetMinutes: number | null;
}

/**
 * The pair to store for a row at `time`: a zone always has its offset derived from it, so the two
 * columns cannot disagree. Without a zone the stated offset (an ISO offset a source sent) is kept as is.
 */
export const deriveStoredZone = ({
  time,
  timeZone,
  utcOffsetMinutes,
}: {
  time: Date;
  timeZone?: string | null;
  utcOffsetMinutes?: number | null;
}): StoredZonePair => {
  if (timeZone) {
    return { timeZone, utcOffsetMinutes: zoneOffsetMinutes({ zone: timeZone, instant: time }) };
  }

  return { timeZone: null, utcOffsetMinutes: utcOffsetMinutes ?? null };
};

/**
 * The zone columns an edit changes, or `{}` when it changes neither:
 * - `timeZone: null` clears both columns;
 * - a `timeZone` records it, with the offset at the row's (new or stored) time;
 * - a new `time` alone recomputes the offset in the stored zone, or keeps a stored offset-only value;
 * - an edit that touches neither leaves the row's zone as it is.
 */
export const deriveZoneUpdate = ({
  time,
  timeZone,
  stored,
}: {
  time?: Date;
  timeZone?: string | null;
  stored: { time: Date; timeZone: string | null; utcOffsetMinutes: number | null };
}): Partial<StoredZonePair> => {
  if (timeZone === null) return { timeZone: null, utcOffsetMinutes: null };

  if (timeZone !== undefined) {
    return deriveStoredZone({ time: time ?? stored.time, timeZone });
  }

  if (time !== undefined && time.getTime() !== stored.time.getTime() && stored.timeZone) {
    return deriveStoredZone({ time, timeZone: stored.timeZone });
  }

  return {};
};
