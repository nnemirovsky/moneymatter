import { wallClockToInstant } from './wall-clock';

const parseDay = ({ date }: { date: string }) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`Invalid day "${date}", expected YYYY-MM-DD`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
};

/** The instant of local 00:00 on a `YYYY-MM-DD` day in `zone`. */
export function zonedDayStart({ date, zone }: { date: string; zone: string }): Date {
  const { year, month, day } = parseDay({ date });
  return wallClockToInstant({ wall: { year, month, day, hour: 0, minute: 0, second: 0, ms: 0 }, zone });
}

/** The last millisecond of a `YYYY-MM-DD` day in `zone` (the day may be 23 or 25 hours long). */
export function zonedDayEnd({ date, zone }: { date: string; zone: string }): Date {
  const { year, month, day } = parseDay({ date });
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextStart = wallClockToInstant({
    wall: {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
      ms: 0,
    },
    zone,
  });
  return new Date(nextStart.getTime() - 1);
}
