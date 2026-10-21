import {
  isValidTimeZone,
  resolveRecordedZone,
  wallClockToInstant,
  zonedDayEnd,
  zonedDayStart,
  zoneOffsetMinutes,
} from '@bt/shared/time-zone';
import { ValidationError } from '@js/errors';
import { z } from 'zod';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

const HINT =
  'Use the local wall time without an offset (2026-10-21T16:00) with timeZone when it happened elsewhere, an ISO time with an offset, or a date (2026-10-21)';

type ParsedTime =
  | { kind: 'date'; year: number; month: number; day: number }
  | { kind: 'wall'; wall: WallParts }
  | { kind: 'instant'; instant: Date; offsetMinutes: number | null };

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

const isRealDay = ({ year, month, day }: { year: number; month: number; day: number }) => {
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
};

/** Reads the three shapes a tool accepts; `null` for anything else, including an impossible date. */
function parseTime({ value }: { value: string }): ParsedTime | null {
  const text = value.trim();

  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const [year, month, day] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    return isRealDay({ year, month, day }) ? { kind: 'date', year, month, day } : null;
  }

  const match = DATE_TIME.exec(text);
  if (!match) return null;

  const wall: WallParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    ms: match[7] ? Number(match[7].padEnd(3, '0')) : 0,
  };
  if (!isRealDay(wall) || wall.hour > 23 || wall.minute > 59 || wall.second > 59) return null;

  const designator = match[8];
  if (!designator) return { kind: 'wall', wall };

  const wallAsUtcMs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.ms);
  if (designator === 'Z') return { kind: 'instant', instant: new Date(wallAsUtcMs), offsetMinutes: null };

  const sign = designator.startsWith('-') ? -1 : 1;
  const digits = designator.slice(1).replace(':', '');
  const offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  if (Math.abs(offsetMinutes) > 14 * 60) return null;

  // `+00:00` claims no more about local time than `Z` does.
  return {
    kind: 'instant',
    instant: new Date(wallAsUtcMs - offsetMinutes * 60_000),
    offsetMinutes: offsetMinutes === 0 ? null : offsetMinutes,
  };
}

/** Whether `value` is a date, a wall clock or an ISO time with `Z` or an offset. */
export function isTimeInput({ value }: { value: string }): boolean {
  return parseTime({ value }) !== null;
}

const parseOrThrow = ({ value }: { value: string }): ParsedTime => {
  const parsed = parseTime({ value });
  if (!parsed) throw new ValidationError({ message: `"${value}" is not a valid time. ${HINT}` });
  return parsed;
};

const assertKnownZone = ({ zone }: { zone: string }) => {
  if (!isValidTimeZone({ zone })) throw new ValidationError({ message: `"${zone}" is not an IANA time zone` });
};

/** The instant a date or wall clock names in `zone`. A date is local noon, the rule imports use. */
function readInZone({ parsed, zone }: { parsed: ParsedTime & { kind: 'date' | 'wall' }; zone: string }): Date {
  const wall: WallParts =
    parsed.kind === 'date'
      ? { year: parsed.year, month: parsed.month, day: parsed.day, hour: 12, minute: 0, second: 0, ms: 0 }
      : parsed.wall;
  return wallClockToInstant({ wall, zone });
}

function assertOffsetAgrees({
  instant,
  offsetMinutes,
  timeZone,
}: {
  instant: Date;
  offsetMinutes: number | null;
  timeZone: string | null | undefined;
}) {
  if (!timeZone || offsetMinutes === null) return;
  if (zoneOffsetMinutes({ zone: timeZone, instant }) !== offsetMinutes) {
    throw new ValidationError({
      message: `The offset in the time contradicts timeZone ${timeZone}. Send the local wall time (2026-10-21T16:00) and timeZone instead of converting it yourself`,
    });
  }
}

export interface ResolvedCreateTime {
  /** `undefined` when no time was given: the service uses now. */
  time: Date | undefined;
  timeZone: string | null;
  utcOffsetMinutes: number | null | undefined;
}

export interface ResolvedUpdateTime {
  time: Date | undefined;
  /** Present only when the caller passed `timeZone` (`null` clears it). */
  timeZone?: string | null;
}

/**
 * Turns a tool's `time` and `timeZone` into the instant and the zone the row records.
 *
 * `viewingZone` (`getUserTimeZone`, the `UTC` fallback included) is where a wall clock without a
 * zone is read; `storedZone` (`getStoredUserTimeZone`) is the candidate a created row records, so a
 * user with no setting records nothing.
 *
 * - `create`: the row records `timeZone` when given, else a matching offset's zone, else the stored zone.
 * - `update`: the row keeps its zone unless `timeZone` is passed; the service recomputes the offset.
 */
export function resolveTimeInput(params: {
  mode: 'create';
  value?: string;
  timeZone?: string | null;
  viewingZone: string;
  storedZone: string | null;
}): ResolvedCreateTime;
export function resolveTimeInput(params: {
  mode: 'update';
  value?: string;
  timeZone?: string | null;
  viewingZone: string;
  storedZone: string | null;
}): ResolvedUpdateTime;
export function resolveTimeInput({
  mode,
  value,
  timeZone,
  viewingZone,
  storedZone,
}: {
  mode: 'create' | 'update';
  value?: string;
  timeZone?: string | null;
  viewingZone: string;
  storedZone: string | null;
}): ResolvedCreateTime | ResolvedUpdateTime {
  if (timeZone) assertKnownZone({ zone: timeZone });

  const parsed = value === undefined ? null : parseOrThrow({ value });

  let time: Date | undefined;
  let offsetMinutes: number | null = null;

  if (parsed === null) {
    time = undefined;
  } else if (parsed.kind === 'instant') {
    time = parsed.instant;
    offsetMinutes = parsed.offsetMinutes;
    assertOffsetAgrees({ instant: time, offsetMinutes, timeZone });
  } else {
    time = readInZone({ parsed, zone: timeZone || viewingZone });
  }

  if (mode === 'update') {
    return timeZone === undefined ? { time } : { time, timeZone };
  }

  if (time === undefined) {
    return { time, timeZone: timeZone || storedZone, utcOffsetMinutes: undefined };
  }

  const recorded = resolveRecordedZone({
    instant: time,
    explicitZone: timeZone,
    offsetMinutes: offsetMinutes ?? undefined,
    candidateZone: storedZone,
  });
  return { time, ...recorded };
}

/**
 * A range bound as an instant. A date is the first (`start`) or last (`end`) moment of that day in
 * `zone`; a wall clock is read in `zone`; a `Z` or offset time is exact.
 */
export function resolveRangeBound({ value, edge, zone }: { value: string; edge: 'start' | 'end'; zone: string }): Date {
  const parsed = parseOrThrow({ value });

  if (parsed.kind === 'instant') return parsed.instant;
  if (parsed.kind === 'wall') return wallClockToInstant({ wall: parsed.wall, zone });

  const date = value.trim();
  return edge === 'start' ? zonedDayStart({ date, zone }) : zonedDayEnd({ date, zone });
}

/** The `time` argument of a tool: a date, a wall clock, or an ISO time with `Z` or an offset. */
export const timeInputSchema = () =>
  z.string().refine((value) => isTimeInput({ value }), { message: `Not a valid time. ${HINT}` });

/**
 * Rewrites the start and end bound fields of `args` as `Z` strings cut in `zone`, leaving other
 * keys and non-string values (`null` clears a bound, `undefined` leaves it) as they are.
 */
export function normalizeRangeBounds<T extends object>({
  args,
  startKey,
  endKey,
  zone,
}: {
  args: T;
  startKey: keyof T & string;
  endKey: keyof T & string;
  zone: string;
}): T {
  const next = { ...args } as Record<string, unknown>;
  for (const [key, edge] of [
    [startKey, 'start'],
    [endKey, 'end'],
  ] as const) {
    const value = next[key];
    if (typeof value === 'string') next[key] = resolveRangeBound({ value, edge, zone }).toISOString();
  }
  return next as T;
}
