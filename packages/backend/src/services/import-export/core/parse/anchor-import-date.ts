import { type ParsedImportDate } from '@bt/shared/import-export/date-engine';
import { type WallClock, wallClockToInstant } from '@bt/shared/time-zone';

interface AnchorImportDateParams {
  parsed: ParsedImportDate;
  /** IANA timezone of the importing user's browser (e.g. `America/Montevideo`). */
  timezone: string | undefined;
}

/**
 * Resolves the engine's timezone-agnostic parse result into the absolute moment
 * stored on the transaction.
 *
 * The engine deliberately applies no timezone, so the calendar-day decision is
 * made here against the importing user's `timezone`:
 *
 * - `instant` already carries an absolute moment (the cell had an explicit zone)
 *   and is returned unchanged.
 * - `dateOnly` is anchored to **local noon** in `timezone`. Noon (not midnight)
 *   guarantees the stored instant renders as the same calendar day for that user
 *   and for any viewer within ±11h of them, and can't slip across a DST edge.
 * - `localDateTime` interprets its wall-clock components as a local time in
 *   `timezone`.
 *
 * Anchoring uses the runtime's IANA timezone database via `Intl.DateTimeFormat`
 * (`wallClockToInstant`). A wall clock inside a DST gap moves forward by the gap and one
 * inside an overlap takes the earlier instant. If `timezone` is missing or not
 * a valid IANA zone, it falls back to UTC: UTC noon for `dateOnly` (which still
 * lands on the right day for every zone within ±11h) and UTC wall-clock for
 * `localDateTime`, rather than throwing.
 */
export function anchorImportDate({ parsed, timezone }: AnchorImportDateParams): Date {
  return anchorImportDateWithOffset({ parsed, timezone }).instant;
}

/**
 * `anchorImportDate` plus the offset the cell carried about local time: set only for a datetime
 * written with a `±hh:mm` offset, `null` for a date, a zone-less datetime or a `Z` instant.
 */
export function anchorImportDateWithOffset({ parsed, timezone }: AnchorImportDateParams): {
  instant: Date;
  offsetMinutes: number | null;
} {
  return { instant: anchorToInstant({ parsed, timezone }), offsetMinutes: statedOffsetOf({ parsed }) };
}

function statedOffsetOf({ parsed }: { parsed: ParsedImportDate }): number | null {
  return parsed.kind === 'instant' ? (parsed.offsetMinutes ?? null) : null;
}

function anchorToInstant({ parsed, timezone }: AnchorImportDateParams): Date {
  if (parsed.kind === 'instant') {
    return parsed.instant;
  }

  if (parsed.kind === 'dateOnly') {
    return zonedWallClockToInstant({
      wall: { year: parsed.year, month: parsed.month, day: parsed.day, hour: 12, minute: 0, second: 0, ms: 0 },
      timezone,
    });
  }

  return zonedWallClockToInstant({
    wall: {
      year: parsed.year,
      month: parsed.month,
      day: parsed.day,
      hour: parsed.hour,
      minute: parsed.minute,
      second: parsed.second,
      ms: parsed.ms,
    },
    timezone,
  });
}

/**
 * Converts wall-clock components, read as a local time in `timezone`, to the
 * absolute UTC instant. Falls back to interpreting them as UTC when `timezone`
 * is absent or invalid.
 */
function zonedWallClockToInstant({ wall, timezone }: { wall: WallClock; timezone: string | undefined }): Date {
  if (timezone) {
    try {
      return wallClockToInstant({ wall, zone: timezone });
    } catch {
      // Unknown IANA zone — treat the wall-clock components as UTC instead of
      // crashing the whole import.
    }
  }

  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.ms));
}
