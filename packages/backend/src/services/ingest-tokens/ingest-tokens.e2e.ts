import { API_ERROR_CODES, INGEST_SCOPES } from '@bt/shared/types';
import { beforeEach, describe, expect, it } from '@jest/globals';
import Users from '@models/users.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import type { ErrorResponse } from '@tests/helpers/common';
import { clearMockSession, registerMockSession } from '@tests/mocks/better-auth';

const NAME_MAX_LENGTH = 100;
const CREATE_BUDGET_PER_MINUTE = 10;

const errorCode = ({ response }: { response: { body: unknown } }) =>
  ((response.body as { response: ErrorResponse }).response ?? {}).code;

describe('Ingest token management', () => {
  beforeEach(async () => {
    const { id } = await helpers.getUserInfo({ raw: true });
    await RateLimitService.resetRateLimit(`ingest-settings-write:user:${id}`);
  });

  describe('GET /user/settings/ingest-tokens', () => {
    it('is empty for a fresh user', async () => {
      expect(await helpers.listIngestTokens({ raw: true })).toEqual([]);
    });

    it('lists the token with its display fields and never the secret', async () => {
      const created = await helpers.createIngestToken({ payload: { name: 'Phone' }, raw: true });

      const response = await helpers.listIngestTokens();

      expect(response.statusCode).toBe(200);
      expect(response.body.response).toEqual([
        {
          id: created.token.id,
          name: 'Phone',
          start: created.secret.slice(0, 14),
          scopes: [INGEST_SCOPES.transactions],
          lastUsedAt: null,
          createdAt: expect.any(String),
          expiresAt: null,
        },
      ]);
      expect(JSON.stringify(response.body)).not.toContain(created.secret);
      expect(JSON.stringify(response.body)).not.toContain('tokenHash');
    });

    it("does not list another user's tokens", async () => {
      await helpers.createIngestToken({ payload: { name: 'Mine' }, raw: true });
      const other = await helpers.signUpSecondUser();

      const otherList = await helpers.asUser({
        cookies: other.cookies,
        fn: () => helpers.listIngestTokens({ raw: true }),
      });

      expect(otherList).toEqual([]);
    });

    it('lists the newest token first', async () => {
      await helpers.createIngestToken({ payload: { name: 'First' }, raw: true });
      await helpers.createIngestToken({ payload: { name: 'Second' }, raw: true });

      const names = (await helpers.listIngestTokens({ raw: true })).map((token) => token.name);

      expect(names).toEqual(['Second', 'First']);
    });
  });

  describe('POST /user/settings/ingest-tokens', () => {
    it('returns the secret once, with the token, and the list never shows it again', async () => {
      const response = await helpers.createIngestToken({ payload: { name: '  Phone  ' } });

      expect(response.statusCode).toBe(201);
      const { token, secret } = response.body.response;
      expect(secret).toMatch(/^mm_ingest_[A-Za-z0-9_-]{43}$/);
      expect(token.name).toBe('Phone');
      expect(token.scopes).toEqual([INGEST_SCOPES.transactions]);
      expect(token.start).toBe(secret.slice(0, 14));
      expect(JSON.stringify(token)).not.toContain(secret);

      const listResponse = await helpers.listIngestTokens();
      expect(JSON.stringify(listResponse.body)).not.toContain(secret);
      expect(listResponse.body.response.map((item) => item.id)).toEqual([token.id]);
    });

    it('sets the expiry from expiresInDays', async () => {
      const { token } = await helpers.createIngestToken({ payload: { name: 'Short', expiresInDays: 30 }, raw: true });

      const expiresInMs = new Date(token.expiresAt!).getTime() - Date.now();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

      expect(Math.abs(expiresInMs - thirtyDaysMs)).toBeLessThan(60_000);
    });

    it('ignores scopes and purpose a client tries to set', async () => {
      const { token } = await helpers.createIngestToken({
        payload: { name: 'Sneaky', scopes: ['finance:write'], purpose: 'card-payment-setup' },
        raw: true,
      });

      expect(token.scopes).toEqual([INGEST_SCOPES.transactions]);
    });

    it(`accepts a name of ${NAME_MAX_LENGTH} characters`, async () => {
      const response = await helpers.createIngestToken({ payload: { name: 'a'.repeat(NAME_MAX_LENGTH) } });

      expect(response.statusCode).toBe(201);
    });

    it.each([
      { label: `a name longer than ${NAME_MAX_LENGTH} characters`, payload: { name: 'a'.repeat(NAME_MAX_LENGTH + 1) } },
      { label: 'a blank name', payload: { name: '   ' } },
      { label: 'no name', payload: { expiresInDays: 5 } },
      { label: 'expiresInDays of 0', payload: { name: 'x', expiresInDays: 0 } },
      { label: 'expiresInDays above 3650', payload: { name: 'x', expiresInDays: 3651 } },
      { label: 'a fractional expiresInDays', payload: { name: 'x', expiresInDays: 1.5 } },
    ])('answers 422 for $label and stores nothing', async ({ payload }) => {
      const response = await helpers.createIngestToken({ payload });

      expect(response.statusCode).toBe(422);
      expect(errorCode({ response })).toBe(API_ERROR_CODES.validationError);
      expect(await helpers.listIngestTokens({ raw: true })).toEqual([]);
    });

    it('is blocked for a demo user', async () => {
      const demo = await helpers.makeAuthRequest({ method: 'post', url: '/demo' });
      expect(demo.statusCode).toBe(200);

      const cookies = helpers.extractCookies(demo);
      const sessionToken = cookies.match(/bt_auth\.session_token=([^;]+)/)?.[1];
      const demoUser = await Users.findByPk(demo.body.response.user.id);
      registerMockSession(sessionToken!, { id: demoUser!.authUserId, email: `demo-${demoUser!.id}@demo.local` });

      try {
        const response = await helpers.asUser({
          cookies,
          fn: async () => {
            const blocked = await helpers.createIngestToken({ payload: { name: 'Demo' } });
            return { blocked, list: await helpers.listIngestTokens({ raw: true }) };
          },
        });

        expect(response.blocked.statusCode).toBe(403);
        expect(errorCode({ response: response.blocked })).toBe(API_ERROR_CODES.forbidden);
        expect(response.list).toEqual([]);
      } finally {
        clearMockSession(sessionToken!);
      }
    }, 120_000);

    it(`answers 429 to create number ${CREATE_BUDGET_PER_MINUTE + 1} within a minute`, async () => {
      for (let attempt = 1; attempt <= CREATE_BUDGET_PER_MINUTE; attempt++) {
        const response = await helpers.createIngestToken({ payload: { name: `Token ${attempt}` } });
        expect(response.statusCode).toBe(201);
      }

      const blocked = await helpers.createIngestToken({ payload: { name: 'One too many' } });

      expect(blocked.statusCode).toBe(429);
      expect(errorCode({ response: blocked })).toBe(API_ERROR_CODES.tooManyRequests);
      expect(await helpers.listIngestTokens({ raw: true })).toHaveLength(CREATE_BUDGET_PER_MINUTE);
    });

    it('gives each user their own create budget', async () => {
      for (let attempt = 1; attempt <= CREATE_BUDGET_PER_MINUTE; attempt++) {
        await helpers.createIngestToken({ payload: { name: `Token ${attempt}` }, raw: true });
      }
      expect((await helpers.createIngestToken({ payload: { name: 'Over' } })).statusCode).toBe(429);

      const other = await helpers.signUpSecondUser();
      const created = await helpers.asUser({
        cookies: other.cookies,
        fn: () => helpers.createIngestToken({ payload: { name: 'Other user' } }),
      });

      expect(created.statusCode).toBe(201);
    });
  });

  describe('DELETE /user/settings/ingest-tokens/:id', () => {
    it('removes the token, and a second revoke is a 404', async () => {
      const { token } = await helpers.createIngestToken({ payload: { name: 'Phone' }, raw: true });

      const first = await helpers.revokeIngestToken({ id: token.id });
      expect(first.statusCode).toBe(200);
      expect(first.body.response).toEqual({ success: true });
      expect(await helpers.listIngestTokens({ raw: true })).toEqual([]);

      const second = await helpers.revokeIngestToken({ id: token.id });
      expect(second.statusCode).toBe(404);
    });

    it('revokes only the named token', async () => {
      const keep = await helpers.createIngestToken({ payload: { name: 'Keep' }, raw: true });
      const drop = await helpers.createIngestToken({ payload: { name: 'Drop' }, raw: true });

      await helpers.revokeIngestToken({ id: drop.token.id });

      expect((await helpers.listIngestTokens({ raw: true })).map((token) => token.id)).toEqual([keep.token.id]);
    });

    it("answers 404 for another user's token id and leaves that token in place", async () => {
      const other = await helpers.signUpSecondUser();
      const otherToken = await helpers.asUser({
        cookies: other.cookies,
        fn: () => helpers.createIngestToken({ payload: { name: 'Theirs' }, raw: true }),
      });

      const response = await helpers.revokeIngestToken({ id: otherToken.token.id });

      expect(response.statusCode).toBe(404);
      const stillThere = await helpers.asUser({
        cookies: other.cookies,
        fn: () => helpers.listIngestTokens({ raw: true }),
      });
      expect(stillThere.map((token) => token.id)).toEqual([otherToken.token.id]);
    });

    it('answers 404 for an unknown id and 422 for a malformed one', async () => {
      expect((await helpers.revokeIngestToken({ id: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
      expect((await helpers.revokeIngestToken({ id: 'not-a-uuid' })).statusCode).toBe(422);
    });
  });

  describe('without a session', () => {
    it.each([
      { method: 'get', url: '/user/settings/ingest-tokens' },
      { method: 'post', url: '/user/settings/ingest-tokens' },
      { method: 'delete', url: '/user/settings/ingest-tokens/00000000-0000-4000-8000-000000000000' },
    ] as const)('$method $url answers 401', async ({ method, url }) => {
      const response = await helpers.withoutSession(() =>
        helpers.makeRequest({ method, url, payload: method === 'post' ? { name: 'x' } : null }),
      );

      expect(response.statusCode).toBe(401);
    });
  });
});
