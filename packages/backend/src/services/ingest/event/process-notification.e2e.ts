import { TRANSACTION_TYPES, type NotificationSourceDto, type RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import Transactions from '@models/transactions.model';
import { redisClient } from '@root/redis-client';
import { DOMAIN_EVENTS, eventBus, type IngestPaymentLoggedPayload } from '@services/common/event-bus';
import { RateLimitService } from '@services/common/rate-limit.service';
import { buildLockKey } from '@services/currencies/base-currency-lock';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { getLunchFlowBalanceMock, getLunchFlowTransactionsMock } from '@tests/mocks/lunchflow/mock-api';
import { addHours, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from './constants';
import type { StoredParse } from './stored-parse';

const CARD = 'TBC Visa';
const BASE = global.BASE_CURRENCY_CODE;

const DEFAULT_TIMINGS = { ...notificationTimings };

/** A Wallet notification as the iOS 27 shortcut sends it: the app by display name, the card as the title. */
const wallet = (overrides: Record<string, unknown> = {}) => ({
  kind: 'notification',
  app: 'Wallet',
  title: CARD,
  subtitle: 'Wolt',
  body: `${BASE} 43.60`,
  idempotencyKey: `key-${randomUUID()}`,
  ...overrides,
});

/** A push from a seeded bank app: free text, so the reader has to understand it. */
const push = (overrides: Record<string, unknown> = {}) => ({
  kind: 'notification',
  app: 'TBC Bank',
  title: 'TBC Bank',
  subtitle: '',
  body: `Purchase ${BASE} 43.60, WOLT.COM TBILISI`,
  idempotencyKey: `key-${randomUUID()}`,
  ...overrides,
});

/** What the reader answers for the push above. */
const wolt = (overrides: Record<string, unknown> = {}) => ({
  kind: 'debit' as const,
  amount: '43.60',
  currency: BASE,
  merchant: 'WOLT.COM TBILISI',
  cardName: CARD,
  ...overrides,
});

const send = ({ secret, body }: { secret: string; body: object }) => ingestHelpers.postIngestEvent({ secret, body });

/** A token, and the card linked to a fresh base-currency account. */
const setUp = async () => {
  const account = await helpers.createAccount({ raw: true });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: account.id }, raw: true });

  return { account, secret: (await ingestHelpers.createTestIngestToken()).secret };
};

const storedRequest = async ({ requestId }: { requestId: RecordId }) =>
  (await IngestRequests.findOne({ where: { id: requestId } }))!;

const storedTransaction = async ({ transactionId }: { transactionId: RecordId }) =>
  (await Transactions.findOne({ where: { id: transactionId } }))!;

const readParsed = ({ row }: { row: IngestRequests }) => row.parsed as unknown as StoredParse;

const sourceOf = async ({ app }: { app: string }): Promise<NotificationSourceDto> =>
  (await helpers.listNotificationSources({ raw: true })).find((source) => source.appName === app)!;

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
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

const SEEDED_DATES: Date[] = [];

/** A day with pinned rates, so a payment in a foreign currency has an exact, known value. */
const seedRateDay = async ({ daysAgo, ratesPerUsd }: { daysAgo: number; ratesPerUsd: Record<string, number> }) => {
  const day = subDays(startOfDay(new Date()), daysAgo);
  SEEDED_DATES.push(day);
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { AED: 4, ...ratesPerUsd } });

  return { time: addHours(day, 12).toISOString() };
};

describe('process notification', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    // Long enough for a categorization that has no model to answer under load; a hanging one is not tested here.
    notificationTimings.categorizeWaitMs = 3000;
    notificationTimings.retryBackoffMs = 10;
    await resetLimits();
  });

  afterEach(async () => {
    Object.assign(notificationTimings, DEFAULT_TIMINGS);
    delete process.env.INGEST_AI_DAILY_LIMIT;
    delete process.env.AI_MONTHLY_CAP_USD_TRIAL;
    await helpers.clearExchangeRatesForDates({ dates: SEEDED_DATES.splice(0) });
    await resetLimits();
  });

  describe('a Wallet notification', () => {
    it('is logged from its layout without any AI', async () => {
      const prompts = mockNotificationParsing({ answer: () => ({}) });
      const { account, secret } = await setUp();

      const res = await send({ secret, body: wallet() });

      expect(res.status).toBe(200);
      expect(res.body.response).toMatchObject({
        outcome: 'logged',
        summary: `Logged 43.60 ${BASE} at Wolt → Uncategorized`,
        notify: true,
      });
      expect(prompts).toEqual([]);

      const request = await storedRequest({ requestId: res.body.response.requestId });
      expect(request).toMatchObject({ status: 'logged', reason: null, cardLabel: CARD });
      expect(readParsed({ row: request })).toMatchObject({ parser: 'wallet', kind: 'debit', confidence: 1 });
      expect(request.textEnc).toEqual(expect.any(String));

      const tx = await storedTransaction({ transactionId: request.transactionId! });
      expect(tx).toMatchObject({
        accountId: account.id,
        transactionType: TRANSACTION_TYPES.expense,
        paymentType: 'mobilePayment',
        isPlanned: false,
        note: 'Wolt',
        externalReference: `ios-notification:${request.idempotencyKey}`,
      });
      expect(tx.amount.toNumber()).toBe(43.6);

      const payees = await helpers.listPayees({ raw: true });
      expect(payees.map((payee) => payee.name)).toEqual(['Wolt']);
      expect(tx.payeeId).toBe(payees[0]!.id);
    });

    it('is the same source whether it arrives by bundle id or by display name', async () => {
      const { secret } = await setUp();

      // Three amounts: the same text within seconds would fold into one request.
      await send({ secret, body: wallet({ app: 'Wallet', body: `${BASE} 43.60` }) });
      await send({ secret, body: wallet({ app: 'Кошелёк', body: `${BASE} 44.60` }) });
      await send({ secret, body: wallet({ app: undefined, bundleId: 'com.apple.Passbook', body: `${BASE} 45.60` }) });

      expect(await helpers.listNotificationSources({ raw: true })).toHaveLength(1);
      expect(await helpers.getTransactions({ raw: true })).toHaveLength(3);
    });

    it('logs the payment in the card account of its currency, or the default', async () => {
      await helpers.addUserCurrencies({ currencyCodes: ['GEL'] });
      const { time } = await seedRateDay({ daysAgo: 6, ratesPerUsd: { GEL: 2 } });
      const fallback = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'Default' }),
        raw: true,
      });
      const gel = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'GEL', currencyCode: 'GEL' }),
        raw: true,
      });
      await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: fallback.id }, raw: true });
      await helpers.createCardMapping({
        payload: { cardLabel: CARD, accountId: gel.id, currencyCode: 'GEL' },
        raw: true,
      });
      const { secret } = await ingestHelpers.createTestIngestToken();

      const inGel = await send({ secret, body: wallet({ body: 'GEL 10.00', time }) });
      const inBase = await send({ secret, body: wallet({ body: `${BASE} 10.00`, time }) });

      const gelRequest = await storedRequest({ requestId: inGel.body.response.requestId });
      const baseRequest = await storedRequest({ requestId: inBase.body.response.requestId });
      expect(await storedTransaction({ transactionId: gelRequest.transactionId! })).toMatchObject({
        accountId: gel.id,
        currencyCode: 'GEL',
      });
      expect(await storedTransaction({ transactionId: baseRequest.transactionId! })).toMatchObject({
        accountId: fallback.id,
        currencyCode: BASE,
      });
    });

    it('is planned on a bank-connected account and says the bank sync will confirm it', async () => {
      const account = await connectedAccount();
      await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: account.id }, raw: true });
      const { secret } = await ingestHelpers.createTestIngestToken();

      const res = await send({ secret, body: wallet({ body: `${account.currency} 43.60` }) });

      expect(res.status).toBe(200);
      expect(res.body.response.summary).toMatch(/^Noted 43\.60 [A-Z]{3} at Wolt → .*; the bank sync will confirm it$/);
      const request = await storedRequest({ requestId: res.body.response.requestId });
      expect(await storedTransaction({ transactionId: request.transactionId! })).toMatchObject({ isPlanned: true });
    });

    it('parks on an unknown card without calling the AI, and names a guess for the account', async () => {
      const prompts = mockNotificationParsing({ answer: () => ({}) });
      const account = await helpers.createAccount({ raw: true });
      const { secret } = await ingestHelpers.createTestIngestToken();

      const res = await send({ secret, body: wallet({ title: 'Unlinked Mastercard' }) });

      expect(res.status).toBe(202);
      expect(res.body.response).toMatchObject({
        outcome: 'parked',
        reason: 'unknownAccount',
        summary: `Needs your OK in MoneyMatter: 43.60 ${BASE} at Wolt`,
      });
      expect(prompts).toEqual([]);
      const request = await storedRequest({ requestId: res.body.response.requestId });
      expect(readParsed({ row: request })).toMatchObject({ payment: { merchant: 'Wolt' }, accountGuessId: account.id });
      expect(request.cardLabel).toBe('Unlinked Mastercard');
    });
  });

  describe('a notification read by the AI', () => {
    beforeEach(() => {
      enableServerModel();
    });

    it('logs a debit with the payee the model picked and the payee category', async () => {
      const food = await helpers.addCustomCategory({ name: 'Food', color: '#336699', raw: true });
      const existing = await helpers.createPayee({ payload: { name: 'Wolt', defaultCategoryId: food.id }, raw: true });
      const prompts = mockNotificationParsing({
        answer: () => wolt({ payee: { candidateId: 'p1', newName: null }, confidence: 0.95 }),
      });
      const { account, secret } = await setUp();

      const res = await send({ secret, body: push() });

      expect(res.status).toBe(200);
      expect(res.body.response.summary).toBe(`Logged 43.60 ${BASE} at WOLT.COM TBILISI → Food`);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('p1|Wolt');

      const request = await storedRequest({ requestId: res.body.response.requestId });
      const tx = await storedTransaction({ transactionId: request.transactionId! });
      expect(tx).toMatchObject({
        accountId: account.id,
        payeeId: existing.id,
        categoryId: food.id,
        transactionType: TRANSACTION_TYPES.expense,
      });
      expect(readParsed({ row: request })).toMatchObject({ parser: 'ai', kind: 'debit', confidence: 0.95 });
    });

    it('logs a credit as income', async () => {
      mockNotificationParsing({
        answer: () => ({
          kind: 'credit',
          amount: '1500',
          currency: BASE,
          merchant: 'Salary Co',
          cardName: CARD,
          payee: { candidateId: null, newName: 'Salary Co' },
        }),
      });
      const { secret } = await setUp();

      const res = await send({ secret, body: push({ body: `Salary received ${BASE} 1,500.00 from Salary Co` }) });

      expect(res.body.response.summary).toBe(`Logged 1,500.00 ${BASE} at Salary Co → Uncategorized`);
      const request = await storedRequest({ requestId: res.body.response.requestId });
      const tx = await storedTransaction({ transactionId: request.transactionId! });
      expect(tx.transactionType).toBe(TRANSACTION_TYPES.income);
      expect(tx.amount.toNumber()).toBe(1500);
    });

    it.each(['declined', 'security', 'promo', 'info', 'other'] as const)(
      'ignores a %s notification and wipes its text, keeping only the reading',
      async (kind) => {
        mockNotificationParsing({ answer: () => ({ kind, confidence: 0.9 }) });
        const { secret } = await setUp();

        const res = await send({ secret, body: push({ body: `Notice about ${BASE} 43.60 at Wolt` }) });

        expect(res.status).toBe(200);
        expect(res.body.response).toEqual({
          outcome: 'ignored',
          requestId: expect.any(String),
          reason: kind,
          notify: false,
        });
        const request = await storedRequest({ requestId: res.body.response.requestId });
        expect(request).toMatchObject({ status: 'ignored', reason: kind, textEnc: null, summary: null });
        expect(request.parsed).toEqual({ parser: 'ai', kind, confidence: 0.9 });
        expect(await helpers.getTransactions({ raw: true })).toEqual([]);
      },
    );

    describe('a source that waits for approval', () => {
      const telegram = (overrides: Record<string, unknown> = {}) =>
        push({ app: 'Telegram', title: 'Mum', body: `Send me ${BASE} 43.60 for Wolt`, ...overrides });

      it('parks without calling the AI, logs once approved and deletes what it holds when muted', async () => {
        const prompts = mockNotificationParsing({ answer: () => wolt({ merchant: 'Wolt', cardName: null }) });
        const { account, secret } = await setUp();

        const parked = await send({ secret, body: telegram() });

        expect(parked.status).toBe(202);
        expect(parked.body.response).toMatchObject({ outcome: 'parked', reason: 'sourceNotApproved' });
        expect(parked.body.response.summary).toBe(
          'Not logged yet: approve "Telegram · Mum" as a payment source in MoneyMatter',
        );
        expect(prompts).toEqual([]);
        expect((await storedRequest({ requestId: parked.body.response.requestId })).textEnc).toEqual(
          expect.any(String),
        );

        const source = await sourceOf({ app: 'Telegram' });
        await helpers.updateNotificationSource({
          id: source.id,
          payload: { mode: 'approved', defaultAccountId: account.id },
          raw: true,
        });
        await until(
          async () => (await storedRequest({ requestId: parked.body.response.requestId })).status === 'logged',
          { timeout: 20_000, interval: 100 },
        );

        const request = await storedRequest({ requestId: parked.body.response.requestId });
        expect(prompts).toHaveLength(1);
        expect(await storedTransaction({ transactionId: request.transactionId! })).toMatchObject({
          accountId: account.id,
        });

        // Another sender starts pending too; muting it deletes what it holds.
        const other = await send({ secret, body: telegram({ title: 'Stranger' }) });
        const otherSource = (await helpers.listNotificationSources({ raw: true })).find(
          (item) => item.sender === 'Stranger',
        )!;
        await helpers.updateNotificationSource({ id: otherSource.id, payload: { mode: 'muted' }, raw: true });

        expect(await IngestRequests.findOne({ where: { id: other.body.response.requestId } })).toBeNull();
        expect(prompts).toHaveLength(1);
      });

      it('keeps a request parked when its source was deleted, and never reads or logs its text', async () => {
        const prompts = mockNotificationParsing({ answer: () => wolt({ merchant: 'Wolt', cardName: null }) });
        const { secret } = await setUp();
        const parked = await send({ secret, body: telegram() });
        expect(parked.body.response).toMatchObject({ outcome: 'parked', reason: 'sourceNotApproved' });

        await helpers.deleteNotificationSource({ id: (await sourceOf({ app: 'Telegram' })).id, raw: true });
        expect((await storedRequest({ requestId: parked.body.response.requestId })).sourceId).toBeNull();

        const retried = await helpers.retryCardPaymentRequest({ id: parked.body.response.requestId, raw: true });

        expect(retried).toMatchObject({ outcome: 'parked', reason: 'sourceNotApproved' });
        expect(prompts).toEqual([]);
        expect(await Transactions.count()).toBe(0);
        expect(await storedRequest({ requestId: parked.body.response.requestId })).toMatchObject({
          status: 'parked',
          reason: 'sourceNotApproved',
          transactionId: null,
        });
      });
    });

    describe('when the AI cannot read it', () => {
      it('parks as aiUnavailable without a model, then logs on a retry once one is set up', async () => {
        delete process.env.GEMINI_API_KEY;
        const { secret } = await setUp();

        const parked = await send({ secret, body: push() });

        expect(parked.status).toBe(202);
        expect(parked.body.response).toMatchObject({ outcome: 'parked', reason: 'aiUnavailable', notify: true });
        expect(parked.body.response.summary).toMatch(/^Not logged yet: /);

        enableServerModel();
        mockNotificationParsing({ answer: () => wolt() });
        const retried = await helpers.retryCardPaymentRequest({ id: parked.body.response.requestId, raw: true });

        expect(retried).toMatchObject({ outcome: 'logged' });
        expect((await storedRequest({ requestId: parked.body.response.requestId })).status).toBe('logged');
      });

      it('parks as aiCapReached when the monthly allowance is spent, then logs on a retry', async () => {
        process.env.AI_MONTHLY_CAP_USD_TRIAL = '0';
        const prompts = mockNotificationParsing({ answer: () => wolt() });
        const { secret } = await setUp();

        const parked = await send({ secret, body: push() });

        expect(parked.body.response).toMatchObject({ outcome: 'parked', reason: 'aiCapReached' });
        expect(prompts).toEqual([]);

        delete process.env.AI_MONTHLY_CAP_USD_TRIAL;
        const retried = await helpers.retryCardPaymentRequest({ id: parked.body.response.requestId, raw: true });

        expect(retried).toMatchObject({ outcome: 'logged' });
        expect(prompts).toHaveLength(1);
      });

      it('parks as aiLimitReached when the daily limit is spent, with no call, then logs on a retry', async () => {
        process.env.INGEST_AI_DAILY_LIMIT = '0';
        const prompts = mockNotificationParsing({ answer: () => wolt() });
        const { secret } = await setUp();

        const parked = await send({ secret, body: push() });

        expect(parked.body.response).toMatchObject({ outcome: 'parked', reason: 'aiLimitReached' });
        expect(prompts).toEqual([]);

        delete process.env.INGEST_AI_DAILY_LIMIT;
        const retried = await helpers.retryCardPaymentRequest({ id: parked.body.response.requestId, raw: true });

        expect(retried).toMatchObject({ outcome: 'logged' });
        expect(prompts).toHaveLength(1);
      });
    });

    describe('a payment that needs the owner', () => {
      it.each([
        ['ownTransfer', { isOwnAccountTransfer: true }],
        ['lowConfidence', { confidence: 0.3 }],
      ])('parks as %s, and only a forced retry logs it, without reading it again', async (reason, answer) => {
        const prompts = mockNotificationParsing({ answer: () => wolt(answer) });
        const { secret } = await setUp();

        const parked = await send({ secret, body: push() });

        expect(parked.status).toBe(202);
        expect(parked.body.response).toMatchObject({
          outcome: 'parked',
          reason,
          summary: `Needs your OK in MoneyMatter: 43.60 ${BASE} at WOLT.COM TBILISI`,
        });
        expect(await helpers.getTransactions({ raw: true })).toEqual([]);

        const refused = await helpers.retryCardPaymentRequest({ id: parked.body.response.requestId });
        expect(refused.status).toBe(409);
        expect((refused.body.response as unknown as { details: unknown }).details).toEqual({ reason });
        expect((await storedRequest({ requestId: parked.body.response.requestId })).status).toBe('parked');

        const forced = await helpers.retryCardPaymentRequest({
          id: parked.body.response.requestId,
          payload: { force: true },
          raw: true,
        });

        expect(forced).toMatchObject({ outcome: 'logged' });
        expect(prompts).toHaveLength(1);
        expect(await helpers.getTransactions({ raw: true })).toHaveLength(1);
      });
    });

    describe('when processing fails', () => {
      it('parks as processingFailed after every attempt, and a retry enqueues the next attempt and logs it', async () => {
        notificationTimings.waitBudgetMs = 60_000;
        mockNotificationParsing({ answer: () => 'fail' });
        const { secret } = await setUp();

        const parked = await send({ secret, body: push() });

        expect(parked.status).toBe(202);
        expect(parked.body.response).toMatchObject({ outcome: 'parked', reason: 'processingFailed' });
        expect((await storedRequest({ requestId: parked.body.response.requestId })).attempts).toBe(1);

        mockNotificationParsing({ answer: () => wolt() });
        const retried = await helpers.retryCardPaymentRequest({ id: parked.body.response.requestId, raw: true });

        expect(retried).toMatchObject({ outcome: 'logged' });
        expect((await storedRequest({ requestId: parked.body.response.requestId })).attempts).toBe(2);
      }, 90_000);
    });

    describe('while a base-currency change holds the lock', () => {
      it('leaves a released request received and logs it once the lock is gone', async () => {
        notificationTimings.lockRetryDelayMs = 200;
        mockNotificationParsing({ answer: () => wolt({ merchant: 'Wolt', cardName: null }) });
        const { account, secret } = await setUp();
        const parked = await send({ secret, body: push({ app: 'Telegram', title: 'Mum' }) });
        expect(parked.body.response).toMatchObject({ reason: 'sourceNotApproved' });
        const source = await sourceOf({ app: 'Telegram' });
        const user = await helpers.getUserInfo({ raw: true });

        await redisClient.set(buildLockKey(user.id), 'test-lock');
        try {
          const approved = await helpers.updateNotificationSource({
            id: source.id,
            payload: { mode: 'approved', defaultAccountId: account.id },
          });
          expect(approved.status).toBe(200);

          await new Promise((resolve) => setTimeout(resolve, 900));
          const waiting = await storedRequest({ requestId: parked.body.response.requestId });
          expect(waiting.status).toBe('received');
          expect(waiting.transactionId).toBeNull();
        } finally {
          await redisClient.del(buildLockKey(user.id));
        }

        await until(
          async () => (await storedRequest({ requestId: parked.body.response.requestId })).status === 'logged',
          { timeout: 20_000, interval: 100 },
        );
        expect(await helpers.getTransactions({ raw: true })).toHaveLength(1);
      }, 60_000);
    });

    describe('foreign currency', () => {
      it('keeps the amount the card was charged as the original amount', async () => {
        mockNotificationParsing({
          answer: () => wolt({ originalAmount: '12.00', originalCurrency: 'USD' }),
        });
        await helpers.addUserCurrencies({ currencyCodes: ['USD'] });
        const { secret } = await setUp();

        const res = await send({ secret, body: push() });

        expect(res.status).toBe(200);
        expect(res.body.response.summary).toBe(`Logged 12.00 USD (43.60 ${BASE}) at WOLT.COM TBILISI → Uncategorized`);
        const request = await storedRequest({ requestId: res.body.response.requestId });
        const tx = await storedTransaction({ transactionId: request.transactionId! });
        expect(tx.amount.toNumber()).toBe(43.6);
        expect(tx.originalAmount?.toNumber()).toBe(12);
        expect(tx.originalCurrencyCode).toBe('USD');
      });
    });

    describe('which account the payment goes to', () => {
      it('finds the card by its last digits when the text names no card', async () => {
        mockNotificationParsing({ answer: () => wolt({ cardName: null, cardLastDigits: '4321' }) });
        const account = await helpers.createAccount({ raw: true });
        await helpers.createCardMapping({
          payload: { cardLabel: 'Some Visa', accountId: account.id, lastDigits: '4321' },
          raw: true,
        });
        const secret = (await ingestHelpers.createTestIngestToken()).secret;

        const res = await send({ secret, body: push() });

        expect(res.body.response.outcome).toBe('logged');
        const request = await storedRequest({ requestId: res.body.response.requestId });
        expect(await storedTransaction({ transactionId: request.transactionId! })).toMatchObject({
          accountId: account.id,
        });
      });

      it('parks as unknownAccount with a guess, then logs on the source default without reading again', async () => {
        const prompts = mockNotificationParsing({ answer: () => wolt({ cardName: null }) });
        const account = await helpers.createAccount({ raw: true });
        const secret = (await ingestHelpers.createTestIngestToken()).secret;

        const parked = await send({ secret, body: push() });

        expect(parked.status).toBe(202);
        expect(parked.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownAccount' });
        const stored = await storedRequest({ requestId: parked.body.response.requestId });
        expect(readParsed({ row: stored }).accountGuessId).toBe(account.id);

        const source = await sourceOf({ app: 'TBC Bank' });
        await helpers.updateNotificationSource({ id: source.id, payload: { defaultAccountId: account.id }, raw: true });
        const retried = await helpers.retryCardPaymentRequest({ id: parked.body.response.requestId, raw: true });

        expect(retried).toMatchObject({ outcome: 'logged' });
        expect(prompts).toHaveLength(1);
        const request = await storedRequest({ requestId: parked.body.response.requestId });
        expect(await storedTransaction({ transactionId: request.transactionId! })).toMatchObject({
          accountId: account.id,
        });
      });
    });

    describe('the stated balance', () => {
      const balanceAfter = { amount: '1000.00', currency: 'GEL', scopeHint: 'account' as const };

      const setUpBank = async ({ usdBalance }: { usdBalance: number }) => {
        await helpers.addUserCurrencies({ currencyCodes: ['GEL', 'USD'] });
        const { time } = await seedRateDay({ daysAgo: 6, ratesPerUsd: { GEL: 2 } });
        const gel = await helpers.createAccount({
          payload: helpers.buildAccountPayload({ name: 'GEL', currencyCode: 'GEL', initialBalance: 500 }),
          raw: true,
        });
        const usd = await helpers.createAccount({
          payload: helpers.buildAccountPayload({ name: 'USD', currencyCode: 'USD', initialBalance: usdBalance }),
          raw: true,
        });
        await helpers.createCardMapping({
          payload: { cardLabel: CARD, accountId: gel.id, currencyCode: 'GEL' },
          raw: true,
        });
        await helpers.createCardMapping({
          payload: { cardLabel: CARD, accountId: usd.id, currencyCode: 'USD' },
          raw: true,
        });
        // The default row lets a card without a currency in its text still find the GEL account.
        const secret = (await ingestHelpers.createTestIngestToken()).secret;

        return { secret, time };
      };

      it('is not authoritative when another currency of the same card holds money', async () => {
        mockNotificationParsing({ answer: () => wolt({ currency: 'GEL', balanceAfter }) });
        const { secret, time } = await setUpBank({ usdBalance: 200 });

        const res = await send({ secret, body: push({ time }) });

        expect(res.body.response.outcome).toBe('logged');
        const request = await storedRequest({ requestId: res.body.response.requestId });
        expect(readParsed({ row: request }).balanceAfter).toEqual({
          amount: '1000',
          currency: 'GEL',
          authoritative: false,
          scopeHint: 'account',
        });
      });

      it('is authoritative when the other currencies are empty', async () => {
        mockNotificationParsing({ answer: () => wolt({ currency: 'GEL', balanceAfter }) });
        const { secret, time } = await setUpBank({ usdBalance: 0 });

        const res = await send({ secret, body: push({ time }) });

        const request = await storedRequest({ requestId: res.body.response.requestId });
        expect(readParsed({ row: request }).balanceAfter).toMatchObject({ authoritative: true });
      });

      it('names the currencies held at the bank in the prompt', async () => {
        const prompts = mockNotificationParsing({ answer: () => wolt({ currency: 'GEL' }) });
        const { secret, time } = await setUpBank({ usdBalance: 200 });
        const first = await send({ secret, body: push({ time }) });
        expect(first.body.response.outcome).toBe('logged');

        await send({ secret, body: push({ time, body: `Purchase GEL 5.00, WOLT.COM TBILISI` }) });

        // The first payment taught the source which accounts belong to it.
        expect(prompts[1]).toMatch(/The user holds money at this bank in: (GEL, USD|USD, GEL)\./);
      });
    });
  });

  describe('confirm in the inbox', () => {
    it('writes a notification payment and a tap at once, both unconfirmed and listed, one event each', async () => {
      const events: IngestPaymentLoggedPayload[] = [];
      const listener = (payload: IngestPaymentLoggedPayload) => events.push(payload);
      eventBus.on(DOMAIN_EVENTS.INGEST_PAYMENT_LOGGED, listener);

      try {
        const { account, secret } = await setUp();

        const notification = await send({ secret, body: wallet() });
        const tap = await ingestHelpers.postCardPayment({
          secret,
          body: {
            amount: '12.00',
            merchant: 'Coffee Lab',
            card: CARD,
            source: 'apple-pay',
            idempotencyKey: `key-${randomUUID()}`,
          },
        });

        expect(notification.body.response.outcome).toBe('logged');
        expect(tap.body.response.outcome).toBe('logged');

        const notificationRequest = await storedRequest({ requestId: notification.body.response.requestId });
        const notificationTx = await storedTransaction({ transactionId: notificationRequest.transactionId! });
        const tapTx = await storedTransaction({ transactionId: tap.body.response.transactionId });

        for (const [tx, pipeline] of [
          [notificationTx, 'notification'],
          [tapTx, 'cardPayment'],
        ] as const) {
          expect(tx.externalData.ingest).toMatchObject({ unconfirmed: true, pipeline, systemNote: expect.any(String) });
          expect(tx.externalData.cardPayment).toBeDefined();
        }

        const listed = await helpers.listUnconfirmedCardPayments({ raw: true });
        expect(listed.map((item) => item.transactionId).toSorted()).toEqual([notificationTx.id, tapTx.id].toSorted());
        expect(listed.every((item) => item.awaitingConfirmation && !item.bankUnconfirmed)).toBe(true);

        // The inbox posts one confirm card per transaction from this event.
        expect(events.toSorted((a, b) => a.pipeline.localeCompare(b.pipeline))).toEqual([
          {
            userId: expect.any(Number),
            accountId: account.id,
            transactionId: tapTx.id,
            requestId: expect.any(String),
            pipeline: 'cardPayment',
          },
          {
            userId: expect.any(Number),
            accountId: account.id,
            transactionId: notificationTx.id,
            requestId: notificationRequest.id,
            pipeline: 'notification',
          },
        ]);
      } finally {
        eventBus.off(DOMAIN_EVENTS.INGEST_PAYMENT_LOGGED, listener);
      }
    });

    it('lists nothing for a payment that parked, and nothing for a user who never sent one', async () => {
      expect(await helpers.listUnconfirmedCardPayments({ raw: true })).toEqual([]);

      const secret = (await ingestHelpers.createTestIngestToken()).secret;
      await send({ secret, body: wallet({ title: 'Unlinked Mastercard' }) });

      expect(await helpers.listUnconfirmedCardPayments({ raw: true })).toEqual([]);
    });
  });
});
