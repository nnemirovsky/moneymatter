import { resolveRecordedZone, type RecordedZone } from '@bt/shared/time-zone';

/**
 * A bank row dated this close to its sync most likely happened where the user is now. Further back
 * (an initial sync pulls up to 90 days) the user may have been elsewhere, so no zone is recorded.
 */
export const BANK_SYNC_RECENT_ZONE_WINDOW_DAYS = 3;

const WINDOW_MS = BANK_SYNC_RECENT_ZONE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * The zone and offset a bank-synced row records.
 *
 * - Within `BANK_SYNC_RECENT_ZONE_WINDOW_DAYS` of `syncedAt` (before or after), the user's stored zone,
 *   with the offset at `time`.
 * - Otherwise, or when the user has no stored zone, `null` / `null`: a zone nobody chose is never stamped.
 *
 * `syncedAt` is the sync's start time, read once, so every row of one sync is judged against the same moment.
 */
export const bankSyncRecordedZone = ({
  time,
  syncedAt,
  userZone,
}: {
  time: Date;
  syncedAt: Date;
  userZone: string | null;
}): RecordedZone => {
  const isRecent = Math.abs(syncedAt.getTime() - time.getTime()) <= WINDOW_MS;

  return resolveRecordedZone({ instant: time, candidateZone: isRecent ? userZone : null });
};
