import { TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES } from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Transactions from '@models/transactions.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing, useAiOnlyNotificationParsing } from '@tests/helpers/notification-ai';
import { addMinutes, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from '../event/constants';

const CARD = 'TBC CARD';
const DEFAULT_TIMINGS = { ...notificationTimings };
const SEEDED_DATES: Date[] = [];

/** The owner's two TBC pushes of 2026-10-20 (a USD transfer to FXHUB, the GEL deposit 6 minutes later). */
const TRANSFER_OUT = 'Money Transfer: 300.00 USD\nTBC CARD\n20/10/2026';
const DEPOSIT_IN = 'Deposit Money: 778.50 GEL\nTBC CARD\n20/10/2026';

/** The deposit is checked first: once "Money Transfer" is a payee, its name is a payee candidate in the deposit's prompt too. */
const answerFor = ({ prompt }: { prompt: string }) =>
  prompt.includes('Deposit Money: 778.50')
    ? { kind: 'credit' as const, amount: '778.50', currency: 'GEL', merchant: 'Deposit Money', cardName: CARD }
    : { kind: 'debit' as const, amount: '300.00', currency: 'USD', merchant: 'Money Transfer', cardName: CARD };

const setUp = async () => {
  await helpers.addUserCurrencies({ currencyCodes: ['GEL', 'USD'] });
  const day = subDays(startOfDay(new Date()), 6);
  SEEDED_DATES.push(day);
  // 1 USD = 2.6 GEL: 300 USD are worth 780 GEL, the deposit is 0.2% below.
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { AED: 4, GEL: 2.6 } });

  const gel = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ name: 'TBC GEL', currencyCode: 'GEL', initialBalance: 1000 }),
    raw: true,
  });
  const usd = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ name: 'TBC USD', currencyCode: 'USD', initialBalance: 1000 }),
    raw: true,
  });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: gel.id }, raw: true });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: usd.id, currencyCode: 'USD' }, raw: true });

  return { gel, usd, start: addMinutes(day, 14 * 60), secret: (await ingestHelpers.createTestIngestToken()).secret };
};

const push = ({ secret, start, minutes, body }: { secret: string; start: Date; minutes: number; body: string }) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'TBC Bank',
      title: 'TBC',
      subtitle: '',
      body,
      time: addMinutes(start, minutes).toISOString(),
      idempotencyKey: `push-${randomUUID()}`,
    },
  });

const suggestions = async () =>
  (await helpers.listUnconfirmedCardPayments({ raw: true })).map((entry) => entry.transferSuggestion);

/** Both legs were logged, and neither carries a suggestion. */
const expectLoggedWithoutSuggestion = async () => {
  expect(await Transactions.count()).toBe(2);
  expect((await suggestions()).filter(Boolean)).toEqual([]);
};

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

describe('currency-conversion pair', () => {
  useSelfHostWithoutServerAiKeys();
  useAiOnlyNotificationParsing();

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

  it('suggests linking a transfer out and the converted deposit six minutes later, and links nothing', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { gel, usd, secret, start } = await setUp();

    const out = await push({ secret, start, minutes: 0, body: TRANSFER_OUT });
    expect(out.body.response.outcome).toBe('logged');
    expect(await suggestions()).toEqual([null]);

    const inn = await push({ secret, start, minutes: 6, body: DEPOSIT_IN });
    expect(inn.body.response.outcome).toBe('logged');

    const expense = (await Transactions.findOne({ where: { accountId: usd.id } }))!;
    const income = (await Transactions.findOne({ where: { accountId: gel.id } }))!;
    expect(expense.transactionType).toBe(TRANSACTION_TYPES.expense);
    expect(income.transactionType).toBe(TRANSACTION_TYPES.income);

    const stored = await suggestions();
    expect(stored).toHaveLength(2);
    for (const suggestion of stored) {
      expect(suggestion).toEqual({
        kind: 'currencyConversion',
        expenseTransactionId: expense.id,
        incomeTransactionId: income.id,
        impliedRate: 2.595,
        marketRate: 2.6,
        deviation: expect.closeTo(0.0019, 3),
        createdAt: expect.any(String),
      });
    }

    // Never linked on its own.
    for (const row of await Transactions.findAll()) {
      expect(row.transferNature).toBe(TRANSACTION_TRANSFER_NATURE.not_transfer);
    }
  });

  it('suggests the pair when the deposit arrives first', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { secret, start } = await setUp();

    await push({ secret, start, minutes: 0, body: DEPOSIT_IN });
    await push({ secret, start, minutes: 6, body: TRANSFER_OUT });

    expect((await suggestions()).filter(Boolean)).toHaveLength(2);
  });

  it('is linkable with the existing transfer link once the owner approves', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { secret, start } = await setUp();
    await push({ secret, start, minutes: 0, body: TRANSFER_OUT });
    await push({ secret, start, minutes: 6, body: DEPOSIT_IN });

    const [suggestion] = await suggestions();
    const linked = await helpers.linkTransactions({
      payload: { ids: [[suggestion!.expenseTransactionId, suggestion!.incomeTransactionId]] },
      raw: true,
    });

    expect(linked.flat()).toHaveLength(2);
    for (const row of await Transactions.findAll()) {
      expect(row.transferNature).toBe(TRANSACTION_TRANSFER_NATURE.common_transfer);
    }
  });

  it('suggests nothing when the legs are more than an hour apart', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { secret, start } = await setUp();

    await push({ secret, start, minutes: 0, body: TRANSFER_OUT });
    await push({ secret, start, minutes: 61, body: DEPOSIT_IN });

    await expectLoggedWithoutSuggestion();
  });

  it('suggests nothing when the deposit is not near the day rate', async () => {
    mockNotificationParsing({
      answer: ({ prompt }) =>
        prompt.includes('Deposit Money: 900.00')
          ? { kind: 'credit', amount: '900.00', currency: 'GEL', merchant: 'Deposit Money', cardName: CARD }
          : answerFor({ prompt }),
    });
    const { secret, start } = await setUp();

    await push({ secret, start, minutes: 0, body: TRANSFER_OUT });
    await push({ secret, start, minutes: 6, body: 'Deposit Money: 900.00 GEL\nTBC CARD\n20/10/2026' });

    await expectLoggedWithoutSuggestion();
  });

  it('suggests nothing for a transfer and a deposit in the same currency', async () => {
    mockNotificationParsing({
      answer: ({ prompt }) =>
        prompt.includes('Deposit Money: 300.00')
          ? { kind: 'credit', amount: '300.00', currency: 'USD', merchant: 'Deposit Money', cardName: CARD }
          : answerFor({ prompt }),
    });
    const { secret, start } = await setUp();

    await push({ secret, start, minutes: 0, body: TRANSFER_OUT });
    await push({ secret, start, minutes: 6, body: 'Deposit Money: 300.00 USD\nTBC CARD\n20/10/2026' });

    await expectLoggedWithoutSuggestion();
  });

  it('suggests nothing for an ordinary payment', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { gel, secret, start } = await setUp();
    await helpers.createTransaction({
      payload: helpers.buildTransactionPayload({
        accountId: gel.id,
        transactionType: TRANSACTION_TYPES.income,
        amount: 5,
        time: addMinutes(start, 3).toISOString(),
      }),
      raw: true,
    });

    await push({ secret, start, minutes: 0, body: TRANSFER_OUT });

    await expectLoggedWithoutSuggestion();
  });
});
