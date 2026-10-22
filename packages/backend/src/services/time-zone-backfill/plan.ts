import { wallClockToInstant, zoneOffsetMinutes } from '@bt/shared/time-zone';

import { type BackfillGroup, SHEET_ANCHOR_OFFSET_MINUTES } from './groups';

const MS_PER_MINUTE = 60_000;

/**
 * The instant that has the same wall clock in `zone` as `instant` has at the sheet's fixed anchor
 * offset: what the owner typed, placed where they were.
 */
export function shiftToZoneWallClock({ instant, zone }: { instant: Date; zone: string }): Date {
  const wall = new Date(instant.getTime() + SHEET_ANCHOR_OFFSET_MINUTES * MS_PER_MINUTE);

  return wallClockToInstant({
    wall: {
      year: wall.getUTCFullYear(),
      month: wall.getUTCMonth() + 1,
      day: wall.getUTCDate(),
      hour: wall.getUTCHours(),
      minute: wall.getUTCMinutes(),
      second: wall.getUTCSeconds(),
      ms: wall.getUTCMilliseconds(),
    },
    zone,
  });
}

const isInWindow = ({ instant, from, to }: { instant: Date; from: Date | null; to: Date | null }) =>
  (from === null || instant >= from) && (to === null || instant < to);

/** The group whose windows hold `instant`, or `null` when none does. Windows must not overlap across groups. */
export function findGroup({ instant, groups }: { instant: Date; groups: BackfillGroup[] }): BackfillGroup | null {
  const matches = groups.filter((group) => group.windows.some((window) => isInWindow({ instant, ...window })));

  if (matches.length > 1) {
    throw new Error(
      `Instant ${instant.toISOString()} falls in several groups: ${matches.map((g) => g.key).join(', ')}`,
    );
  }

  return matches[0] ?? null;
}

export interface PlannedMove {
  newTime: Date;
  zone: string;
  utcOffsetMinutes: number;
}

/** The corrected instant, the zone and the offset at the corrected instant for a row of `group`. */
export function planMove({ time, group }: { time: Date; group: BackfillGroup }): PlannedMove {
  const newTime = shiftToZoneWallClock({ instant: time, zone: group.zone });

  return { newTime, zone: group.zone, utcOffsetMinutes: zoneOffsetMinutes({ zone: group.zone, instant: newTime }) };
}

const dayKey = ({ instant, zone }: { instant: Date; zone: string }) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    instant,
  );

/** True when the calendar day of the row differs between the two instants, read in `zone`. */
export const changesDayIn = ({ before, after, zone }: { before: Date; after: Date; zone: string }) =>
  dayKey({ instant: before, zone }) !== dayKey({ instant: after, zone });

/** Groups must cover every instant exactly once: no overlapping windows, no uncovered stretch. */
export function assertGroupsPartitionTimeline({ groups }: { groups: BackfillGroup[] }): void {
  const windows = groups
    .flatMap((group) => group.windows.map((window) => ({ ...window, key: group.key })))
    .toSorted((a, b) => (a.from?.getTime() ?? -Infinity) - (b.from?.getTime() ?? -Infinity));

  let cursor: number | null = -Infinity;

  for (const window of windows) {
    const from = window.from?.getTime() ?? -Infinity;

    if (cursor === null) throw new Error(`Window of "${window.key}" starts after an open-ended window`);
    if (from < cursor) throw new Error(`Window of "${window.key}" overlaps the previous window`);
    if (from > cursor) throw new Error(`Gap before the window of "${window.key}"`);

    cursor = window.to === null ? null : window.to.getTime();
  }

  if (cursor !== null) throw new Error('The last window must be open-ended');
}
