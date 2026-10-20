import {
  BANK_PROVIDER_TYPE,
  type ExternalMonobankTransactionResponse,
  type RecordId,
  type StatementImportSummary,
} from '@bt/shared/types';
import { until } from '@common/helpers';
import { NONEXISTENT_ID } from '@common/lib/record-id-helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import DuplicateSuggestions from '@models/duplicate-suggestions.model';
import Transactions from '@models/transactions.model';
import { DOMAIN_EVENTS, eventBus } from '@services/common/event-bus';
import { RateLimitService } from '@services/common/rate-limit.service';
import { notificationTimings } from '@services/ingest/event/constants';
import { woltOnlinePayment } from '@services/ingest/event/fixtures/notifications';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { getMonobankTransactionsMock } from '@tests/mocks/monobank/mock-api';
import { addHours, addMinutes, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

const CARD = woltOnlinePayment.tap.card;
const DEFAULT_TIMINGS = { ...notificationTimings };
const SEEDED_DATES: Date[] = [];

const JUDGED = {
  judge: () => ({ matches: [{ id: 'c1', confidence: 0.95, reason: 'Same shop and amount, a minute apart.' }] }),
};

const seedRateDay = async ({ daysBack }: { daysBack: number }) => {
  const day = subDays(startOfDay(new Date()), daysBack);
  SEEDED_DATES.push(day);
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { AED: 4, EUR: 2, GEL: 2, UAH: 8 } });

  return day;
};

const timeOf = ({ noon, seconds }: { noon: Date; seconds: number }) =>
  new Date(noon.getTime() + seconds * 1000).toISOString();

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

const readSuggestions = () => DuplicateSuggestions.findAll({ order: [['createdAt', 'ASC']] });

const waitForOpenSuggestions = async ({ count }: { count: number }) => {
  await until(async () => (await helpers.listDuplicateSuggestions({ raw: true })).length >= count, {
    timeout: 20_000,
    interval: 250,
  });

  return helpers.listDuplicateSuggestions({ raw: true });
};

const syncAccount = async ({
  connectionId,
  accountId,
  transactions,
}: {
  connectionId: string;
  accountId: RecordId;
  transactions: ExternalMonobankTransactionResponse[];
}) => {
  global.mswMockServer.use(getMonobankTransactionsMock({ response: transactions }));
  const { jobGroupId } = await helpers.bankDataProviders.syncTransactionsForAccount({
    connectionId,
    accountId,
    raw: true,
  });
  const result = await helpers.bankDataProviders.waitForSyncJobsToComplete({
    connectionId,
    jobGroupId: jobGroupId!,
    timeoutMs: 20000,
  });
  expect(result.status).toBe('completed');
};

const listAccountTransactions = ({ accountId }: { accountId: RecordId }) =>
  helpers.getTransactions({ accountIds: [accountId], raw: true });

const booking = ({ cents, counterName }: { cents: number; counterName: string }) =>
  helpers.monobank.buildTransaction({
    amount: -cents,
    time: addHours(subDays(startOfDay(new Date()), 1), 12),
    counterName,
    description: '',
  });

describe('Duplicate suggestions', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    enableServerModel();
    notificationTimings.categorizeWaitMs = 50;
    await resetLimits();
  });

  afterEach(async () => {
    Object.assign(notificationTimings, DEFAULT_TIMINGS);
    await helpers.clearExchangeRatesForDates({ dates: SEEDED_DATES.splice(0) });
    await resetLimits();
  });

  describe('on a manual account', () => {
    /** A GEL account linked to the card, a hand-typed row and a Wallet payment the judge calls its duplicate. */
    const raiseSuggestion = async () => {
      mockNotificationParsing({ answer: () => ({}), ...JUDGED });
      await helpers.addUserCurrencies({ currencyCodes: ['GEL'] });
      const day = await seedRateDay({ daysBack: 6 });
      const noon = addMinutes(day, 14 * 60 + 38);
      const gel = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'TBC GEL', currencyCode: 'GEL', initialBalance: 1000 }),
        raw: true,
      });
      await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: gel.id }, raw: true });
      const { secret } = await ingestHelpers.createTestIngestToken();

      const [typed] = await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: gel.id,
          amount: 29.41,
          time: timeOf({ noon, seconds: -60 }),
        }),
        raw: true,
      });
      const res = await ingestHelpers.postIngestEvent({
        secret,
        body: {
          kind: 'notification',
          app: woltOnlinePayment.wallet.appName,
          title: woltOnlinePayment.wallet.title,
          subtitle: woltOnlinePayment.wallet.subtitle,
          body: woltOnlinePayment.wallet.body,
          time: timeOf({ noon, seconds: 0 }),
          idempotencyKey: `wallet-${randomUUID()}`,
        },
      });
      expect(res.body.response.outcome).toBe('logged');

      const [suggestion] = await helpers.listDuplicateSuggestions({ raw: true });
      expect(suggestion).toBeDefined();
      const ingestId = suggestion!.transaction.id === typed!.id ? suggestion!.candidate.id : suggestion!.transaction.id;

      return {
        gel,
        noon,
        secret,
        typedId: typed!.id as RecordId,
        ingestId: ingestId as RecordId,
        suggestion: suggestion!,
      };
    };

    describe('dismiss', () => {
      it('keeps the pair as dismissed, off the list, and counts nothing against the books', async () => {
        const { gel, suggestion } = await raiseSuggestion();

        const res = await helpers.dismissDuplicateSuggestion({ id: suggestion.id });

        expect(res.statusCode).toBe(200);
        expect(res.body.response).toEqual({ id: suggestion.id, status: 'dismissed' });
        expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);

        const [stored] = await readSuggestions();
        expect(stored).toMatchObject({ id: suggestion.id, status: 'dismissed' });
        expect(stored!.resolvedAt).toBeInstanceOf(Date);
        // Both rows are still on the books and the balance is untouched.
        expect(await Transactions.count()).toBe(2);
        expect((await helpers.getAccount({ id: gel.id, raw: true })).currentBalance).toBeCloseTo(1000 - 29.41 * 2, 2);
      });

      it('is harmless a second time', async () => {
        const { suggestion } = await raiseSuggestion();
        await helpers.dismissDuplicateSuggestion({ id: suggestion.id });

        const again = await helpers.dismissDuplicateSuggestion({ id: suggestion.id });

        expect(again.statusCode).toBe(200);
        expect(again.body.response).toEqual({ id: suggestion.id, status: 'dismissed' });
      });

      it('never lets a rescan raise the dismissed pair again', async () => {
        const { gel, ingestId, suggestion } = await raiseSuggestion();
        await helpers.dismissDuplicateSuggestion({ id: suggestion.id });

        // The scan that follows a sync reads the same two rows; the stored verdict keeps the pair out.
        const { userId } = (await Transactions.findByPk(ingestId))!;
        eventBus.emit(DOMAIN_EVENTS.TRANSACTIONS_SYNCED, {
          userId,
          accountId: gel.id,
          transactionIds: [ingestId, suggestion.transaction.id, suggestion.candidate.id],
        });
        await helpers.sleep(1500);

        expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
        expect(await readSuggestions()).toHaveLength(1);
      });

      it('answers 404 for a suggestion that does not exist', async () => {
        const res = await helpers.dismissDuplicateSuggestion({ id: NONEXISTENT_ID });

        expect(res.statusCode).toBe(ERROR_CODES.NotFoundError);
      });

      it('answers 409 for a suggestion that was already merged', async () => {
        const { typedId, ingestId, suggestion } = await raiseSuggestion();
        await helpers.reconciliationMerge({ transactionIds: [typedId, ingestId], survivorId: typedId, raw: true });

        const res = await helpers.dismissDuplicateSuggestion({ id: suggestion.id });

        expect(res.statusCode).toBe(ERROR_CODES.ConflictError);
        expect((await readSuggestions())[0]!.status).toBe('merged');
      });
    });

    describe('lifecycle', () => {
      it('marks the pair merged when the owner merges the two rows', async () => {
        const { typedId, ingestId } = await raiseSuggestion();

        await helpers.reconciliationMerge({ transactionIds: [typedId, ingestId], survivorId: typedId, raw: true });

        expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
        const [stored] = await readSuggestions();
        expect(stored).toMatchObject({ status: 'merged' });
        expect(stored!.resolvedAt).toBeInstanceOf(Date);
        // The merged pair keeps both ids: the rows are soft-deleted, not hard-deleted.
        expect(stored!.transactionId).not.toBeNull();
        expect(stored!.candidateId).not.toBeNull();
      });

      it('marks the suggestion stale when one of its rows is removed in Reconciliation', async () => {
        const { ingestId } = await raiseSuggestion();

        await helpers.reconciliationRemove({ transactionIds: [ingestId], raw: true });

        expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
        expect((await readSuggestions())[0]).toMatchObject({ status: 'stale' });
      });

      it('marks the suggestion stale and keeps its row when a transaction is deleted', async () => {
        const { typedId, ingestId } = await raiseSuggestion();

        const res = await helpers.deleteTransaction({ id: typedId });
        expect(res.statusCode).toBe(200);

        expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
        const stored = await readSuggestions();
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ status: 'stale' });
        // The foreign key nulled the deleted side and kept the other.
        expect([stored[0]!.transactionId, stored[0]!.candidateId].filter(Boolean)).toEqual([ingestId]);
        expect(stored[0]!.resolvedAt).toBeInstanceOf(Date);
      });

      it('marks the suggestion stale when a bulk delete takes one of its rows', async () => {
        const { typedId } = await raiseSuggestion();

        const res = await helpers.bulkDeleteTransactions({ payload: { transactionIds: [typedId] } });
        expect(res.statusCode).toBe(200);

        expect((await readSuggestions())[0]).toMatchObject({ status: 'stale' });
      });

      it('leaves a suggestion open when an unrelated transaction is deleted', async () => {
        const { gel } = await raiseSuggestion();
        const [other] = await helpers.createTransaction({
          payload: helpers.buildTransactionPayload({ accountId: gel.id, amount: 5 }),
          raw: true,
        });

        await helpers.deleteTransaction({ id: other!.id });

        expect(await helpers.listDuplicateSuggestions({ raw: true })).toHaveLength(1);
        expect((await readSuggestions())[0]).toMatchObject({ status: 'open' });
      });
    });

    describe('the judge at ingest', () => {
      it('raises a suggestion for two ingest rows and merges nothing', async () => {
        mockNotificationParsing({ answer: () => ({}), ...JUDGED });
        await helpers.addUserCurrencies({ currencyCodes: ['GEL'] });
        const noon = addMinutes(await seedRateDay({ daysBack: 6 }), 14 * 60 + 38);
        const gel = await helpers.createAccount({
          payload: helpers.buildAccountPayload({ name: 'TBC GEL', currencyCode: 'GEL', initialBalance: 1000 }),
          raw: true,
        });
        await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: gel.id }, raw: true });
        const { secret } = await ingestHelpers.createTestIngestToken();
        const tap = ({ seconds }: { seconds: number }) =>
          ingestHelpers.postCardPayment({
            secret,
            body: {
              ...woltOnlinePayment.tap,
              source: 'apple-pay',
              time: timeOf({ noon, seconds }),
              idempotencyKey: `tap-${randomUUID()}`,
            },
          });

        await tap({ seconds: 0 });
        // Past the tap fold window: a second run of the same payment lands as its own row.
        await tap({ seconds: 25 });

        const rows = await Transactions.findAll({ paranoid: false });
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.deletedAt === null && row.mergedIntoId === null)).toBe(true);

        const suggestions = await helpers.listDuplicateSuggestions({ raw: true });
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0]).toMatchObject({ trigger: 'ingest', confidence: 0.95 });
      });
    });
  });

  describe('the scan after a statement import', () => {
    it('raises a suggestion for an imported row next to an ingest row, and merges nothing', async () => {
      const judgePrompts: string[] = [];
      mockNotificationParsing({ answer: () => ({}), judgePrompts, ...JUDGED });
      await helpers.addUserCurrencies({ currencyCodes: ['GEL'] });
      const noon = addMinutes(await seedRateDay({ daysBack: 6 }), 14 * 60 + 38);
      const gel = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'TBC GEL', currencyCode: 'GEL', initialBalance: 1000 }),
        raw: true,
      });
      await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: gel.id }, raw: true });
      const { secret } = await ingestHelpers.createTestIngestToken();

      const logged = await ingestHelpers.postCardPayment({
        secret,
        body: {
          ...woltOnlinePayment.tap,
          source: 'apple-pay',
          time: timeOf({ noon, seconds: 0 }),
          idempotencyKey: `tap-${randomUUID()}`,
        },
      });
      expect(logged.body.response.outcome).toBe('logged');
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);

      const summary: StatementImportSummary = await helpers.statementExecuteImportAndWait({
        payload: {
          accountId: gel.id,
          transactions: [
            {
              date: `${timeOf({ noon, seconds: 120 }).slice(0, 10)} ${timeOf({ noon, seconds: 120 }).slice(11, 19)}`,
              description: 'WOLT TBILISI',
              amount: 29.5,
              type: 'expense',
            },
          ],
          skipIndices: [],
          timezone: 'UTC',
        },
      });
      expect(summary.imported).toBe(1);

      const [suggestion] = await waitForOpenSuggestions({ count: 1 });
      expect(suggestion).toMatchObject({ trigger: 'scan', confidence: 0.95, accountId: gel.id });
      expect(suggestion!.suggestedSurvivorId).toBe(summary.newTransactionIds[0]);
      expect(judgePrompts.at(-1)).toContain('DUPLICATE JUDGE');
      expect(await Transactions.count()).toBe(2);
    });

    it('asks nothing when the account holds no ingest row', async () => {
      const judgePrompts: string[] = [];
      mockNotificationParsing({ answer: () => ({}), judgePrompts, ...JUDGED });
      const gel = await helpers.createAccount({ raw: true });
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({ accountId: gel.id, amount: 29.41 }),
        raw: true,
      });

      const summary = await helpers.statementExecuteImportAndWait({
        payload: {
          accountId: gel.id,
          transactions: [
            {
              date: new Date().toISOString().slice(0, 10) + ' 10:00:00',
              description: 'SHOP',
              amount: 29.5,
              type: 'expense',
            },
          ],
          skipIndices: [],
          timezone: 'UTC',
        },
      });
      expect(summary.imported).toBe(1);
      await helpers.sleep(1500);

      expect(judgePrompts).toHaveLength(0);
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
    });
  });

  describe('the scan after a bank sync', () => {
    const SYNC_CARD = 'TBC Visa';

    /** A bank account holding one real row (a sync into an empty one is an initial pull), linked to the card. */
    const bankAccountWithPlan = async () => {
      for (let daysBack = 0; daysBack <= 12; daysBack += 1) await seedRateDay({ daysBack });
      const { account } = await helpers.monobank.mockTransactions({
        transactions: [{ amount: -1234, time: subDays(startOfDay(new Date()), 10), description: 'ANCHOR CHARGE' }],
      });
      const { connections } = await helpers.bankDataProviders.listUserConnections({ raw: true });
      const connectionId = connections.find(
        (connection) => connection.providerType === BANK_PROVIDER_TYPE.MONOBANK,
      )!.id;
      let seeded = await listAccountTransactions({ accountId: account.id });
      for (let attempt = 0; attempt < 10 && seeded.length === 0; attempt += 1) {
        await helpers.sleep(300);
        seeded = await listAccountTransactions({ accountId: account.id });
      }
      expect(seeded).toHaveLength(1);

      await helpers.createCardMapping({ payload: { cardLabel: SYNC_CARD, accountId: account.id }, raw: true });
      const { secret } = await ingestHelpers.createTestIngestToken();
      const plan = await ingestHelpers.postCardPayment({
        secret,
        body: {
          amount: '47.00',
          merchant: 'Cafe Heart of Batumi',
          card: SYNC_CARD,
          source: 'apple-pay',
          idempotencyKey: `key-${randomUUID()}`,
        },
      });
      expect(plan.body.response).toMatchObject({ outcome: 'logged', planned: true });

      return { connectionId, accountId: account.id, planId: plan.body.response.transactionId as RecordId };
    };

    it('raises a suggestion for a synced row next to an unsettled ingest plan, and merges nothing', async () => {
      mockNotificationParsing({ answer: () => ({}), ...JUDGED });
      const { connectionId, accountId, planId } = await bankAccountWithPlan();

      // Another shop at a near amount: the plan does not settle, so both rows stay.
      await syncAccount({
        connectionId,
        accountId,
        transactions: [booking({ cents: 5200, counterName: 'SPAR BATUMI' })],
      });

      const [suggestion] = await waitForOpenSuggestions({ count: 1 });
      expect(suggestion).toMatchObject({ trigger: 'scan', confidence: 0.95, accountId });
      const sides = [suggestion!.transaction.id, suggestion!.candidate.id];
      expect(sides).toContain(planId);

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === planId)).toMatchObject({ isPlanned: true });
    }, 90000);

    it('does not ask the judge about a synced row when no ingest row is near', async () => {
      const judgePrompts: string[] = [];
      mockNotificationParsing({ answer: () => ({}), judgePrompts, ...JUDGED });
      const { connectionId, accountId } = await bankAccountWithPlan();

      // 3 000.00 is far from the 47.00 plan, so nothing qualifies as a candidate.
      await syncAccount({
        connectionId,
        accountId,
        transactions: [booking({ cents: 300000, counterName: 'SPAR BATUMI' })],
      });
      await helpers.sleep(1500);

      expect(judgePrompts).toHaveLength(0);
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
    }, 90000);
  });

  describe('the empty state', () => {
    it('lists nothing for a user without suggestions', async () => {
      expect(await helpers.listDuplicateSuggestions({ raw: true })).toEqual([]);
    });
  });
});
