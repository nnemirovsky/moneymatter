import { INGEST_REQUEST_RETENTION_DAYS } from '@bt/shared/types';
import { connection } from '@models/connection';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { resolveCardsElsewhere, sweepOrphanedInboxCards } from '@services/chat/inbox/inbox-resolution';
import { notificationTimings } from '@services/ingest/event/constants';
import { UNCLASSIFIED_PARK_REASONS } from '@services/ingest/event/stored-parse';
import {
  purgeResolvedSuggestions,
  sweepOrphanedSuggestions,
} from '@services/transactions/reconciliation/duplicate-suggestions';
import { subDays } from 'date-fns';
import { Op, QueryTypes } from 'sequelize';

import { createScheduledSync } from './lib/create-scheduled-sync';

interface IngestCleanupResult {
  /** Requests that reached a final outcome and passed the retention period. */
  deleted: number;
  /** Notifications that were read and are not payments, past their short keep. */
  ignoredDeleted: number;
  /** Notifications whose text was never classified, past their short keep. */
  unclassifiedExpired: number;
  /** Sources nobody approved, with what they held. */
  pendingSourcesDeleted: number;
  /** Open duplicate suggestions whose transaction was removed by a path that did not mark them. */
  suggestionsSwept: number;
  /** Merged and stale duplicate suggestions past their keep. */
  suggestionsDeleted: number;
  /** Waiting inbox cards whose record was settled or deleted by a path that did not close them. */
  inboxCardsSwept: number;
}

/**
 * Deletes requests that reached a final outcome and have not changed for the retention period.
 * Waiting requests (`parked`, `received`) stay until the user logs or dismisses them: they hold
 * a payment that exists nowhere else, with one exception below.
 */
const deleteFinishedRequests = async (): Promise<number> =>
  IngestRequests.destroy({
    where: {
      status: { [Op.in]: ['logged', 'rejected', 'dismissed'] },
      updatedAt: { [Op.lt]: subDays(new Date(), INGEST_REQUEST_RETENTION_DAYS) },
    },
  });

/** A notification that was read and is not a payment keeps nothing worth more than a week. */
const deleteIgnoredRequests = async (): Promise<number> =>
  IngestRequests.destroy({
    where: {
      pipeline: 'notification',
      status: 'ignored',
      updatedAt: { [Op.lt]: new Date(Date.now() - notificationTimings.ignoredTtlMs) },
    },
  });

/**
 * Notification text that was never classified (the source was not approved, no AI could read it,
 * processing failed) is kept at most a week. The row goes with it, and the source counts it as
 * `expiredUnclassified`, so the owner can see the text was lost rather than silently ignored.
 */
const expireUnclassifiedRequests = async (): Promise<number> => {
  const expired = (await connection.sequelize.query(
    `DELETE FROM "IngestRequests"
      WHERE "pipeline" = 'notification'
        AND "status" = 'parked'
        AND "reason" IN (:reasons)
        AND "createdAt" < :cutoff
      RETURNING "userId", "sourceId"`,
    {
      replacements: {
        reasons: [...UNCLASSIFIED_PARK_REASONS, 'processingFailed'],
        cutoff: new Date(Date.now() - notificationTimings.unclassifiedTextTtlMs),
      },
      type: QueryTypes.SELECT,
    },
  )) as { userId: number; sourceId: string | null }[];

  const perSource = new Map<string, number>();
  for (const { sourceId } of expired) {
    if (sourceId) perSource.set(sourceId, (perSource.get(sourceId) ?? 0) + 1);
  }

  for (const [sourceId, count] of perSource) {
    await connection.sequelize.query(
      `UPDATE "NotificationSources"
          SET "counters" = jsonb_set("counters", ARRAY['expiredUnclassified'], to_jsonb(COALESCE(("counters"->>'expiredUnclassified')::int, 0) + :count)),
              "updatedAt" = NOW()
        WHERE "id" = :sourceId`,
      { replacements: { sourceId, count }, type: QueryTypes.UPDATE },
    );
  }

  return expired.length;
};

/**
 * A source nobody approved within its keep is deleted with everything it holds, so an unapproved
 * contact's name does not linger in backups. Requests that were already read keep their row; the
 * link to the source is cleared by the foreign key.
 */
const deleteStalePendingSources = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - notificationTimings.pendingSourceTtlMs);
  const stale = await NotificationSources.findAll({
    where: { mode: 'pending', createdAt: { [Op.lt]: cutoff } },
    attributes: ['id', 'proposalId'],
  });
  if (!stale.length) return 0;

  const sourceIds = stale.map((source) => source.id);
  // The cards that asked about these sources have nothing left to ask.
  await resolveCardsElsewhere({ proposalIds: stale.map((source) => source.proposalId) });
  await IngestRequests.destroy({
    where: {
      sourceId: { [Op.in]: sourceIds },
      pipeline: 'notification',
      status: 'parked',
      reason: { [Op.in]: [...UNCLASSIFIED_PARK_REASONS, 'processingFailed'] },
    },
  });

  return NotificationSources.destroy({ where: { id: { [Op.in]: sourceIds } } });
};

const runCleanup = async (): Promise<IngestCleanupResult> => ({
  deleted: await deleteFinishedRequests(),
  ignoredDeleted: await deleteIgnoredRequests(),
  unclassifiedExpired: await expireUnclassifiedRequests(),
  pendingSourcesDeleted: await deleteStalePendingSources(),
  suggestionsSwept: (await sweepOrphanedSuggestions()).length,
  suggestionsDeleted: await purgeResolvedSuggestions(),
  inboxCardsSwept: await sweepOrphanedInboxCards(),
});

/** Schedule: 04:30 UTC daily, after the other retention sweeps. */
export const ingestRequestsCleanupCron = createScheduledSync({
  name: 'cleanup of finished ingest requests',
  cronExpression: '30 4 * * *',
  timeZone: 'UTC',
  scheduleDescription: 'runs daily at 04:30 UTC',
  errorCode: 'INGEST_REQUESTS_CLEANUP_CRON',
  run: runCleanup,
});
