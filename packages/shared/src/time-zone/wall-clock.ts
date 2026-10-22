import { zoneOffsetMinutes } from './zone-offset';

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

const DAY_MS = 86_400_000;

/**
 * Converts wall-clock components read in `zone` to the instant they name.
 *
 * Nonexistent and ambiguous times follow one rule, whichever side of UTC the zone is on:
 * - a wall clock inside a spring-forward gap moves forward by the gap
 *   (New York 2026-03-08 02:30 is 03:30 EDT, `07:30Z`);
 * - a wall clock inside a fall-back overlap takes the earlier instant
 *   (New York 2026-11-01 01:30 is 01:30 EDT, `05:30Z`).
 *
 * Throws a RangeError when `zone` is not a valid zone name.
 */
export function wallClockToInstant({ wall, zone }: { wall: WallClock; zone: string }): Date {
  const guessMs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.ms);

  // At most one transition falls within a day of the wall clock, so the offsets a
  // day either side are the only two the wall clock can have been read under.
  const offsetBefore = zoneOffsetMinutes({ zone, instant: new Date(guessMs - DAY_MS) });
  const offsetAfter = zoneOffsetMinutes({ zone, instant: new Date(guessMs + DAY_MS) });

  const candidates = [...new Set([offsetBefore, offsetAfter])]
    .filter((offset) => zoneOffsetMinutes({ zone, instant: new Date(guessMs - offset * 60_000) }) === offset)
    .map((offset) => guessMs - offset * 60_000);

  if (candidates.length > 0) {
    return new Date(Math.min(...candidates));
  }

  // Inside a gap no offset reproduces itself; the pre-transition offset moves the clock forward.
  return new Date(guessMs - offsetBefore * 60_000);
}
