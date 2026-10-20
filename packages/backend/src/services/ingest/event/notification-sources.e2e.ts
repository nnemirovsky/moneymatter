import { ACCOUNT_STATUSES, type NotificationSourceDto } from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { randomUUID } from 'node:crypto';

const notification = (overrides: Record<string, unknown> = {}) => ({
  kind: 'notification',
  app: 'TBC Bank',
  bundleId: 'ge.tbc.app',
  title: 'TBC Bank',
  body: 'GEL 43.60',
  idempotencyKey: `key-${randomUUID()}`,
  ...overrides,
});

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
};

/** One source, made the way a user gets one: a notification from its app arrives. */
const seedSource = async ({ overrides = {} }: { overrides?: Record<string, unknown> } = {}) => {
  const { secret } = await ingestHelpers.createTestIngestToken();
  await ingestHelpers.postIngestEvent({ secret, body: notification(overrides) });
  const sources = await helpers.listNotificationSources({ raw: true });

  return { secret, source: sources.at(-1) as NotificationSourceDto };
};

beforeEach(resetLimits);
afterEach(resetLimits);

describe('notification sources', () => {
  describe('GET /user/settings/notification-sources', () => {
    it('is empty before any notification', async () => {
      expect(await helpers.listNotificationSources({ raw: true })).toEqual([]);
    });

    it('lists the source a notification came from', async () => {
      const { source } = await seedSource();

      expect(source).toEqual({
        id: expect.any(String),
        appName: 'TBC Bank',
        bundleId: 'ge.tbc.app',
        sender: null,
        conversational: false,
        mode: 'auto',
        defaultAccountId: null,
        counters: {},
        lastSeenAt: expect.any(String),
        createdAt: expect.any(String),
      });
    });

    it('lists the most recently seen source first', async () => {
      const { secret } = await seedSource();
      await ingestHelpers.postIngestEvent({
        secret,
        body: notification({ app: 'Revolut', bundleId: 'com.revolut.revolut', body: 'EUR 5.00' }),
      });

      const sources = await helpers.listNotificationSources({ raw: true });

      expect(sources.map((source) => source.appName)).toEqual(['Revolut', 'TBC Bank']);
    });

    it("does not list another user's sources", async () => {
      await seedSource();
      const other = await helpers.signUpSecondUser();

      const otherList = await helpers.asUser({
        cookies: other.cookies,
        fn: () => helpers.listNotificationSources({ raw: true }),
      });

      expect(otherList).toEqual([]);
    });
  });

  describe('PATCH /user/settings/notification-sources/:id', () => {
    it.each(['approved', 'muted', 'pending'] as const)('sets the mode to %s', async (mode) => {
      const { source } = await seedSource();

      const updated = await helpers.updateNotificationSource({ id: source.id, payload: { mode }, raw: true });

      expect(updated).toEqual({ ...source, mode });
      expect(await helpers.listNotificationSources({ raw: true })).toEqual([updated]);
    });

    it('refuses to set the mode the system alone starts a source in', async () => {
      const { source } = await seedSource();

      const response = await helpers.updateNotificationSource({ id: source.id, payload: { mode: 'auto' } });

      expect(response.statusCode).toBe(422);
    });

    it('sets and clears the default account', async () => {
      const { source } = await seedSource();
      const account = await helpers.createAccount({ raw: true });

      const set = await helpers.updateNotificationSource({
        id: source.id,
        payload: { defaultAccountId: account.id },
        raw: true,
      });
      const cleared = await helpers.updateNotificationSource({
        id: source.id,
        payload: { defaultAccountId: null },
        raw: true,
      });

      expect(set.defaultAccountId).toBe(account.id);
      expect(cleared.defaultAccountId).toBeNull();
    });

    it('answers 404 for an account that is not the user’s, is archived or is a loan, and keeps the old one', async () => {
      const { source } = await seedSource();
      const account = await helpers.createAccount({ raw: true });
      await helpers.updateNotificationSource({ id: source.id, payload: { defaultAccountId: account.id }, raw: true });
      const archived = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'Archived' }),
        raw: true,
      });
      await helpers.updateAccount({ id: archived.id, payload: { status: ACCOUNT_STATUSES.archived } });
      const loan = await helpers.createLoan({
        payload: helpers.buildCreateLoanPayload({ currencyCode: global.BASE_CURRENCY_CODE }),
        raw: true,
      });
      const other = await helpers.signUpSecondUser();
      const foreign = await helpers.asUser({
        cookies: other.cookies,
        fn: async () => {
          await helpers.setBaseCurrencyForActiveUser({ currencyCode: global.BASE_CURRENCY.code });
          return helpers.createAccount({ raw: true });
        },
      });

      for (const accountId of [archived.id, loan.id, foreign.id, '0192f0c2-0000-7000-8000-000000000000']) {
        const response = await helpers.updateNotificationSource({
          id: source.id,
          payload: { defaultAccountId: accountId },
        });

        expect(response.statusCode).toBe(404);
      }
      expect((await helpers.listNotificationSources({ raw: true }))[0]!.defaultAccountId).toBe(account.id);
    });

    it.each([
      ['an empty body', {}],
      ['an unknown mode', { mode: 'trusted' }],
      ['a malformed account id', { defaultAccountId: 'not-an-id' }],
    ])('answers 422 for %s', async (_name, payload) => {
      const { source } = await seedSource();

      const response = await helpers.updateNotificationSource({ id: source.id, payload });

      expect(response.statusCode).toBe(422);
    });

    it("answers 404 for another user's source and leaves it alone", async () => {
      const { source } = await seedSource();
      const other = await helpers.signUpSecondUser();

      const response = await helpers.asUser({
        cookies: other.cookies,
        fn: () => helpers.updateNotificationSource({ id: source.id, payload: { mode: 'muted' } }),
      });

      expect(response.statusCode).toBe(404);
      expect((await helpers.listNotificationSources({ raw: true }))[0]!.mode).toBe('auto');
    });
  });

  describe('DELETE /user/settings/notification-sources/:id', () => {
    it('forgets the source: its next notification starts over', async () => {
      const { secret, source } = await seedSource();
      await helpers.updateNotificationSource({ id: source.id, payload: { mode: 'muted' }, raw: true });

      const first = await helpers.deleteNotificationSource({ id: source.id });
      const second = await helpers.deleteNotificationSource({ id: source.id });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(404);
      expect(await helpers.listNotificationSources({ raw: true })).toEqual([]);

      const res = await ingestHelpers.postIngestEvent({ secret, body: notification() });
      expect(res.body.response.outcome).toBe('logged');
      expect((await helpers.listNotificationSources({ raw: true }))[0]).toMatchObject({ mode: 'auto' });
    });

    it('keeps the requests the source sent', async () => {
      const { source } = await seedSource();

      await helpers.deleteNotificationSource({ id: source.id });

      expect(await IngestRequests.count()).toBe(1);
    });

    it("answers 404 for another user's source and keeps it", async () => {
      const { source } = await seedSource();
      const other = await helpers.signUpSecondUser();

      const response = await helpers.asUser({
        cookies: other.cookies,
        fn: () => helpers.deleteNotificationSource({ id: source.id }),
      });

      expect(response.statusCode).toBe(404);
      expect(await helpers.listNotificationSources({ raw: true })).toHaveLength(1);
    });
  });
});
