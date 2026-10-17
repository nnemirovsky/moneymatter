import { decodeSetupCode, type CardPaymentSetupCodePayload } from '@bt/shared/lib/card-payment-setup-code';
import { API_ERROR_CODES } from '@bt/shared/types';
import { beforeEach, describe, expect, it } from '@jest/globals';
import Users from '@models/users.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import type { ErrorResponse } from '@tests/helpers/common';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { clearMockSession, registerMockSession } from '@tests/mocks/better-auth';

const INGEST_URL = 'https://money.example.com/api/v1/ingest/card-payment';
const CREATE_BUDGET_PER_MINUTE = 10;
const NAME_MAX_LENGTH = 100;
const URL_MAX_LENGTH = 500;
const CF_ID = 'cf-client-id.access';
const CF_SECRET = 'cf-client-secret-0123456789abcdef';

const errorCode = ({ response }: { response: { body: unknown } }) =>
  ((response.body as { response: ErrorResponse }).response ?? {}).code;

const mintSetupCode = async (payload: Record<string, unknown> = { ingestUrl: INGEST_URL }) => {
  const created = await helpers.createCardPaymentSetupCode({ payload, raw: true });

  return { ...created, decoded: decodeSetupCode({ code: created.setupCode }) as CardPaymentSetupCodePayload };
};

/** What the shortcut does with the token it decoded: a dry run through the ingest route. */
const dryRunStatus = async ({ secret }: { secret: string }) =>
  (await ingestHelpers.postCardPayment({ secret, body: { dryRun: true } })).status;

describe('POST /user/settings/card-payments/setup-code', () => {
  beforeEach(async () => {
    const { id } = await helpers.getUserInfo({ raw: true });
    await RateLimitService.resetRateLimit(`ingest-settings-write:user:${id}`);
  });

  describe('happy path', () => {
    it('returns the token entry and a setup code that carries the url and a working secret', async () => {
      const response = await helpers.createCardPaymentSetupCode({ payload: { ingestUrl: INGEST_URL } });

      expect(response.statusCode).toBe(201);
      const { token, setupCode } = response.body.response;
      expect(setupCode).toMatch(/^v1\.[A-Za-z0-9+/]+={0,2}$/);

      const decoded = decodeSetupCode({ code: setupCode });
      expect(decoded.url).toBe(INGEST_URL);
      expect(decoded.token).toMatch(/^mm_ingest_[A-Za-z0-9_-]{43}$/);
      expect(decoded.cfAccessId).toBeUndefined();
      expect(decoded.cfAccessSecret).toBeUndefined();

      expect(token.start).toBe(decoded.token.slice(0, 14));
      expect(JSON.stringify(token)).not.toContain(decoded.token);
      expect(await dryRunStatus({ secret: decoded.token })).toBe(200);
    });

    it('asks the client not to cache the response', async () => {
      const response = await helpers.createCardPaymentSetupCode({ payload: { ingestUrl: INGEST_URL } });

      expect(response.header['cache-control']).toContain('no-store');
    });

    it('adds the stored Cloudflare Access pair to the code', async () => {
      await helpers.setAccessHeaders({ payload: { clientId: CF_ID, clientSecret: CF_SECRET }, raw: true });

      const { decoded } = await mintSetupCode();

      expect(decoded.cfAccessId).toBe(CF_ID);
      expect(decoded.cfAccessSecret).toBe(CF_SECRET);
    });

    it('leaves the Cloudflare Access pair out again once it is cleared', async () => {
      await helpers.setAccessHeaders({ payload: { clientId: CF_ID, clientSecret: CF_SECRET }, raw: true });
      await helpers.setAccessHeaders({ payload: { clientId: null, clientSecret: null }, raw: true });

      const { decoded } = await mintSetupCode();

      expect(decoded.cfAccessId).toBeUndefined();
      expect(decoded.cfAccessSecret).toBeUndefined();
    });

    it('lists the new token with its name and no secret', async () => {
      const { decoded, token } = await mintSetupCode({ ingestUrl: INGEST_URL, tokenName: '  My iPhone  ' });

      const list = await helpers.listIngestTokens();

      expect(list.body.response.map((item) => item.id)).toEqual([token.id]);
      expect(list.body.response[0]!.name).toBe('My iPhone');
      expect(JSON.stringify(list.body)).not.toContain(decoded.token);
    });

    it('names the token when the client gives no name', async () => {
      const { token } = await mintSetupCode();

      expect(token.name).toMatch(/^Apple Pay/);
    });

    it('never puts the secrets anywhere but the setup code', async () => {
      await helpers.setAccessHeaders({ payload: { clientId: CF_ID, clientSecret: CF_SECRET }, raw: true });

      const response = await helpers.createCardPaymentSetupCode({ payload: { ingestUrl: INGEST_URL } });
      const { token, setupCode } = response.body.response;
      const decoded = decodeSetupCode({ code: setupCode });

      expect(Object.keys(response.body.response).toSorted()).toEqual(['setupCode', 'token']);
      expect(JSON.stringify(token)).not.toContain(decoded.token);
      expect(JSON.stringify(token)).not.toContain(CF_SECRET);

      const status = await helpers.getAccessHeaders();
      expect(JSON.stringify(status.body)).not.toContain(CF_SECRET);
    });
  });

  describe('minting', () => {
    it('mints a new token on every call, so nothing re-reveals the first', async () => {
      const first = await mintSetupCode({ ingestUrl: INGEST_URL, revokePrevious: false });
      const second = await mintSetupCode({ ingestUrl: INGEST_URL, revokePrevious: false });

      expect(second.decoded.token).not.toBe(first.decoded.token);
      expect(second.token.id).not.toBe(first.token.id);
      expect(await helpers.listIngestTokens({ raw: true })).toHaveLength(2);
    });

    it('revokes the earlier setup-code token by default', async () => {
      const first = await mintSetupCode();
      expect(await dryRunStatus({ secret: first.decoded.token })).toBe(200);

      const second = await mintSetupCode();

      expect(await dryRunStatus({ secret: first.decoded.token })).toBe(401);
      expect(await dryRunStatus({ secret: second.decoded.token })).toBe(200);
      expect((await helpers.listIngestTokens({ raw: true })).map((item) => item.id)).toEqual([second.token.id]);
    });

    it('keeps the earlier token when revokePrevious is false', async () => {
      const first = await mintSetupCode();

      const second = await mintSetupCode({ ingestUrl: INGEST_URL, revokePrevious: false });

      expect(await dryRunStatus({ secret: first.decoded.token })).toBe(200);
      expect(await dryRunStatus({ secret: second.decoded.token })).toBe(200);
    });

    it("revokes only setup-code tokens, not the user's own named tokens", async () => {
      const general = await helpers.createIngestToken({ payload: { name: 'Script' }, raw: true });
      await mintSetupCode();

      await mintSetupCode();

      expect(await dryRunStatus({ secret: general.secret })).toBe(200);
    });

    it('does not let the client choose the purpose, so it cannot make revokePrevious hit a named token', async () => {
      const general = await helpers.createIngestToken({ payload: { name: 'Script' }, raw: true });

      await mintSetupCode({ ingestUrl: INGEST_URL, purpose: 'general' });
      await mintSetupCode({ ingestUrl: INGEST_URL, purpose: 'general' });

      expect(await dryRunStatus({ secret: general.secret })).toBe(200);
      expect(await helpers.listIngestTokens({ raw: true })).toHaveLength(2);
    });

    it("leaves another user's tokens alone", async () => {
      const other = await helpers.signUpSecondUser();
      const otherCode = await helpers.asUser({
        cookies: other.cookies,
        fn: () => mintSetupCode(),
      });

      await mintSetupCode();
      await mintSetupCode();

      expect(await dryRunStatus({ secret: otherCode.decoded.token })).toBe(200);
    });

    it('keeps the earlier token when the new code cannot be built', async () => {
      const first = await mintSetupCode();

      const failed = await helpers.createCardPaymentSetupCode({ payload: { ingestUrl: 'ftp://money.example.com/x' } });

      expect(failed.statusCode).toBe(422);
      expect(await dryRunStatus({ secret: first.decoded.token })).toBe(200);
    });
  });

  describe('validation', () => {
    it.each([
      { label: 'no url', payload: {} },
      { label: 'an empty url', payload: { ingestUrl: '' } },
      { label: 'text that is not a url', payload: { ingestUrl: 'money example' } },
      { label: 'an ftp url', payload: { ingestUrl: 'ftp://money.example.com/api/v1/ingest/card-payment' } },
      { label: 'a javascript url', payload: { ingestUrl: 'javascript:alert(1)' } },
      {
        label: 'a url over the length limit',
        payload: { ingestUrl: `https://a.example/${'a'.repeat(URL_MAX_LENGTH)}` },
      },
      { label: 'a non-string url', payload: { ingestUrl: 42 } },
      { label: 'a blank token name', payload: { ingestUrl: INGEST_URL, tokenName: '   ' } },
      {
        label: `a token name over ${NAME_MAX_LENGTH} characters`,
        payload: { ingestUrl: INGEST_URL, tokenName: 'a'.repeat(NAME_MAX_LENGTH + 1) },
      },
      { label: 'a non-boolean revokePrevious', payload: { ingestUrl: INGEST_URL, revokePrevious: 'yes' } },
    ])('answers 422 for $label and mints nothing', async ({ payload }) => {
      const response = await helpers.createCardPaymentSetupCode({ payload });

      expect(response.statusCode).toBe(422);
      expect(errorCode({ response })).toBe(API_ERROR_CODES.validationError);
      expect(await helpers.listIngestTokens({ raw: true })).toEqual([]);
    });

    it('accepts an http url, which a self-hosted instance on a LAN uses', async () => {
      const { decoded } = await mintSetupCode({ ingestUrl: 'http://192.168.1.10:3000/api/v1/ingest/card-payment' });

      expect(decoded.url).toBe('http://192.168.1.10:3000/api/v1/ingest/card-payment');
    });
  });

  describe('access control', () => {
    it('answers 401 without a session', async () => {
      const response = await ingestHelpers.requestWithoutSession({
        method: 'post',
        url: '/user/settings/card-payments/setup-code',
        headers: {},
        body: { ingestUrl: INGEST_URL },
      });

      expect(response.status).toBe(401);
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
            const blocked = await helpers.createCardPaymentSetupCode({ payload: { ingestUrl: INGEST_URL } });
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

    it(`answers 429 to call number ${CREATE_BUDGET_PER_MINUTE + 1} within a minute`, async () => {
      for (let attempt = 1; attempt <= CREATE_BUDGET_PER_MINUTE; attempt++) {
        const response = await helpers.createCardPaymentSetupCode({ payload: { ingestUrl: INGEST_URL } });
        expect(response.statusCode).toBe(201);
      }

      const blocked = await helpers.createCardPaymentSetupCode({ payload: { ingestUrl: INGEST_URL } });

      expect(blocked.statusCode).toBe(429);
      expect(errorCode({ response: blocked })).toBe(API_ERROR_CODES.tooManyRequests);
    });
  });
});
