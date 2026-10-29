import type { NotificationSourceDto } from '@bt/shared/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { getAppStoreMock } from '@tests/mocks/app-store/mock-api';
import { randomUUID } from 'node:crypto';

const NOTES = {
  bundleId: 'com.example.notes',
  trackName: 'Example Notes',
  sellerName: 'Example Software Ltd',
  artworkUrl512: 'https://cdn.example.com/notes-512.jpg',
};
const NOTES_PRO = {
  bundleId: 'com.example.notes.pro',
  trackName: 'Example Notes Pro',
  sellerName: 'Example Software Ltd',
  artworkUrl512: 'https://cdn.example.com/notes-pro-512.jpg',
};

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`app-search:user:${id}`);
  await RateLimitService.resetRateLimit(`ingest-settings-write:user:${id}`);
};

const seedSource = async ({ bundleId = null }: { bundleId?: string | null } = {}) => {
  const { secret } = await ingestHelpers.createTestIngestToken();
  await ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'Example Bank',
      bundleId,
      title: 'Example Bank',
      body: 'USD 43.60',
      idempotencyKey: `key-${randomUUID()}`,
    },
  });
  const sources = await helpers.listNotificationSources({ raw: true });

  return { secret, source: sources.at(-1) as NotificationSourceDto };
};

beforeAll(() => {
  // The lookups reach Apple; the suite switches them on and answers them from the mock store.
  process.env.APP_ICON_LOOKUP = 'on';
});
afterAll(() => {
  delete process.env.APP_ICON_LOOKUP;
});
beforeEach(async () => {
  await resetLimits();
  global.mswMockServer.use(...getAppStoreMock({ apps: [NOTES, NOTES_PRO] }));
});
afterEach(resetLimits);

describe('choosing the app of a notification source', () => {
  describe('GET /user/settings/notification-sources/app-search', () => {
    it('lists the apps of the store with their icon, name and developer', async () => {
      const result = await helpers.searchSourceApps({ term: 'example notes', storefront: 'gb', raw: true });

      expect(result.storefront).toBe('gb');
      expect(result.apps).toEqual([
        {
          bundleId: 'com.example.notes',
          name: 'Example Notes',
          developer: 'Example Software Ltd',
          iconUrl: 'https://cdn.example.com/notes-512.jpg',
        },
        {
          bundleId: 'com.example.notes.pro',
          name: 'Example Notes Pro',
          developer: 'Example Software Ltd',
          iconUrl: 'https://cdn.example.com/notes-pro-512.jpg',
        },
      ]);
    });

    it("searches the user's own storefront when none is asked for, and one that is not offered is replaced by it", async () => {
      const own = await helpers.searchSourceApps({ term: 'notes', raw: true });
      const unknown = await helpers.searchSourceApps({ term: 'notes', storefront: 'zz', raw: true });

      expect(own.storefront).toMatch(/^[a-z]{2}$/);
      expect(unknown.storefront).toBe(own.storefront);
    });

    it('is empty when the store knows no such app', async () => {
      global.mswMockServer.use(...getAppStoreMock({ apps: [] }));

      expect((await helpers.searchSourceApps({ term: 'nothing here', raw: true })).apps).toEqual([]);
    });

    it('refuses a term that is too short', async () => {
      expect((await helpers.searchSourceApps({ term: 'a' })).statusCode).toBe(422);
    });

    it('is rate limited per user', async () => {
      for (let attempt = 0; attempt < 30; attempt++) await helpers.searchSourceApps({ term: 'notes', raw: true });

      expect((await helpers.searchSourceApps({ term: 'notes' })).statusCode).toBe(429);
    });
  });

  describe('PUT and DELETE /user/settings/notification-sources/:id/app', () => {
    it('stores the chosen app, taking its icon from the store listing, not from the client', async () => {
      const { source } = await seedSource();

      const chosen = await helpers.chooseSourceApp({
        id: source.id,
        payload: { bundleId: 'com.example.notes', storefront: 'us' },
        raw: true,
      });

      expect(chosen).toEqual({
        ...source,
        iconUrl: 'https://cdn.example.com/notes-512.jpg',
        iconOverride: true,
      });
      expect(await helpers.listNotificationSources({ raw: true })).toEqual([chosen]);
    });

    it('keeps the choice when a later notification arrives and the store would now match another app', async () => {
      const { secret, source } = await seedSource();
      await helpers.chooseSourceApp({
        id: source.id,
        payload: { bundleId: 'com.example.notes', storefront: 'us' },
        raw: true,
      });
      // An automatic lookup would now find an app named like the source.
      global.mswMockServer.use(
        ...getAppStoreMock({
          apps: [
            NOTES,
            {
              bundleId: 'com.example.bank',
              trackName: 'Example Bank',
              artworkUrl512: 'https://cdn.example.com/bank.jpg',
            },
          ],
        }),
      );

      await ingestHelpers.postIngestEvent({
        secret,
        body: {
          kind: 'notification',
          app: 'Example Bank',
          bundleId: null,
          title: 'Example Bank',
          body: 'USD 12.00',
          idempotencyKey: `key-${randomUUID()}`,
        },
      });

      const sources = await helpers.listNotificationSources({ raw: true });
      expect(sources.map((listed) => [listed.iconUrl, listed.iconOverride])).toEqual([
        ['https://cdn.example.com/notes-512.jpg', true],
      ]);
    });

    it('resets the choice and hands the source back to the automatic lookup', async () => {
      const { source } = await seedSource();
      await helpers.chooseSourceApp({
        id: source.id,
        payload: { bundleId: 'com.example.notes', storefront: 'us' },
        raw: true,
      });
      // After the reset the automatic lookup finds an app named like the source.
      global.mswMockServer.use(
        ...getAppStoreMock({
          apps: [
            {
              bundleId: 'com.example.bank',
              trackName: 'Example Bank',
              artworkUrl512: 'https://cdn.example.com/bank.jpg',
            },
          ],
        }),
      );

      const reset = await helpers.resetSourceApp({ id: source.id, raw: true });

      expect(reset.iconOverride).toBe(false);
      expect(reset.iconUrl).toBe('https://cdn.example.com/bank.jpg');
    });

    it('answers 404 for an app the store does not list, and leaves the source as it was', async () => {
      const { source } = await seedSource();

      const response = await helpers.chooseSourceApp({
        id: source.id,
        payload: { bundleId: 'com.example.missing', storefront: 'us' },
      });

      expect(response.statusCode).toBe(404);
      expect(await helpers.listNotificationSources({ raw: true })).toEqual([source]);
    });

    it('answers 404 for a source that is not the user’s', async () => {
      const response = await helpers.chooseSourceApp({
        id: randomUUID(),
        payload: { bundleId: 'com.example.notes', storefront: 'us' },
      });

      expect(response.statusCode).toBe(404);
      expect((await helpers.resetSourceApp({ id: randomUUID() })).statusCode).toBe(404);
    });

    it('refuses a body without a bundle id', async () => {
      const { source } = await seedSource();

      expect((await helpers.chooseSourceApp({ id: source.id, payload: { storefront: 'us' } })).statusCode).toBe(422);
    });
  });
});
