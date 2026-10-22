import { isValidTimeZone, resolveRecordedZone, type RecordedZone } from '@bt/shared/time-zone';
import { getStoredUserTimeZone } from '@services/user-settings/get-user-time-zone';

/**
 * The zones an import works with.
 * - `anchorZone` reads date-only and zone-less cells: the request's `timezone`, else the user's stored
 *   zone, else `UTC`.
 * - `candidateZone` is the zone an imported row may record: the request's `timezone`, else the stored
 *   zone, else `null`, so `UTC` is never recorded for a user nobody gave a zone.
 *
 * An invalid request zone counts as absent.
 */
export const resolveImportZones = async ({
  userId,
  timezone,
}: {
  userId: number;
  timezone?: string | null;
}): Promise<{ anchorZone: string; candidateZone: string | null }> => {
  const requestZone = timezone && isValidTimeZone({ zone: timezone }) ? timezone : null;
  const candidateZone = requestZone ?? (await getStoredUserTimeZone({ userId }));

  return { anchorZone: candidateZone ?? 'UTC', candidateZone };
};

/** The zone and offset an imported row records: the offset its cell wrote is kept, a zone-free cell takes the candidate. */
export const recordedZoneOfImportedRow = ({
  instant,
  offsetMinutes,
  candidateZone,
}: {
  instant: Date;
  offsetMinutes?: number | null;
  candidateZone: string | null;
}): RecordedZone => resolveRecordedZone({ instant, offsetMinutes, candidateZone });
