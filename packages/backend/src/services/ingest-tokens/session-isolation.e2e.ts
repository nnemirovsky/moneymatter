import { INGEST_SCOPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
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

    it('accepts the session cookie on the same route (control for the refusals above)', async () => {
      const res = await helpers.getUserInfo({ raw: false });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('the ingest middleware', () => {
    it('refuses a revoked token with 401', async () => {
      const { token, secret } = await helpers.createIngestToken({ payload: { name: 'Revoked' }, raw: true });
      await helpers.revokeIngestToken({ id: token.id, raw: true });

      const res = await ingestHelpers.requestWithoutSession({
        method: 'post',
        url: INGEST_URL,
        headers: ingestHelpers.bearer({ secret }),
        body: BODY,
      });

      expect(res.status).toBe(401);
    });

    it('refuses an expired token with 401', async () => {
      const { secret } = await ingestHelpers.createTestIngestToken({ expiresAt: new Date(Date.now() - 60_000) });

      const res = await ingestHelpers.requestWithoutSession({
        method: 'post',
        url: INGEST_URL,
        headers: ingestHelpers.bearer({ secret }),
        body: BODY,
      });

      expect(res.status).toBe(401);
    });

    it('refuses a token without the ingest:transactions scope with 403', async () => {
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
