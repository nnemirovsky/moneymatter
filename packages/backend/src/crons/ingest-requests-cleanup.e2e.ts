import { INGEST_REQUEST_RETENTION_DAYS, type IngestRequestStatus, type RecordId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import { connection } from '@models/connection';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { ingestRequestsCleanupCron } from '@root/crons/ingest-requests-cleanup';
import * as helpers from '@tests/helpers';

/** The cleanup has no HTTP surface, so this e2e invokes it directly. */

const NOTHING_ELSE = { ignoredDeleted: 0, unclassifiedExpired: 0, pendingSourcesDeleted: 0 };

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

const ageRows = async ({ ids, daysAgo }: { ids: RecordId[]; daysAgo: number }) =>
  connection.sequelize.query(
    `UPDATE "IngestRequests" SET "createdAt" = now() - make_interval(days => :daysAgo), "updatedAt" = now() - make_interval(days => :daysAgo) WHERE id IN (:ids)`,
    { replacements: { daysAgo, ids } },
  );

const seedNotification = async ({
  userId,
  status,
  reason = null,
  sourceId = null,
  key,
}: {
  userId: number;
  status: IngestRequestStatus;
  reason?: string | null;
  sourceId?: RecordId | null;
  key: string;
}) =>
  IngestRequests.create({
    userId,
    pipeline: 'notification',
    source: 'ios-notification',
    idempotencyKey: key,
    fingerprint: `fingerprint-${key}`,
    status,
    reason,
    sourceId,
    payload: { kind: 'notification' },
    textEnc: status === 'ignored' ? null : 'encrypted',
  });

describe('Ingest requests cleanup cron', () => {
  it('deletes finished requests past the retention window and keeps waiting ones, however old', async () => {
    const user = await helpers.getUserInfo({ raw: true });
    const old = await seedRequests({ userId: user.id, daysAgo: INGEST_REQUEST_RETENTION_DAYS + 1 });
    const recent = await seedRequests({ userId: user.id, daysAgo: INGEST_REQUEST_RETENTION_DAYS - 1 });

    expect(await ingestRequestsCleanupCron.triggerManualSync()).toEqual({ ...NOTHING_ELSE, deleted: 3 });

    const remaining = new Set((await IngestRequests.findAll({ attributes: ['id'] })).map((row) => row.id));
    expect(remaining.has(old.logged)).toBe(false);
    expect(remaining.has(old.rejected)).toBe(false);
    expect(remaining.has(old.dismissed)).toBe(false);
    expect(remaining.has(old.parked)).toBe(true);
    expect(remaining.has(old.received)).toBe(true);
    for (const id of Object.values(recent)) expect(remaining.has(id)).toBe(true);
  });

  it('deletes nothing when there is nothing to delete', async () => {
    expect(await ingestRequestsCleanupCron.triggerManualSync()).toEqual({ ...NOTHING_ELSE, deleted: 0 });
  });

  describe('notifications', () => {
    it('deletes an ignored notification after a week and keeps a younger one', async () => {
      const user = await helpers.getUserInfo({ raw: true });
      const old = await seedNotification({ userId: user.id, status: 'ignored', reason: 'promo', key: 'ignored-old' });
      const recent = await seedNotification({
        userId: user.id,
        status: 'ignored',
        reason: 'promo',
        key: 'ignored-new',
      });
      await ageRows({ ids: [old.id], daysAgo: 8 });
      await ageRows({ ids: [recent.id], daysAgo: 6 });

      expect(await ingestRequestsCleanupCron.triggerManualSync()).toEqual({
        ...NOTHING_ELSE,
        ignoredDeleted: 1,
        deleted: 0,
      });

      const remaining = new Set((await IngestRequests.findAll({ attributes: ['id'] })).map((row) => row.id));
      expect(remaining.has(old.id)).toBe(false);
      expect(remaining.has(recent.id)).toBe(true);
    });

    it('deletes text that was never classified after a week, counts it on its source and keeps classified parks', async () => {
      const user = await helpers.getUserInfo({ raw: true });
      const source = await NotificationSources.create({
        userId: user.id,
        sourceKey: 'name:tbc bank',
        appName: 'TBC Bank',
        mode: 'auto',
      });
      const unread = await seedNotification({
        userId: user.id,
        status: 'parked',
        reason: 'aiUnavailable',
        sourceId: source.id,
        key: 'unread-old',
      });
      const youngUnread = await seedNotification({
        userId: user.id,
        status: 'parked',
        reason: 'aiUnavailable',
        sourceId: source.id,
        key: 'unread-new',
      });
      const classified = await seedNotification({
        userId: user.id,
        status: 'parked',
        reason: 'unknownAccount',
        sourceId: source.id,
        key: 'classified-old',
      });
      await ageRows({ ids: [unread.id, classified.id], daysAgo: 8 });
      await ageRows({ ids: [youngUnread.id], daysAgo: 6 });

      expect(await ingestRequestsCleanupCron.triggerManualSync()).toEqual({
        ...NOTHING_ELSE,
        unclassifiedExpired: 1,
        deleted: 0,
      });

      const remaining = new Set((await IngestRequests.findAll({ attributes: ['id'] })).map((row) => row.id));
      expect(remaining.has(unread.id)).toBe(false);
      expect(remaining.has(youngUnread.id)).toBe(true);
      expect(remaining.has(classified.id)).toBe(true);
      expect((await NotificationSources.findOne({ where: { id: source.id } }))!.counters).toEqual({
        expiredUnclassified: 1,
      });
    });

    it('deletes a source nobody approved for a month with what it holds, and keeps an approved one', async () => {
      const user = await helpers.getUserInfo({ raw: true });
      const stale = await NotificationSources.create({
        userId: user.id,
        sourceKey: 'name:telegram|mum',
        appName: 'Telegram',
        mode: 'pending',
      });
      const approved = await NotificationSources.create({
        userId: user.id,
        sourceKey: 'name:telegram|bank',
        appName: 'Telegram',
        mode: 'approved',
      });
      const held = await seedNotification({
        userId: user.id,
        status: 'parked',
        reason: 'sourceNotApproved',
        sourceId: stale.id,
        key: 'held',
      });
      await connection.sequelize.query(
        `UPDATE "NotificationSources" SET "createdAt" = now() - make_interval(days => 31) WHERE id IN (:ids)`,
        { replacements: { ids: [stale.id, approved.id] } },
      );

      const result = await ingestRequestsCleanupCron.triggerManualSync();

      expect(result).toMatchObject({ pendingSourcesDeleted: 1 });
      expect(await NotificationSources.findOne({ where: { id: stale.id } })).toBeNull();
      expect(await NotificationSources.findOne({ where: { id: approved.id } })).not.toBeNull();
      expect(await IngestRequests.findOne({ where: { id: held.id } })).toBeNull();
    });
  });
});
