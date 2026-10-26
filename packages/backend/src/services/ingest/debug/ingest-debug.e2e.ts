import { until } from '@common/helpers';
import { decryptToken } from '@common/utils/encryption';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { connection } from '@models/connection';
import IngestDebugEvents from '@models/ingest-debug-events.model';
import { ingestRequestsCleanupCron } from '@root/crons/ingest-requests-cleanup';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { randomUUID } from 'node:crypto';

const BASE = global.BASE_CURRENCY_CODE;

const noAmount = () => ({
  kind: 'notification',
  app: 'Foodora',
  title: 'Foodora',
  subtitle: '',
  body: 'Your account has a new message',
  idempotencyKey: `key-${randomUUID()}`,
});

const send = ({ secret, body }: { secret: string; body: object }) => ingestHelpers.postIngestEvent({ secret, body });

const events = () => IngestDebugEvents.findAll({ order: [['createdAt', 'ASC']] });

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
};

describe('the ingest debug trace', () => {
  beforeEach(async () => {
    await resetLimits();
    await IngestDebugEvents.destroy({ where: {} });
  });
  afterEach(async () => {
    delete process.env.INGEST_DEBUG_TOKEN_IDS;
    await resetLimits();
  });

  it('traces a dropped notification of a listed token, with its text only encrypted', async () => {
    const { secret, token } = await ingestHelpers.createTestIngestToken();
    process.env.INGEST_DEBUG_TOKEN_IDS = `${randomUUID()}, ${token.id}`;

    const res = await send({ secret, body: noAmount() });

    expect(res.body.response).toMatchObject({ outcome: 'dropped', reason: 'noAmount' });
    await until(async () => (await events()).length === 1, { timeout: 10_000, interval: 100 });
    const [event] = await events();
    expect(event).toMatchObject({
      tokenId: token.id,
      endpoint: '/api/v1/ingest/event',
      kind: 'notification',
      httpStatus: 200,
      app: 'Foodora',
      outcome: 'dropped',
      reason: 'noAmount',
    });
    expect(event!.decision).toContain('prefilter:noAmount');
    expect(event!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(event!.toJSON())).not.toContain('Your account has a new message');
    expect(JSON.parse(decryptToken(event!.textEnc!)).input.body).toBe('Your account has a new message');
  });

  it('traces a probe answered no, a repeated key and a logged payment, and keeps no text for the probe', async () => {
    const { secret, token } = await ingestHelpers.createTestIngestToken();
    process.env.INGEST_DEBUG_TOKEN_IDS = token.id;
    const account = await helpers.createAccount({ raw: true });
    await helpers.createCardMapping({ payload: { cardLabel: 'Example Visa', accountId: account.id }, raw: true });
    const wallet = {
      kind: 'notification',
      app: 'Wallet',
      title: 'Example Visa',
      subtitle: 'Wolt',
      body: `${BASE} 12.00`,
      idempotencyKey: `key-${randomUUID()}`,
    };

    await send({ secret, body: { kind: 'notificationProbe', app: 'Mail', title: 'Somebody' } });
    await send({ secret, body: noAmount() });
    const logged = await send({ secret, body: wallet });
    await send({ secret, body: wallet });

    expect(logged.body.response.outcome).toBe('logged');
    await until(async () => (await events()).length === 4, { timeout: 10_000, interval: 100 });
    const [probe, first, payment, again] = await events();
    expect(probe).toMatchObject({ kind: 'notificationProbe', sender: 'Somebody', outcome: 'probe', textEnc: null });
    expect(probe!.decision).toContain('probe:noSend');
    expect(first!.decision).toContain('prefilter:noAmount');
    expect(again!.decision).toBe('kind:notification > duplicate:key');
    expect(payment).toMatchObject({ outcome: 'logged', requestStatus: 'logged' });
    expect(payment!.requestId).toBeTruthy();
    expect(payment!.transactionId).toBeTruthy();
  });

  it('traces the refusal of a listed token that failed authentication', async () => {
    const { secret, token } = await ingestHelpers.createTestIngestToken({ expiresAt: new Date(Date.now() - 60_000) });
    process.env.INGEST_DEBUG_TOKEN_IDS = token.id;

    const res = await send({ secret, body: noAmount() });

    expect(res.status).toBe(401);
    await until(async () => (await events()).length === 1, { timeout: 10_000, interval: 100 });
    const [event] = await events();
    expect(event).toMatchObject({ tokenId: token.id, httpStatus: 401, decision: 'http401', userId: expect.anything() });
  });

  it('leaves nothing for a token that is not listed, or when the variable is empty', async () => {
    const { secret } = await ingestHelpers.createTestIngestToken();

    process.env.INGEST_DEBUG_TOKEN_IDS = randomUUID();
    const unlisted = await send({ secret, body: noAmount() });
    delete process.env.INGEST_DEBUG_TOKEN_IDS;
    const off = await send({ secret, body: noAmount() });

    expect(unlisted.body.response.outcome).toBe('dropped');
    expect(off.body.response.outcome).toBe('dropped');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await events()).toHaveLength(0);
  });

  it('is deleted after a week by the ingest cleanup, and a younger row stays', async () => {
    const { token } = await ingestHelpers.createTestIngestToken();
    const make = ({ key }: { key: string }) =>
      IngestDebugEvents.create({
        tokenId: token.id,
        endpoint: '/api/v1/ingest/event',
        httpStatus: 200,
        decision: key,
        steps: [],
        latencyMs: 1,
      });
    const old = await make({ key: 'old' });
    await make({ key: 'new' });
    await connection.sequelize.query(
      `UPDATE "IngestDebugEvents" SET "createdAt" = now() - interval '8 days' WHERE id = :id`,
      {
        replacements: { id: old.id },
      },
    );

    const result = await ingestRequestsCleanupCron.triggerManualSync();

    expect(result).toMatchObject({ debugEventsDeleted: 1 });
    expect((await events()).map((event) => event.decision)).toEqual(['new']);
  });
});
