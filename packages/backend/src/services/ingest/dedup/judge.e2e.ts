import type { RecordId } from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import DuplicateSuggestions from '@models/duplicate-suggestions.model';
import IngestRequests from '@models/ingest-requests.model';
import Transactions from '@models/transactions.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { addMinutes, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from '../event/constants';
import { woltOnlinePayment } from '../event/fixtures/notifications';

const CARD = woltOnlinePayment.tap.card;
const DEFAULT_TIMINGS = { ...notificationTimings };
const SEEDED_DATES: Date[] = [];
const ORIGINAL_DAILY_LIMIT = process.env.INGEST_AI_DAILY_LIMIT;

const seedRateDay = async () => {
  const day = subDays(startOfDay(new Date()), 6);
  SEEDED_DATES.push(day);
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { GEL: 2 } });

  return addMinutes(day, 14 * 60 + 38);
};

const timeOf = ({ noon, seconds }: { noon: Date; seconds: number }) =>
  new Date(noon.getTime() + seconds * 1000).toISOString();

/** The owner's GEL card account, linked to the card, and a second GEL account the card does not own. */
const setUp = async () => {
  await helpers.addUserCurrencies({ currencyCodes: ['GEL'] });
  const noon = await seedRateDay();
  const gel = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ name: 'TBC GEL', currencyCode: 'GEL', initialBalance: 1000 }),
    raw: true,
  });
  const other = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ name: 'Cash GEL', currencyCode: 'GEL', initialBalance: 1000 }),
    raw: true,
  });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: gel.id }, raw: true });

  return { gel, other, noon, secret: (await ingestHelpers.createTestIngestToken()).secret };
};

const manualRow = ({ accountId, amount, time }: { accountId: RecordId; amount: number; time: string }) =>
  helpers.createTransaction({
    payload: helpers.buildTransactionPayload({ accountId, amount, time }),
    raw: true,
  });

const walletPayment = ({ secret, noon, seconds = 0 }: { secret: string; noon: Date; seconds?: number }) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: woltOnlinePayment.wallet.appName,
      title: woltOnlinePayment.wallet.title,
      subtitle: woltOnlinePayment.wallet.subtitle,
      body: woltOnlinePayment.wallet.body,
      time: timeOf({ noon, seconds }),
      idempotencyKey: `wallet-${randomUUID()}`,
    },
  });

const tapPayment = ({ secret, noon, seconds }: { secret: string; noon: Date; seconds: number }) =>
  ingestHelpers.postCardPayment({
    secret,
    body: {
      ...woltOnlinePayment.tap,
      source: 'apple-pay',
      time: timeOf({ noon, seconds }),
      idempotencyKey: `tap-${randomUUID()}`,
    },
  });

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

const allRows = () => Transactions.findAll({ order: [['createdAt', 'ASC']] });

describe('the AI duplicate judge', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    enableServerModel();
    notificationTimings.categorizeWaitMs = 50;
    await resetLimits();
  });

  afterEach(async () => {
    Object.assign(notificationTimings, DEFAULT_TIMINGS);
    if (ORIGINAL_DAILY_LIMIT === undefined) delete process.env.INGEST_AI_DAILY_LIMIT;
    else process.env.INGEST_AI_DAILY_LIMIT = ORIGINAL_DAILY_LIMIT;
    await helpers.clearExchangeRatesForDates({ dates: SEEDED_DATES.splice(0) });
    await resetLimits();
  });

  describe('a match at 0.6 or more', () => {
    it('logs a new row and raises an open suggestion, merging nothing', async () => {
      const judgePrompts: string[] = [];
      mockNotificationParsing({
        answer: () => ({}),
        judgePrompts,
        judge: () => ({ matches: [{ id: 'c1', confidence: 0.95, reason: 'Same shop and amount a minute apart.' }] }),
      });
      const { gel, noon, secret } = await setUp();
      const [typed] = await manualRow({ accountId: gel.id, amount: 29.41, time: timeOf({ noon, seconds: -60 }) });

      const res = await walletPayment({ secret, noon });

      // The tier-1 rules do not absorb a hand-typed row, and the judge only suggests.
      expect(res.body.response.outcome).toBe('logged');
      const rows = await allRows();
      expect(rows).toHaveLength(2);
      const logged = rows.find((row) => row.id !== typed!.id)!;

      expect(judgePrompts).toHaveLength(1);
      expect(judgePrompts[0]).toContain('DUPLICATE JUDGE');
      expect(judgePrompts[0]).toContain('c1 | 29.41 GEL');
      expect(judgePrompts[0]).toContain('manual or synced');
      expect(judgePrompts[0]).not.toContain(typed!.id);

      const suggestions = await helpers.listDuplicateSuggestions({ raw: true });
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toMatchObject({
        accountId: gel.id,
        confidence: 0.95,
        reason: 'Same shop and amount a minute apart.',
        trigger: 'ingest',
      });

      const sides = [suggestions[0]!.transaction.id, suggestions[0]!.candidate.id];
      expect(sides.toSorted()).toEqual([typed!.id, logged.id].toSorted());
      // The smaller id is stored first, so one pair is one row whichever side was judged.
      expect(sides).toEqual(sides.toSorted());
      expect(suggestions[0]!.transactionSlots.concat(suggestions[0]!.candidateSlots)).toEqual(['wallet-notification']);

      expect((await helpers.getAccount({ id: gel.id, raw: true })).currentBalance).toBeCloseTo(1000 - 29.41 - 29.41, 2);
    });

    it('also counts a match at exactly 0.6', async () => {
      mockNotificationParsing({
        answer: () => ({}),
        judge: () => ({ matches: [{ id: 'c1', confidence: 0.6, reason: null }] }),
      });
      const { gel, noon, secret } = await setUp();
      await manualRow({ accountId: gel.id, amount: 29.41, time: timeOf({ noon, seconds: -60 }) });

      await walletPayment({ secret, noon });

      const suggestions = await helpers.listDuplicateSuggestions({ raw: true });
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toMatchObject({ confidence: 0.6, reason: null });
    });

    it('raises a suggestion for a double fire held back past the tap fold window', async () => {
      mockNotificationParsing({
        answer: () => ({}),
        judge: () => ({ matches: [{ id: 'c1', confidence: 0.9, reason: 'Two runs of one payment.' }] }),
      });
      const { noon, secret } = await setUp();

      await tapPayment({ secret, noon, seconds: 0 });
      const second = await tapPayment({ secret, noon, seconds: 25 });

      expect(second.body.response.duplicate).toBeUndefined();
      expect(await allRows()).toHaveLength(2);
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toHaveLength(1);
    });
  });

  describe('a weaker match', () => {
    it('raises nothing at 0.3', async () => {
      const judgePrompts: string[] = [];
      mockNotificationParsing({
        answer: () => ({}),
        judgePrompts,
        judge: () => ({ matches: [{ id: 'c1', confidence: 0.3, reason: 'Probably another purchase.' }] }),
      });
      const { gel, noon, secret } = await setUp();
      await manualRow({ accountId: gel.id, amount: 29.41, time: timeOf({ noon, seconds: -60 }) });

      const res = await walletPayment({ secret, noon });

      expect(res.body.response.outcome).toBe('logged');
      expect(judgePrompts).toHaveLength(1);
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
    });

    it('raises nothing when the judge names no candidate or one it was never shown', async () => {
      mockNotificationParsing({
        answer: () => ({}),
        judge: () => ({ matches: [{ id: 'c9', confidence: 0.99, reason: 'invented' }] }),
      });
      const { gel, noon, secret } = await setUp();
      await manualRow({ accountId: gel.id, amount: 29.41, time: timeOf({ noon, seconds: -60 }) });

      await walletPayment({ secret, noon });

      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
    });
  });

  describe('the candidates', () => {
    it('leave out rows of another account', async () => {
      const judgePrompts: string[] = [];
      mockNotificationParsing({
        answer: () => ({}),
        judgePrompts,
        judge: () => ({ matches: [{ id: 'c1', confidence: 0.95, reason: null }] }),
      });
      const { other, noon, secret } = await setUp();
      await manualRow({ accountId: other.id, amount: 29.41, time: timeOf({ noon, seconds: -60 }) });

      const res = await walletPayment({ secret, noon });

      expect(res.body.response.outcome).toBe('logged');
      expect(judgePrompts).toEqual([]);
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
    });

    it('leave out rows that hold the same slot: two coffees through one channel are two payments', async () => {
      const judgePrompts: string[] = [];
      mockNotificationParsing({
        answer: () => ({}),
        judgePrompts,
        judge: () => ({ matches: [{ id: 'c1', confidence: 0.95, reason: null }] }),
      });
      const { noon, secret } = await setUp();

      await tapPayment({ secret, noon, seconds: 0 });
      await tapPayment({ secret, noon, seconds: 120 });

      expect(await allRows()).toHaveLength(2);
      expect(judgePrompts).toEqual([]);
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
    });

    it('leave out rows of another amount and rows outside the window', async () => {
      const judgePrompts: string[] = [];
      mockNotificationParsing({
        answer: () => ({}),
        judgePrompts,
        judge: () => ({ matches: [{ id: 'c1', confidence: 0.95, reason: null }] }),
      });
      const { gel, noon, secret } = await setUp();
      await manualRow({ accountId: gel.id, amount: 80, time: timeOf({ noon, seconds: -60 }) });
      await manualRow({ accountId: gel.id, amount: 29.41, time: timeOf({ noon, seconds: -73 * 3600 }) });

      await walletPayment({ secret, noon });

      expect(judgePrompts).toEqual([]);
    });

    it('leave out rows of the other direction', async () => {
      const judgePrompts: string[] = [];
      mockNotificationParsing({
        answer: () => ({}),
        judgePrompts,
        judge: () => ({ matches: [{ id: 'c1', confidence: 0.95, reason: null }] }),
      });
      const { gel, noon, secret } = await setUp();
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: gel.id,
          amount: 29.41,
          time: timeOf({ noon, seconds: -60 }),
          transactionType: 'income' as never,
        }),
        raw: true,
      });

      await walletPayment({ secret, noon });

      expect(judgePrompts).toEqual([]);
    });
  });

  describe('when the judge cannot answer', () => {
    it('leaves the logged row in place when the call fails', async () => {
      const judgePrompts: string[] = [];
      mockNotificationParsing({ answer: () => ({}), judgePrompts, judge: () => 'fail' });
      const { gel, noon, secret } = await setUp();
      await manualRow({ accountId: gel.id, amount: 29.41, time: timeOf({ noon, seconds: -60 }) });

      const res = await walletPayment({ secret, noon });

      expect(res.status).toBe(200);
      expect(res.body.response.outcome).toBe('logged');
      expect(judgePrompts.length).toBeGreaterThan(0);
      expect(await allRows()).toHaveLength(2);
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);

      const request = (await IngestRequests.findOne({ order: [['createdAt', 'DESC']] }))!;
      expect(request.status).toBe('logged');
      expect(request.transactionId).toEqual(expect.any(String));
      expect(await DuplicateSuggestions.count()).toBe(0);
    });

    it('raises nothing when the model answers nothing usable', async () => {
      mockNotificationParsing({ answer: () => ({}) });
      const { gel, noon, secret } = await setUp();
      await manualRow({ accountId: gel.id, amount: 29.41, time: timeOf({ noon, seconds: -60 }) });

      const res = await walletPayment({ secret, noon });

      expect(res.body.response.outcome).toBe('logged');
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
    });

    it('asks no one once the daily AI limit is spent', async () => {
      const judgePrompts: string[] = [];
      mockNotificationParsing({
        answer: () => ({}),
        judgePrompts,
        judge: () => ({ matches: [{ id: 'c1', confidence: 0.95, reason: null }] }),
      });
      process.env.INGEST_AI_DAILY_LIMIT = '0';
      const { gel, noon, secret } = await setUp();
      await manualRow({ accountId: gel.id, amount: 29.41, time: timeOf({ noon, seconds: -60 }) });

      const res = await walletPayment({ secret, noon });

      expect(res.body.response.outcome).toBe('logged');
      expect(judgePrompts).toEqual([]);
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
    });

    it('asks no one without an AI connection', async () => {
      delete process.env.GEMINI_API_KEY;
      const judgePrompts: string[] = [];
      mockNotificationParsing({
        answer: () => ({}),
        judgePrompts,
        judge: () => ({ matches: [{ id: 'c1', confidence: 0.95, reason: null }] }),
      });
      const { gel, noon, secret } = await setUp();
      await manualRow({ accountId: gel.id, amount: 29.41, time: timeOf({ noon, seconds: -60 }) });

      const res = await walletPayment({ secret, noon });

      expect(res.body.response.outcome).toBe('logged');
      expect(judgePrompts).toEqual([]);
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
    });
  });

  describe('GET /transactions/reconciliation/suggestions', () => {
    it('is empty for a new user', async () => {
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
    });

    it('lists only the open suggestions of the signed-in user', async () => {
      mockNotificationParsing({
        answer: () => ({}),
        judge: () => ({ matches: [{ id: 'c1', confidence: 0.95, reason: null }] }),
      });
      const { gel, noon, secret } = await setUp();
      await manualRow({ accountId: gel.id, amount: 29.41, time: timeOf({ noon, seconds: -60 }) });
      await walletPayment({ secret, noon });

      const [suggestion] = await DuplicateSuggestions.findAll();
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toHaveLength(1);

      await suggestion!.update({ status: 'dismissed' });
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
    });
  });
});
