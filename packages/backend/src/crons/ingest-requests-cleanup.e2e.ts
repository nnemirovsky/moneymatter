import { INGEST_REQUEST_RETENTION_DAYS, type IngestRequestStatus, type RecordId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import ChatMessages from '@models/chat-messages.model';
import ChatProposals from '@models/chat-proposals.model';
import ChatThreads from '@models/chat-threads.model';
import { connection } from '@models/connection';
import DuplicateSuggestions from '@models/duplicate-suggestions.model';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { ingestRequestsCleanupCron } from '@root/crons/ingest-requests-cleanup';
import * as helpers from '@tests/helpers';
import { randomUUID } from 'node:crypto';

/** The cleanup has no HTTP surface, so this e2e invokes it directly. */

const NOTHING_ELSE = {
  ignoredDeleted: 0,
  contextsExpired: 0,
  unclassifiedExpired: 0,
  pendingSourcesDeleted: 0,
  suggestionsSwept: 0,
  suggestionsDeleted: 0,
  inboxCardsSwept: 0,
};

const STATUSES: IngestRequestStatus[] = ['logged', 'rejected', 'dismissed', 'enriched', 'parked', 'received'];

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

const seedSuggestion = async ({
  status,
  resolvedDaysAgo = null,
  sides = 'both',
}: {
  status: 'open' | 'merged' | 'dismissed' | 'stale';
  resolvedDaysAgo?: number | null;
  sides?: 'both' | 'transactionOnly';
}) => {
  const user = await helpers.getUserInfo({ raw: true });
  const account = await helpers.createAccount({ raw: true });
  const [first, second] = await Promise.all([
    helpers.createTransaction({
      payload: helpers.buildTransactionPayload({ accountId: account.id, amount: 10 }),
      raw: true,
    }),
    helpers.createTransaction({
      payload: helpers.buildTransactionPayload({ accountId: account.id, amount: 11 }),
      raw: true,
    }),
  ]);
  const [low, high] = [first[0]!.id, second[0]!.id].toSorted();
  const suggestion = await DuplicateSuggestions.create({
    userId: user.id,
    accountId: account.id,
    transactionId: low,
    candidateId: sides === 'both' ? high : null,
    confidence: 0.9,
    reason: null,
    trigger: 'scan',
    status,
    resolvedAt: resolvedDaysAgo === null ? null : new Date(Date.now() - resolvedDaysAgo * 24 * 60 * 60_000),
  });

  return suggestion.id;
};

/** A waiting card in a live inbox thread, written directly: the sweep reads the cards and the records they name. */
const seedInboxCard = async ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
  const user = await helpers.getUserInfo({ raw: true });
  const thread =
    (await ChatThreads.findOne({ where: { userId: user.id, kind: 'automationInbox' } })) ??
    (await ChatThreads.create({
      userId: user.id,
      title: 'Automation inbox',
      titleSource: 'model',
      pinned: true,
      kind: 'automationInbox',
      inboxState: 'live',
      lastMessageAt: new Date(),
      expiresAt: null,
    }));
  const proposalId = randomUUID();
  const message = await ChatMessages.create({
    threadId: thread.id,
    userId: user.id,
    role: 'assistant',
    status: 'complete',
    parts: [{ type: 'proposal', id: randomUUID(), proposalId }],
  });

  return ChatProposals.create({
    id: proposalId,
    threadId: thread.id,
    messageId: message.id,
    userId: user.id,
    toolName,
    proposedArgs: args,
    args,
    cardKind: 'update',
    entity: 'notificationSource',
    status: 'pending',
    expiresAt: new Date(Date.now() + 86_400_000),
  });
};

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

    expect(await ingestRequestsCleanupCron.triggerManualSync()).toEqual({ ...NOTHING_ELSE, deleted: 4 });

    const remaining = new Set((await IngestRequests.findAll({ attributes: ['id'] })).map((row) => row.id));
    expect(remaining.has(old.logged)).toBe(false);
    expect(remaining.has(old.rejected)).toBe(false);
    expect(remaining.has(old.dismissed)).toBe(false);
    expect(remaining.has(old.enriched)).toBe(false);
    expect(remaining.has(old.parked)).toBe(true);
    expect(remaining.has(old.received)).toBe(true);
    for (const id of Object.values(recent)) expect(remaining.has(id)).toBe(true);
  });

  it('deletes nothing when there is nothing to delete', async () => {
    expect(await ingestRequestsCleanupCron.triggerManualSync()).toEqual({ ...NOTHING_ELSE, deleted: 0 });
  });

  describe('notifications', () => {
    it('gives up a context notification that waited longer than the hold, and keeps a fresh one', async () => {
      const user = await helpers.getUserInfo({ raw: true });
      const stale = await seedNotification({ userId: user.id, status: 'held', reason: null, key: 'held-old' });
      const fresh = await seedNotification({ userId: user.id, status: 'held', reason: null, key: 'held-new' });
      await IngestRequests.update(
        { parsed: { parser: 'rules', kind: 'context', confidence: 1, context: { store: 'Cafe' } } },
        { where: { id: [stale.id, fresh.id] } },
      );
      await connection.sequelize.query(
        `UPDATE "IngestRequests" SET "createdAt" = now() - interval '2 hours' WHERE id = :id`,
        {
          replacements: { id: stale.id },
        },
      );

      expect(await ingestRequestsCleanupCron.triggerManualSync()).toEqual({
        ...NOTHING_ELSE,
        contextsExpired: 1,
        deleted: 0,
      });

      const expired = (await IngestRequests.findOne({ where: { id: stale.id } }))!;
      expect(expired).toMatchObject({ status: 'ignored', reason: 'contextExpired' });
      expect(expired.parsed).toEqual({ parser: 'rules', kind: 'context', confidence: 1 });
      expect((await IngestRequests.findOne({ where: { id: fresh.id } }))!.status).toBe('held');
    });

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
  describe('duplicate suggestions', () => {
    it('marks an open suggestion with a missing side stale, and leaves a whole one open', async () => {
      const orphan = await seedSuggestion({ status: 'open', sides: 'transactionOnly' });
      const whole = await seedSuggestion({ status: 'open' });

      const result = await ingestRequestsCleanupCron.triggerManualSync();

      expect(result).toMatchObject({ suggestionsSwept: 1 });
      expect((await DuplicateSuggestions.findByPk(orphan))!.status).toBe('stale');
      expect((await DuplicateSuggestions.findByPk(whole))!.status).toBe('open');
    });

    it('deletes merged and stale suggestions settled over 90 days ago, and keeps dismissed and recent ones', async () => {
      const oldMerged = await seedSuggestion({ status: 'merged', resolvedDaysAgo: 91 });
      const oldStale = await seedSuggestion({ status: 'stale', resolvedDaysAgo: 91 });
      const recentMerged = await seedSuggestion({ status: 'merged', resolvedDaysAgo: 89 });
      const oldDismissed = await seedSuggestion({ status: 'dismissed', resolvedDaysAgo: 400 });

      const result = await ingestRequestsCleanupCron.triggerManualSync();

      expect(result).toMatchObject({ suggestionsDeleted: 2 });
      expect(await DuplicateSuggestions.findByPk(oldMerged)).toBeNull();
      expect(await DuplicateSuggestions.findByPk(oldStale)).toBeNull();
      expect(await DuplicateSuggestions.findByPk(recentMerged)).not.toBeNull();
      expect(await DuplicateSuggestions.findByPk(oldDismissed)).not.toBeNull();
    });
  });
  describe('inbox cards', () => {
    it('closes the waiting cards whose record is gone, and keeps the ones whose record still waits', async () => {
      const user = await helpers.getUserInfo({ raw: true });
      const waiting = await NotificationSources.create({
        userId: user.id,
        sourceKey: 'name:cashly',
        appName: 'Cashly',
        mode: 'pending',
      });
      const kept = await seedInboxCard({ toolName: 'set_notification_source', args: { sourceId: waiting.id } });
      const orphanedSource = await seedInboxCard({
        toolName: 'set_notification_source',
        args: { sourceId: randomUUID() },
      });
      const orphanedPayment = await seedInboxCard({
        toolName: 'confirm_ingest_payment',
        args: { transactionId: randomUUID() },
      });
      const orphanedRequest = await seedInboxCard({
        toolName: 'log_ingest_request',
        args: { requestId: randomUUID() },
      });

      const result = await ingestRequestsCleanupCron.triggerManualSync();

      expect(result).toMatchObject({ inboxCardsSwept: 3 });
      expect((await ChatProposals.findByPk(kept.id))!.status).toBe('pending');
      for (const card of [orphanedSource, orphanedPayment, orphanedRequest]) {
        expect(await ChatProposals.findByPk(card.id)).toMatchObject({
          status: 'rejected',
          statusReason: 'resolvedElsewhere',
        });
      }
    });

    it('closes the card of a pending source that is deleted for staying unapproved', async () => {
      const user = await helpers.getUserInfo({ raw: true });
      const stale = await NotificationSources.create({
        userId: user.id,
        sourceKey: 'name:cashly',
        appName: 'Cashly',
        mode: 'pending',
      });
      const card = await seedInboxCard({ toolName: 'set_notification_source', args: { sourceId: stale.id } });
      await stale.update({ proposalId: card.id });
      await connection.sequelize.query(
        `UPDATE "NotificationSources" SET "createdAt" = now() - make_interval(days => 31) WHERE id = :id`,
        { replacements: { id: stale.id } },
      );

      const result = await ingestRequestsCleanupCron.triggerManualSync();

      expect(result).toMatchObject({ pendingSourcesDeleted: 1 });
      expect(await ChatProposals.findByPk(card.id)).toMatchObject({
        status: 'rejected',
        statusReason: 'resolvedElsewhere',
      });
    });
  });
});
