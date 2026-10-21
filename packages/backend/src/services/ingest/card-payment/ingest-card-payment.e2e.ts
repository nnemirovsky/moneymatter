import { API_ERROR_CODES } from '@bt/shared/types';
import { describe, expect, it, afterEach } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import Transactions from '@models/transactions.model';
import { redisClient } from '@root/redis-client';
import { buildLockKey } from '@services/currencies/base-currency-lock';
import { cardPaymentTimings } from '@services/ingest/card-payment/constants';
import * as helpers from '@tests/helpers';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { randomUUID } from 'node:crypto';

const CARD = 'TBC Visa';
const MERCHANT = 'Cafe Heart of Batumi';
const DEFAULT_REPEAT_WINDOW_MS = cardPaymentTimings.repeatWindowMs;

const payment = (overrides: Record<string, unknown> = {}) => ({
  amount: '47.00',
  merchant: MERCHANT,
  card: CARD,
  source: 'apple-pay',
  idempotencyKey: `key-${randomUUID()}`,
  ...overrides,
});

/** A user with an account in the base currency, the card linked to it and a token for the ingest endpoint. */
const setUp = async () => {
  const account = await helpers.createAccount({ raw: true });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: account.id }, raw: true });
  const { secret } = await ingestHelpers.createTestIngestToken();

  return { account, secret };
};

const send = ({ secret, body }: { secret: string; body: object }) => ingestHelpers.postCardPayment({ secret, body });

const transactionsOf = () => helpers.getTransactions({ raw: true });

afterEach(() => {
  cardPaymentTimings.repeatWindowMs = DEFAULT_REPEAT_WINDOW_MS;
});

describe('POST /ingest/card-payment', () => {
  describe('logging', () => {
    it('logs a payment from a linked card in the account currency', async () => {
      const { account, secret } = await setUp();
      const body = payment();

      const res = await send({ secret, body });

      expect(res.status).toBe(200);
      expect(res.body.response).toMatchObject({ outcome: 'logged', planned: false, categoryPending: false });
      expect(res.body.response.summary).toMatch(new RegExp(`^Logged 47\\.00 [A-Z]{3} at ${MERCHANT} → `));
      expect(res.body.response.duplicate).toBeUndefined();

      const transactions = await transactionsOf();
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject({
        id: res.body.response.transactionId,
        accountId: account.id,
        amount: 47,
        transactionType: 'expense',
        paymentType: 'mobilePayment',
        isPlanned: false,
        externalReference: `apple-pay:${body.idempotencyKey}`,
      });

      const stored = await Transactions.findOne({ where: { id: res.body.response.transactionId } });
      expect(stored!.externalData.cardPayment).toMatchObject({
        source: 'apple-pay',
        card: CARD,
        merchant: MERCHANT,
        rawAmount: '47.00',
      });
      // Every automated payment is written at once and waits for the owner's confirmation.
      expect(stored!.externalData.ingest).toMatchObject({
        pipeline: 'cardPayment',
        unconfirmed: true,
        systemNote: MERCHANT,
        systemCategoryId: expect.any(String),
      });
    });

    it('strips NUL characters, which a JSONB column would refuse', async () => {
      const { secret } = await setUp();

      const res = await send({ secret, body: payment({ merchant: 'Caf\u0000e', name: 'a\u0000b' }) });

      expect(res.status).toBe(200);
      expect(res.body.response.summary).toContain(' at Cafe → ');
    });
  });

  describe('dry run', () => {
    it('answers that the card is not linked yet and writes nothing', async () => {
      const secret = (await ingestHelpers.createTestIngestToken()).secret;

      const res = await send({ secret, body: { dryRun: true, card: CARD } });

      expect(res.status).toBe(200);
      expect(res.body.response.outcome).toBe('dryRun');
      expect(res.body.response.summary).toMatch(/^Connected as .+\. Card "TBC Visa" is not linked yet$/);
      expect(await IngestRequests.count()).toBe(0);
      expect(await transactionsOf()).toEqual([]);
    });

    it('names the account of a linked card', async () => {
      const { secret } = await setUp();

      const res = await send({ secret, body: { dryRun: true, card: CARD } });

      expect(res.body.response.summary).toMatch(/Card "TBC Visa" → test$/);
      expect(await IngestRequests.count()).toBe(0);
    });

    it('counts the linked cards when no card is sent', async () => {
      const { secret } = await setUp();

      const res = await send({ secret, body: { dryRun: true } });

      expect(res.body.response.summary).toMatch(/\. 1 card linked\.$/);
    });
  });

  describe('an unlinked card', () => {
    it('parks the payment instead of logging or losing it, and logs it once the card is linked', async () => {
      const { account, secret } = await setUp();
      const body = payment({ card: 'Revolut Metal' });

      const parked = await send({ secret, body });

      expect(parked.status).toBe(202);
      expect(parked.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownCard' });
      expect(parked.body.response.summary).toContain('link the card "Revolut Metal"');
      expect(parked.body.response.requestId).toEqual(expect.any(String));
      expect(await transactionsOf()).toEqual([]);

      const stored = await IngestRequests.findOne({ where: { id: parked.body.response.requestId } });
      expect(stored).toMatchObject({ status: 'parked', reason: 'unknownCard', cardLabel: 'Revolut Metal' });

      expect((await send({ secret, body })).status).toBe(202);

      await helpers.createCardMapping({ payload: { cardLabel: 'Revolut Metal', accountId: account.id }, raw: true });
      const logged = await send({ secret, body });

      expect(logged.status).toBe(200);
      expect(logged.body.response.outcome).toBe('logged');
      expect(await transactionsOf()).toHaveLength(1);
      expect((await IngestRequests.findOne({ where: { id: stored!.id } }))!.status).toBe('logged');
    });
  });

  describe('idempotency', () => {
    it('answers a resent request with the stored outcome and creates one transaction', async () => {
      const { secret } = await setUp();
      const body = payment();

      const first = await send({ secret, body });
      const second = await send({ secret, body });

      expect(second.status).toBe(200);
      expect(second.body.response.duplicate).toBe(true);
      expect(second.body.response.summary).toMatch(/^Already logged 47\.00 [A-Z]{3} at /);
      expect(second.body.response.transactionId).toBe(first.body.response.transactionId);
      expect(await transactionsOf()).toHaveLength(1);
    });

    it('answers 409 when the same key arrives with another payment', async () => {
      const { secret } = await setUp();
      const body = payment();
      await send({ secret, body });

      const res = await send({ secret, body: { ...body, amount: '48.00' } });

      expect(res.status).toBe(409);
      expect(res.body.status).toBe('error');
      expect(await transactionsOf()).toHaveLength(1);
    });

    it('logs one transaction for two concurrent requests with the same key', async () => {
      const { secret } = await setUp();
      const body = payment();

      const [first, second] = await Promise.all([send({ secret, body }), send({ secret, body })]);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect([first.body.response.duplicate, second.body.response.duplicate].filter(Boolean)).toHaveLength(1);
      expect(first.body.response.transactionId).toBe(second.body.response.transactionId);
      expect(await transactionsOf()).toHaveLength(1);
    });
  });

  describe('repeat window', () => {
    it('treats the same payment under another key as a repeat', async () => {
      const { secret } = await setUp();

      const first = await send({ secret, body: payment() });
      const second = await send({ secret, body: payment() });

      expect(second.status).toBe(200);
      expect(second.body.response.duplicate).toBe(true);
      expect(second.body.response.summary).toMatch(/^Already logged /);
      expect(second.body.response.transactionId).toBe(first.body.response.transactionId);
      expect(await transactionsOf()).toHaveLength(1);

      const rows = await IngestRequests.findAll({ order: [['createdAt', 'ASC']] });
      expect(rows.map((row) => row.status)).toEqual(['logged', 'logged']);
      expect(rows[1]!.duplicateOfId).toBe(rows[0]!.id);
    });

    it('logs a different amount as a new payment', async () => {
      const { secret } = await setUp();

      await send({ secret, body: payment() });
      const second = await send({ secret, body: payment({ amount: '12.00' }) });

      expect(second.body.response.duplicate).toBeUndefined();
      expect(await transactionsOf()).toHaveLength(2);
    });

    it('logs the same payment again once the window has passed', async () => {
      cardPaymentTimings.repeatWindowMs = 800;
      const { secret } = await setUp();

      await send({ secret, body: payment() });
      await helpers.sleep(1000);
      const second = await send({ secret, body: payment() });

      expect(second.body.response.duplicate).toBeUndefined();
      expect(await transactionsOf()).toHaveLength(2);
    });

    it('does not let a repeat anchor the window', async () => {
      // Run times sent by the shortcut: 15 s after the original is a repeat (window 20 s), 30 s after
      // the original is not, although it is only 15 s after the repeat. Stated times need no sleeping.
      const { secret } = await setUp();
      const start = Date.now() - 10 * 60_000;
      const at = ({ seconds }: { seconds: number }) => new Date(start + seconds * 1000).toISOString();

      const original = await send({ secret, body: payment({ time: at({ seconds: 0 }) }) });
      const repeat = await send({ secret, body: payment({ time: at({ seconds: 15 }) }) });
      const later = await send({ secret, body: payment({ time: at({ seconds: 30 }) }) });

      expect(repeat.body.response.duplicate).toBe(true);
      expect(later.body.response.duplicate).toBeUndefined();
      expect(later.body.response.transactionId).not.toBe(original.body.response.transactionId);
      expect(await transactionsOf()).toHaveLength(2);
    });
  });

  describe('rejections', () => {
    it.each([
      { label: 'a zero amount', overrides: { amount: '0.00' }, reason: 'zeroAmount' },
      { label: 'a negative amount', overrides: { amount: '-5' }, reason: 'negativeAmount' },
      { label: 'an unreadable amount', overrides: { amount: 'abc' }, reason: 'invalidAmount' },
      { label: 'a blank merchant', overrides: { merchant: '   ' }, reason: 'blankMerchant' },
      { label: 'a currency that does not exist', overrides: { currency: 'ZZZ' }, reason: 'invalidCurrency' },
      { label: 'a time in the future', overrides: { time: '2999-01-01T00:00:00Z' }, reason: 'timeInFuture' },
    ])('answers 422 for $label and keeps the request as rejected', async ({ overrides, reason }) => {
      const { secret } = await setUp();
      const body = payment(overrides);

      const res = await send({ secret, body });

      expect(res.status).toBe(422);
      expect(res.body.status).toBe('error');
      expect(res.body.response.code).toBe(API_ERROR_CODES.validationError);
      expect(res.body.response.details).toEqual({ reason });
      expect(res.body.response.message).toEqual(expect.any(String));
      expect(await transactionsOf()).toEqual([]);

      const row = await IngestRequests.findOne({ where: { idempotencyKey: body.idempotencyKey } });
      expect(row).toMatchObject({ status: 'rejected', reason });

      const replay = await send({ secret, body });
      expect(replay.status).toBe(422);
      expect(replay.body.response.message).toBe(res.body.response.message);
    });

    it.each([
      { label: 'no idempotency key', overrides: { idempotencyKey: undefined } },
      { label: 'a too short idempotency key', overrides: { idempotencyKey: 'short' } },
    ])('answers 422 for $label without recording a row', async ({ overrides }) => {
      const { secret } = await setUp();

      const res = await send({ secret, body: payment(overrides) });

      expect(res.status).toBe(422);
      expect(res.body.response.details).toEqual({ reason: 'invalidIdempotencyKey' });
      expect(await IngestRequests.count()).toBe(0);
    });

    it('answers 413 for a body over 8 KB', async () => {
      const { secret } = await setUp();

      const res = await send({ secret, body: payment({ name: 'x'.repeat(9000) }) });

      expect(res.status).toBe(413);
      expect(await IngestRequests.count()).toBe(0);
    });
  });

  describe('authentication and limits', () => {
    it('answers 401 without a token', async () => {
      const res = await ingestHelpers.requestWithoutSession({
        method: 'post',
        url: '/ingest/card-payment',
        headers: {},
        body: payment(),
      });

      expect(res.status).toBe(401);
    });

    it('answers 401 to a token that does not exist', async () => {
      const res = await send({ secret: `mm_ingest_${'A'.repeat(43)}`, body: payment() });

      expect(res.status).toBe(401);
    });

    it('answers 401 to a session cookie without a token', async () => {
      await setUp();

      const res = await helpers.makeRequest({ method: 'post', url: '/ingest/card-payment', payload: payment() });

      expect(res.statusCode).toBe(401);
    });

    it('answers 402 planRequired on a read-only plan', async () => {
      const { secret } = await setUp();
      await helpers.setUserBilling({ trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });

      const res = await send({ secret, body: payment() });

      expect(res.status).toBe(402);
      expect(res.body.response.code).toBe(API_ERROR_CODES.planRequired);
      expect(await transactionsOf()).toEqual([]);
    });

    it('answers 423 while a base-currency change is running', async () => {
      const { secret } = await setUp();
      const user = await helpers.getUserInfo({ raw: true });

      await redisClient.set(buildLockKey(user.id), 'test-lock');
      try {
        const res = await send({ secret, body: payment() });

        expect(res.status).toBe(423);
        expect(res.body.response.code).toBe(API_ERROR_CODES.baseCurrencyChangeInProgress);
        expect(res.body.response.message).toBe(
          "MoneyMatter is busy updating your currency. This payment wasn't saved, try again in a minute.",
        );
      } finally {
        await redisClient.del(buildLockKey(user.id));
      }
    });

    it('answers 429 with Retry-After on the 31st request in a minute', async () => {
      const { secret } = await setUp();

      for (let attempt = 1; attempt <= 30; attempt++) {
        expect((await send({ secret, body: { dryRun: true } })).status).toBe(200);
      }
      const res = await send({ secret, body: { dryRun: true } });

      expect(res.status).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    }, 60000);

    it('blocks even a valid token once the IP has spent its failed-authentication budget', async () => {
      const { secret } = await setUp();
      const wrong = `mm_ingest_${'B'.repeat(43)}`;

      for (let attempt = 1; attempt <= 20; attempt++) {
        expect((await send({ secret: wrong, body: payment() })).status).toBe(401);
      }

      expect((await send({ secret: wrong, body: payment() })).status).toBe(429);
      const valid = await send({ secret, body: payment() });
      expect(valid.status).toBe(429);
      expect(Number(valid.headers['retry-after'])).toBeGreaterThan(0);
    }, 60000);
  });
});
