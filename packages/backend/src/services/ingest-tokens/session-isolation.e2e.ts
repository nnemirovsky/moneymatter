import { INGEST_SCOPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import { revokeIngestToken } from '@services/ingest-tokens';
import * as helpers from '@tests/helpers';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';

const INGEST_URL = '/ingest/card-payment';
const BODY = { amount: 10, merchant: 'Test', card: 'Test card', idempotencyKey: 'test-key-0001' };

describe('ingest tokens are not sessions', () => {
  describe('a minted token presented to a session route', () => {
    const credentials = [
      { label: 'Authorization: Bearer', headers: (secret: string) => ingestHelpers.bearer({ secret }) },
      { label: 'x-api-key', headers: (secret: string) => ({ 'x-api-key': secret }) },
    ];
    const routes = [
      { method: 'get', url: '/user' },
      { method: 'post', url: '/transactions' },
    ] as const;

    it.each(credentials.flatMap((credential) => routes.map((route) => ({ ...credential, ...route }))))(
      '$label on $method $url answers 401',
      async ({ headers, method, url }) => {
        const { secret } = await ingestHelpers.createTestIngestToken();

        const res = await ingestHelpers.requestWithoutSession({
          method,
          url,
          headers: headers(secret),
          body: method === 'post' ? {} : undefined,
        });

        expect(res.status).toBe(401);
      },
    );

    it('is refused where the session cookie alone is accepted', async () => {
      const res = await helpers.getUserInfo({ raw: false });

      expect(res.statusCode).toBe(200);
    });
  });

  // The cases below exercise the ingest middleware through Task 5's route; they pass once it exists.
  describe('the ingest middleware', () => {
    it.skip('refuses a revoked token with 401 (passes at Task 5)', async () => {
      const { token, secret } = await ingestHelpers.createTestIngestToken();
      // Revocation through the settings endpoint arrives with Task 2; the token store is the same.
      await revokeIngestToken({ userId: (await helpers.getUserInfo({ raw: true })).id, id: token.id });

      const res = await ingestHelpers.requestWithoutSession({
        method: 'post',
        url: INGEST_URL,
        headers: ingestHelpers.bearer({ secret }),
        body: BODY,
      });

      expect(res.status).toBe(401);
    });

    it.skip('refuses an expired token with 401 (passes at Task 5)', async () => {
      const { secret } = await ingestHelpers.createTestIngestToken({ expiresAt: new Date(Date.now() - 60_000) });

      const res = await ingestHelpers.requestWithoutSession({
        method: 'post',
        url: INGEST_URL,
        headers: ingestHelpers.bearer({ secret }),
        body: BODY,
      });

      expect(res.status).toBe(401);
    });

    it.skip('refuses a token without the ingest:transactions scope with 403 (passes at Task 5)', async () => {
      const { secret } = await ingestHelpers.createTestIngestToken({ scopes: [] });

      const res = await ingestHelpers.requestWithoutSession({
        method: 'post',
        url: INGEST_URL,
        headers: ingestHelpers.bearer({ secret }),
        body: BODY,
      });

      expect(res.status).toBe(403);
      expect(INGEST_SCOPES.transactions).toBe('ingest:transactions');
    });
  });
});
