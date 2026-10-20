import {
  CARD_PAYMENT_RECENT_REQUESTS_LIMIT,
  CATEGORIZATION_SOURCE,
  PLANNED_MATCH_WINDOW_DAYS,
  type RecordId,
} from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import CardAccountMappings from '@models/card-account-mappings.model';
import { connection } from '@models/connection';
import IngestRequests from '@models/ingest-requests.model';
import Transactions from '@models/transactions.model';
import { redisClient } from '@root/redis-client';
import { buildLockKey } from '@services/currencies/base-currency-lock';
import * as helpers from '@tests/helpers';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { VALID_GEMINI_API_KEY, createGeminiMock } from '@tests/mocks/gemini/mock-api';
import { getLunchFlowBalanceMock, getLunchFlowTransactionsMock } from '@tests/mocks/lunchflow/mock-api';
import { randomUUID } from 'node:crypto';

const CARD = 'TBC Visa';
const OTHER_CARD = 'Revolut Metal';
const MERCHANT = 'Cafe Heart of Batumi';
const DAY_MS = 24 * 60 * 60 * 1000;

const payment = (overrides: Record<string, unknown> = {}) => ({
  amount: '47.00',
  merchant: MERCHANT,
  card: CARD,
  source: 'apple-pay',
  idempotencyKey: `key-${randomUUID()}`,
  ...overrides,
});

const send = ({ secret, body }: { secret: string; body: object }) => ingestHelpers.postCardPayment({ secret, body });

const transactionsOf = () => helpers.getTransactions({ raw: true });

const linkCard = async ({ card = CARD, accountId }: { card?: string; accountId: RecordId }) =>
  helpers.createCardMapping({ payload: { cardLabel: card, accountId }, raw: true });

/** A user with a base-currency account and a token, and no card linked yet. */
const setUp = async () => {
  const account = await helpers.createAccount({ raw: true });
  const { secret } = await ingestHelpers.createTestIngestToken();

  return { account, secret };
};

/** Parks one payment because its card is unlinked and returns the request id. */
const parkPayment = async ({
  secret,
  overrides = {},
}: {
  secret: string;
  overrides?: Record<string, unknown>;
}): Promise<RecordId> => {
  const res = await send({ secret, body: payment({ card: OTHER_CARD, ...overrides }) });

  expect(res.status).toBe(202);
  expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownCard' });

  return res.body.response.requestId;
};

/** Runs `fn` with `Date` moved forward by `offsetMs`; timers stay real so requests and the DB keep working. */
const withClockAhead = async <T>({ offsetMs, fn }: { offsetMs: number; fn: () => Promise<T> }): Promise<T> => {
  jest.useFakeTimers({
    now: new Date(Date.now() + offsetMs),
    doNotFake: ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'nextTick', 'performance'],
  });

  try {
    return await fn();
  } finally {
    jest.useRealTimers();
  }
};

/** Pairs LunchFlow and connects its first account, which makes it a bank-connected account. */
const connectedAccount = async () => {
  const { connectionId } = await helpers.lunchflow.pair();

  global.mswMockServer.use(
    getLunchFlowTransactionsMock({ response: { transactions: [], total: 0 } }),
    getLunchFlowBalanceMock(),
  );

  const { accounts } = await helpers.bankDataProviders.listExternalAccounts({ connectionId, raw: true });
  const { syncedAccounts } = await helpers.bankDataProviders.connectSelectedAccounts({
    connectionId,
    accountExternalIds: [accounts[0]!.externalId],
    raw: true,
  });

  return syncedAccounts[0]!;
};

describe('waiting card payments', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('empty state', () => {
    it('lists nothing for a user who never sent a payment', async () => {
      expect(await helpers.listCardPaymentRequests({ status: 'parked', raw: true })).toEqual([]);
      expect(await helpers.listCardPaymentRequests({ status: 'recent', raw: true })).toEqual([]);
      expect(await helpers.listUnlinkedCards({ raw: true })).toEqual([]);
      expect(await helpers.listUnconfirmedCardPayments({ raw: true })).toEqual([]);
    });

    it('rejects an unknown view', async () => {
      expect((await helpers.listCardPaymentRequests({ status: 'everything' })).status).toBe(422);
    });
  });

  describe('listing', () => {
    it('lists a payment parked on an unlinked card with what the client sent', async () => {
      const { secret } = await setUp();
      const requestId = await parkPayment({ secret, overrides: { amount: '47,00 GEL' } });

      const parked = await helpers.listCardPaymentRequests({ status: 'parked', raw: true });

      expect(parked).toHaveLength(1);
      expect(parked[0]).toMatchObject({
        id: requestId,
        status: 'parked',
        reason: 'unknownCard',
        cardLabel: OTHER_CARD,
        merchant: MERCHANT,
        amountText: '47,00 GEL',
        transactionId: null,
      });
      expect(parked[0]!.summary).toContain(`link the card "${OTHER_CARD}"`);
      expect(new Date(parked[0]!.time).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('returns the last 50 requests of every status, newest first', async () => {
      const { account, secret } = await setUp();
      await linkCard({ accountId: account.id });

      const logged = await send({ secret, body: payment() });
      const parkedId = await parkPayment({ secret });
      const rejected = await send({ secret, body: payment({ amount: '0' }) });
      const dismissedId = await parkPayment({ secret, overrides: { merchant: 'Spar' } });
      await helpers.dismissCardPaymentRequest({ id: dismissedId, raw: true });
      expect(logged.status).toBe(200);
      expect(rejected.status).toBe(422);

      const recent = await helpers.listCardPaymentRequests({ status: 'recent', raw: true });

      expect(recent.map((item) => item.status)).toEqual(['dismissed', 'rejected', 'parked', 'logged']);
      expect(recent[0]).toMatchObject({ id: dismissedId, merchant: 'Spar', cardLabel: OTHER_CARD });
      expect(recent[1]).toMatchObject({ status: 'rejected', reason: 'zeroAmount', amountText: '0' });
      expect(recent[2]!.id).toBe(parkedId);
      expect(recent[3]).toMatchObject({
        status: 'logged',
        cardLabel: CARD,
        merchant: MERCHANT,
        amountText: '47.00',
        transactionId: logged.body.response.transactionId,
      });
      expect(recent[3]!.summary).toMatch(/^Logged 47\.00 [A-Z]{3} at /);
    });

    it('caps the recent view at 50 rows', async () => {
      const user = await helpers.getUserInfo({ raw: true });
      await IngestRequests.bulkCreate(
        Array.from({ length: CARD_PAYMENT_RECENT_REQUESTS_LIMIT + 2 }, (_, index) => ({
          userId: user.id,
          source: 'apple-pay',
          idempotencyKey: `seed-${index}`,
          fingerprint: `fingerprint-${index}`,
          status: 'logged' as const,
          payload: { amount: '1.00', merchant: `Shop ${index}`, card: CARD },
          cardLabel: CARD,
        })),
      );
      await connection.sequelize.query(
        `UPDATE "IngestRequests" SET "createdAt" = now() - make_interval(mins => split_part("idempotencyKey", '-', 2)::int) WHERE "idempotencyKey" LIKE 'seed-%'`,
      );

      const recent = await helpers.listCardPaymentRequests({ status: 'recent', raw: true });

      expect(recent).toHaveLength(CARD_PAYMENT_RECENT_REQUESTS_LIMIT);
      expect(recent[0]!.merchant).toBe('Shop 0');
      expect(recent[CARD_PAYMENT_RECENT_REQUESTS_LIMIT - 1]!.merchant).toBe(
        `Shop ${CARD_PAYMENT_RECENT_REQUESTS_LIMIT - 1}`,
      );
    });
  });

  describe('unlinked cards', () => {
    it('counts the waiting payments per card, merging spellings of one label, and drops a card once it is linked', async () => {
      const { account, secret } = await setUp();
      await parkPayment({ secret, overrides: { merchant: 'Shop A' } });
      await parkPayment({ secret, overrides: { merchant: 'Shop B', card: ` ${OTHER_CARD.toUpperCase()} ` } });
      await parkPayment({ secret, overrides: { merchant: 'Shop C', card: 'Amex Gold' } });

      const unlinked = await helpers.listUnlinkedCards({ raw: true });

      expect(unlinked).toHaveLength(2);
      expect(unlinked[0]).toMatchObject({ count: 2 });
      expect(unlinked[0]!.cardLabel.trim().toLowerCase()).toBe(OTHER_CARD.toLowerCase());
      expect(unlinked[1]).toEqual({ cardLabel: 'Amex Gold', count: 1 });

      await linkCard({ card: OTHER_CARD, accountId: account.id });

      expect(await helpers.listUnlinkedCards({ raw: true })).toEqual([{ cardLabel: 'Amex Gold', count: 1 }]);
    });
  });

  describe('retry', () => {
    it('logs a parked payment once its card is linked', async () => {
      const { account, secret } = await setUp();
      const requestId = await parkPayment({ secret });
      await linkCard({ card: OTHER_CARD, accountId: account.id });

      const retry = await helpers.retryCardPaymentRequest({ id: requestId });

      expect(retry.status).toBe(200);
      expect(retry.body.response).toMatchObject({ outcome: 'logged', planned: false });
      expect(retry.body.response.summary).toMatch(new RegExp(`^Logged 47\\.00 [A-Z]{3} at ${MERCHANT} → `));

      const transactions = await transactionsOf();
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject({ id: (retry.body.response as { transactionId: string }).transactionId });
      expect(transactions[0]).toMatchObject({ accountId: account.id, amount: 47, transactionType: 'expense' });

      expect(await helpers.listCardPaymentRequests({ status: 'parked', raw: true })).toEqual([]);
      expect(await helpers.listUnlinkedCards({ raw: true })).toEqual([]);
      expect((await IngestRequests.findOne({ where: { id: requestId } }))!.status).toBe('logged');
    });

    it('keeps the payment parked while the card is still unlinked', async () => {
      const { secret } = await setUp();
      const requestId = await parkPayment({ secret });

      const retry = await helpers.retryCardPaymentRequest({ id: requestId });

      expect(retry.status).toBe(202);
      expect(retry.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownCard', requestId });
      expect(await transactionsOf()).toEqual([]);
      expect(await helpers.listCardPaymentRequests({ status: 'parked', raw: true })).toHaveLength(1);
    });

    it('answers 409 for a request that is already logged, and logs nothing twice', async () => {
      const { account, secret } = await setUp();
      const requestId = await parkPayment({ secret });
      await linkCard({ card: OTHER_CARD, accountId: account.id });
      expect((await helpers.retryCardPaymentRequest({ id: requestId })).status).toBe(200);

      const again = await helpers.retryCardPaymentRequest({ id: requestId });

      expect(again.status).toBe(409);
      expect(await transactionsOf()).toHaveLength(1);
    });

    it('answers 409 for a rejected request and for a dismissed one', async () => {
      const { secret } = await setUp();
      const rejected = await send({ secret, body: payment({ amount: '0' }) });
      expect(rejected.status).toBe(422);
      const rejectedRow = (await IngestRequests.findOne({ where: { status: 'rejected' } }))!;
      const dismissedId = await parkPayment({ secret, overrides: { merchant: 'Spar' } });
      await helpers.dismissCardPaymentRequest({ id: dismissedId, raw: true });

      expect((await helpers.retryCardPaymentRequest({ id: rejectedRow.id })).status).toBe(409);
      expect((await helpers.retryCardPaymentRequest({ id: dismissedId })).status).toBe(409);
    });

    it('answers 404 for an id that is not the user own request', async () => {
      expect((await helpers.retryCardPaymentRequest({ id: randomUUID() })).status).toBe(404);
    });

    it('answers 423 while a base-currency change is running', async () => {
      const { secret } = await setUp();
      const requestId = await parkPayment({ secret });
      const user = await helpers.getUserInfo({ raw: true });
      await redisClient.set(buildLockKey(user.id), 'test-lock');

      try {
        expect((await helpers.retryCardPaymentRequest({ id: requestId })).status).toBe(423);
      } finally {
        await redisClient.del(buildLockKey(user.id));
      }
    });

    it('logs one transaction for two concurrent retries and answers the other with 409', async () => {
      const { account, secret } = await setUp();
      const requestId = await parkPayment({ secret });
      await linkCard({ card: OTHER_CARD, accountId: account.id });

      const results = await Promise.all([
        helpers.retryCardPaymentRequest({ id: requestId }),
        helpers.retryCardPaymentRequest({ id: requestId }),
      ]);

      expect(results.map((res) => res.status).toSorted()).toEqual([200, 409]);
      expect(await transactionsOf()).toHaveLength(1);
    });

    it('folds a second request for the same payment into the first when both are retried', async () => {
      const { account, secret } = await setUp();
      const first = await parkPayment({ secret });
      const second = await parkPayment({ secret });
      await linkCard({ card: OTHER_CARD, accountId: account.id });

      const firstRetry = await helpers.retryCardPaymentRequest({ id: first });
      const secondRetry = await helpers.retryCardPaymentRequest({ id: second });

      expect(firstRetry.status).toBe(200);
      expect(firstRetry.body.response).not.toHaveProperty('duplicate');
      expect(secondRetry.status).toBe(200);
      expect(secondRetry.body.response).toMatchObject({ outcome: 'logged', duplicate: true });
      expect(secondRetry.body.response.summary).toMatch(/^Already logged /);
      expect(await transactionsOf()).toHaveLength(1);
    });

    it('lists a request that failed while processing as parked and logs it on retry', async () => {
      const { account, secret } = await setUp();
      await linkCard({ accountId: account.id });
      jest.spyOn(CardAccountMappings, 'findAll').mockRejectedValueOnce(new Error('the database blinked'));

      const failed = await send({ secret, body: payment() });

      expect(failed.status).toBe(202);
      expect(failed.body.response).toMatchObject({ outcome: 'parked', reason: 'processingFailed' });
      expect(await transactionsOf()).toEqual([]);

      const parked = await helpers.listCardPaymentRequests({ status: 'parked', raw: true });
      expect(parked).toHaveLength(1);
      expect(parked[0]).toMatchObject({ status: 'parked', reason: 'processingFailed' });

      const retry = await helpers.retryCardPaymentRequest({ id: failed.body.response.requestId });

      expect(retry.status).toBe(200);
      expect(retry.body.response).toMatchObject({ outcome: 'logged' });
      expect(await transactionsOf()).toHaveLength(1);
    });

    it('logs a payment parked 35 days ago with the time it was sent, or the time it was received', async () => {
      const { account, secret } = await setUp();
      const sentAt = new Date(Date.now() - 60 * 60 * 1000);
      sentAt.setMilliseconds(0);
      const withTime = await parkPayment({ secret, overrides: { merchant: 'Shop A', time: sentAt.toISOString() } });
      const withoutTime = await parkPayment({ secret, overrides: { merchant: 'Shop B' } });
      const received = (await IngestRequests.findOne({ where: { id: withoutTime } }))!.createdAt;
      await linkCard({ card: OTHER_CARD, accountId: account.id });

      const retried = await withClockAhead({
        offsetMs: 35 * DAY_MS,
        fn: async () => [
          await helpers.retryCardPaymentRequest({ id: withTime }),
          await helpers.retryCardPaymentRequest({ id: withoutTime }),
        ],
      });

      expect(retried.map((res) => res.status)).toEqual([200, 200]);
      const stored = await Promise.all(
        retried.map(
          async (res) =>
            (await Transactions.findOne({
              where: { id: (res.body.response as { transactionId: string }).transactionId },
            }))!,
        ),
      );
      expect(new Date(stored[0]!.time).toISOString()).toBe(sentAt.toISOString());
      expect(Math.abs(new Date(stored[1]!.time).getTime() - received.getTime())).toBeLessThan(2_000);
    });

    it('offers a request left received by an interrupted pass only after a minute, then logs it on retry', async () => {
      const { account, secret } = await setUp();
      await linkCard({ accountId: account.id });
      const realFindOne = IngestRequests.findOne.bind(IngestRequests);
      let lockedReads = 0;
      jest.spyOn(CardAccountMappings, 'findAll').mockRejectedValueOnce(new Error('processing died'));
      jest.spyOn(IngestRequests, 'findOne').mockImplementation(((options?: { lock?: unknown }) => {
        if (options?.lock) {
          lockedReads += 1;
          if (lockedReads === 2) return Promise.reject(new Error('parking died too'));
        }

        return realFindOne(options as never);
      }) as never);

      const interrupted = await send({ secret, body: payment() });
      jest.restoreAllMocks();

      expect(interrupted.status).toBeGreaterThanOrEqual(500);
      expect((await IngestRequests.findAll()).map((row) => row.status)).toEqual(['received']);
      expect(await helpers.listCardPaymentRequests({ status: 'parked', raw: true })).toEqual([]);
      expect((await helpers.retryCardPaymentRequest({ id: (await IngestRequests.findOne())!.id })).status).toBe(409);

      const { listed, retry } = await withClockAhead({
        offsetMs: 2 * 60 * 1000,
        fn: async () => {
          const rows = await helpers.listCardPaymentRequests({ status: 'parked', raw: true });

          return { listed: rows, retry: await helpers.retryCardPaymentRequest({ id: rows[0]!.id }) };
        },
      });

      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ status: 'received', reason: 'interrupted' });
      expect(retry.status).toBe(200);
      expect(retry.body.response).toMatchObject({ outcome: 'logged' });
      expect(await transactionsOf()).toHaveLength(1);
    });

    it('leaves a request logged by a concurrent retry alone when the failing pass parks it', async () => {
      const { account, secret } = await setUp();
      const key = `key-${randomUUID()}`;
      const requestId = await parkPayment({ secret, overrides: { idempotencyKey: key } });
      await linkCard({ card: OTHER_CARD, accountId: account.id });

      const realFindOne = IngestRequests.findOne.bind(IngestRequests);
      let lockedReads = 0;
      let reachedParking!: () => void;
      let resumeParking!: () => void;
      const parkingReached = new Promise<void>((resolve) => {
        reachedParking = resolve;
      });
      const parkingResumed = new Promise<void>((resolve) => {
        resumeParking = resolve;
      });
      jest.spyOn(CardAccountMappings, 'findAll').mockRejectedValueOnce(new Error('processing died'));
      jest.spyOn(IngestRequests, 'findOne').mockImplementation((async (options?: { lock?: unknown }) => {
        if (options?.lock) {
          lockedReads += 1;
          if (lockedReads === 2) {
            reachedParking();
            await parkingResumed;
          }
        }

        return realFindOne(options as never);
      }) as never);

      const resend = send({ secret, body: payment({ card: OTHER_CARD, idempotencyKey: key }) }).then((res) => res);
      await parkingReached;
      const retry = await helpers.retryCardPaymentRequest({ id: requestId });
      resumeParking();
      const resent = await resend;
      jest.restoreAllMocks();

      expect(retry.status).toBe(200);
      expect(resent.status).toBe(200);
      expect(resent.body.response).toMatchObject({ outcome: 'logged', duplicate: true });
      expect((await IngestRequests.findOne({ where: { id: requestId } }))!.status).toBe('logged');
      expect((await helpers.retryCardPaymentRequest({ id: requestId })).status).toBe(409);
      expect(await transactionsOf()).toHaveLength(1);
    });

    describe('with AI categorization', () => {
      let originalGeminiApiKey: string | undefined;

      beforeEach(() => {
        originalGeminiApiKey = process.env.GEMINI_API_KEY;
      });

      afterEach(() => {
        if (originalGeminiApiKey === undefined) {
          delete process.env.GEMINI_API_KEY;
        } else {
          process.env.GEMINI_API_KEY = originalGeminiApiKey;
        }
      });

      it('names the AI category in the answer of a retry that logs the payment', async () => {
        process.env.GEMINI_API_KEY = VALID_GEMINI_API_KEY;
        const coffee = await helpers.addCustomCategory({ name: 'Coffee', color: '#336699', raw: true });
        global.mswMockServer.use(createGeminiMock({ categorizationsByName: { 1: 'Coffee' } }));
        const { account, secret } = await setUp();
        const requestId = await parkPayment({ secret });
        await linkCard({ card: OTHER_CARD, accountId: account.id });

        const retry = await helpers.retryCardPaymentRequest({ id: requestId });

        expect(retry.status).toBe(200);
        expect(retry.body.response).toMatchObject({ outcome: 'logged', categoryPending: false });
        expect(retry.body.response.summary).toMatch(/ → Coffee$/);

        const transactionId = (retry.body.response as { transactionId: RecordId }).transactionId;
        await until(
          async () =>
            (await helpers.getTransactionById({ id: transactionId, raw: true }))?.categorizationMeta?.source ===
            CATEGORIZATION_SOURCE.ai,
          { timeout: 20_000, interval: 250 },
        );
        expect((await helpers.getTransactionById({ id: transactionId, raw: true }))!.categoryId).toBe(coffee.id);
      }, 60_000);
    });
  });

  describe('dismiss', () => {
    it('marks a waiting request dismissed, and a second dismiss is a 404', async () => {
      const { secret } = await setUp();
      const requestId = await parkPayment({ secret });

      const dismissed = await helpers.dismissCardPaymentRequest({ id: requestId });

      expect(dismissed.status).toBe(200);
      expect((await IngestRequests.findOne({ where: { id: requestId } }))!.status).toBe('dismissed');
      expect(await helpers.listCardPaymentRequests({ status: 'parked', raw: true })).toEqual([]);
      expect(await helpers.listUnlinkedCards({ raw: true })).toEqual([]);
      expect((await helpers.dismissCardPaymentRequest({ id: requestId })).status).toBe(404);
    });

    it('answers 404 for an unknown id and for a request that is already logged', async () => {
      const { account, secret } = await setUp();
      await linkCard({ accountId: account.id });
      const logged = await send({ secret, body: payment() });
      const loggedRow = (await IngestRequests.findOne({ where: { status: 'logged' } }))!;

      expect(logged.status).toBe(200);
      expect((await helpers.dismissCardPaymentRequest({ id: randomUUID() })).status).toBe(404);
      expect((await helpers.dismissCardPaymentRequest({ id: loggedRow.id })).status).toBe(404);
    });
  });

  describe('not confirmed by the bank', () => {
    it('lists a card-payment plan once the match window has passed, and never a plan the user wrote', async () => {
      const account = await connectedAccount();
      const { secret } = await ingestHelpers.createTestIngestToken();
      await linkCard({ accountId: account.id });
      await helpers.createPlannedTransaction({
        payload: { accountId: account.id, note: 'Rent, written by the user' },
        raw: true,
      });
      const logged = await send({ secret, body: payment() });
      expect(logged.body.response).toMatchObject({ outcome: 'logged', planned: true });

      expect(await helpers.listUnconfirmedCardPayments({ raw: true })).toEqual([]);
      expect(
        await withClockAhead({
          offsetMs: (PLANNED_MATCH_WINDOW_DAYS - 1) * DAY_MS,
          fn: () => helpers.listUnconfirmedCardPayments({ raw: true }),
        }),
      ).toEqual([]);

      const unconfirmed = await withClockAhead({
        offsetMs: (PLANNED_MATCH_WINDOW_DAYS + 1) * DAY_MS,
        fn: () => helpers.listUnconfirmedCardPayments({ raw: true }),
      });

      expect(unconfirmed).toHaveLength(1);
      expect(unconfirmed[0]).toMatchObject({
        transactionId: logged.body.response.transactionId,
        accountId: account.id,
        amount: 47,
        merchant: MERCHANT,
        card: CARD,
      });
    });

    it('does not list a manual-account payment, which is final at once', async () => {
      const { account, secret } = await setUp();
      await linkCard({ accountId: account.id });
      expect((await send({ secret, body: payment() })).status).toBe(200);

      const unconfirmed = await withClockAhead({
        offsetMs: (PLANNED_MATCH_WINDOW_DAYS + 1) * DAY_MS,
        fn: () => helpers.listUnconfirmedCardPayments({ raw: true }),
      });

      expect(unconfirmed).toEqual([]);
    });
  });
});
