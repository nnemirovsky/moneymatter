import { INGEST_REQUEST_RETENTION_DAYS, type IngestRequestStatus, type RecordId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import { connection } from '@models/connection';
import IngestRequests from '@models/ingest-requests.model';
import { ingestRequestsCleanupCron } from '@root/crons/ingest-requests-cleanup';
import * as helpers from '@tests/helpers';

/** The cleanup has no HTTP surface, so this e2e invokes it directly. */

const STATUSES: IngestRequestStatus[] = ['logged', 'rejected', 'dismissed', 'parked', 'received'];

/** Seeds one request per status, last changed `daysAgo` days ago, and returns them keyed by status. */
const seedRequests = async ({ userId, daysAgo }: { userId: number; daysAgo: number }) => {
  const rows = await IngestRequests.bulkCreate(
    STATUSES.map((status) => ({
      userId,
      source: 'apple-pay',
      idempotencyKey: `${status}-${daysAgo}`,
      fingerprint: `fingerprint-${status}-${daysAgo}`,
      status,
      payload: { amount: '1.00', merchant: 'Shop', card: 'TBC Visa' },
    })),
  );

  await connection.sequelize.query(
    `UPDATE "IngestRequests" SET "createdAt" = now() - make_interval(days => :daysAgo), "updatedAt" = now() - make_interval(days => :daysAgo) WHERE id IN (:ids)`,
    { replacements: { daysAgo, ids: rows.map((row) => row.id) } },
  );

  return Object.fromEntries(rows.map((row) => [row.status, row.id])) as Record<IngestRequestStatus, RecordId>;
};

describe('Ingest requests cleanup cron', () => {
  it('deletes finished requests past the retention window and keeps waiting ones, however old', async () => {
    const user = await helpers.getUserInfo({ raw: true });
    const old = await seedRequests({ userId: user.id, daysAgo: INGEST_REQUEST_RETENTION_DAYS + 1 });
    const recent = await seedRequests({ userId: user.id, daysAgo: INGEST_REQUEST_RETENTION_DAYS - 1 });

    expect(await ingestRequestsCleanupCron.triggerManualSync()).toEqual({ deleted: 3 });

    const remaining = new Set((await IngestRequests.findAll({ attributes: ['id'] })).map((row) => row.id));
    expect(remaining.has(old.logged)).toBe(false);
    expect(remaining.has(old.rejected)).toBe(false);
    expect(remaining.has(old.dismissed)).toBe(false);
    expect(remaining.has(old.parked)).toBe(true);
    expect(remaining.has(old.received)).toBe(true);
    for (const id of Object.values(recent)) expect(remaining.has(id)).toBe(true);
  });

  it('deletes nothing when there is nothing to delete', async () => {
    expect(await ingestRequestsCleanupCron.triggerManualSync()).toEqual({ deleted: 0 });
  });
});
