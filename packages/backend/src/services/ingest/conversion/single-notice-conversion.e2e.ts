import { TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES, type ChatProposalCard } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
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

const LOG_REQUEST = 'log_ingest_request';
const DEFAULT_TIMINGS = { ...notificationTimings };
const SEEDED_DATES: Date[] = [];

/** One notice that holds both sides of an exchange: 100 USD sold, 90 EUR bought, the rate and a date (no time). */
const CONVERSION = 'Conversion:\n100.00 USD\n90.00 EUR\nRate: 0.9\n15/01/2026';

const setUp = async () => {
  await helpers.addUserCurrencies({ currencyCodes: ['EUR', 'USD'] });
  const day = subDays(startOfDay(new Date()), 6);
  SEEDED_DATES.push(day);
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { AED: 4, EUR: 0.9 } });
  const account = ({ name, currencyCode }: { name: string; currencyCode: string }) =>
    helpers.createAccount({
      payload: helpers.buildAccountPayload({ name, currencyCode, initialBalance: 1000 }),
      raw: true,
    });
  const usd = await account({ name: 'Example USD', currencyCode: 'USD' });
  const usdSpare = await account({ name: 'Spare USD', currencyCode: 'USD' });
  const eur = await account({ name: 'Example EUR', currencyCode: 'EUR' });
  await helpers.createCardMapping({ payload: { cardLabel: 'Example Bank', accountId: eur.id }, raw: true });
  await helpers.createCardMapping({
    payload: { cardLabel: 'Example Bank', accountId: usd.id, currencyCode: 'USD' },
    raw: true,
  });

  return {
    usd,
    usdSpare,
    eur,
    start: addMinutes(day, 11 * 60),
    secret: (await ingestHelpers.createTestIngestToken()).secret,
  };
};

const send = ({ secret, start, body }: { secret: string; start: Date; body: string }) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'Example Bank',
      title: 'Example Bank',
      subtitle: '',
      body,
      time: start.toISOString(),
      idempotencyKey: `push-${randomUUID()}`,
    },
  });

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

const inboxCards = async ({ status }: { status?: string } = {}): Promise<ChatProposalCard[]> => {
  const threads = (await helpers.listChatThreads({ raw: true })).threads.filter(
    (thread) => thread.kind === 'automationInbox',
  );
  const cards: ChatProposalCard[] = [];
  for (const thread of threads) {
    cards.push(...Object.values((await helpers.getChatThread({ threadId: thread.id, limit: 100, raw: true })).cards));
  }

  return cards.filter((card) => card.toolName === LOG_REQUEST && (!status || card.status === status));
};

const waitForCards = async ({ count }: { count: number }) => {
  await until(async () => (await inboxCards({ status: 'pending' })).length >= count, {
    timeout: 30_000,
    interval: 150,
  });

  return inboxCards({ status: 'pending' });
};

const requests = () => IngestRequests.findAll({ where: { pipeline: 'notification' }, order: [['createdAt', 'ASC']] });

const transfer = ({
  fromId,
  toId,
  at,
  sent,
  received,
}: {
  fromId: string;
  toId: string;
  at: Date;
  sent: number;
  received: number;
}) =>
  helpers.createTransaction({
    payload: helpers.buildTransactionPayload({
      accountId: fromId as never,
      amount: sent,
      time: at.toISOString(),
      transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer,
      destinationAmount: received,
      destinationAccountId: toId as never,
    }),
    raw: true,
  });

describe('a notice that holds both sides of a currency exchange', () => {
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

  it('waits as the one exchange card, without the AI, and approving logs both sides as one transfer at its time', async () => {
    const prompts = mockNotificationParsing({ answer: () => ({}) });
    const { usd, eur, secret, start } = await setUp();

    const sent = await send({ secret, start, body: CONVERSION });

    expect(sent.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownAccount' });
    expect(prompts).toHaveLength(0);
    const [primary, leg] = await requests();
    expect(primary).toMatchObject({ status: 'parked' });
    expect(leg).toMatchObject({ status: 'dismissed', reason: 'conversionLeg', duplicateOfId: primary!.id });

    const [card] = await waitForCards({ count: 1 });
    const fresh = await helpers.refreshChatProposal({ proposalId: card!.id, raw: true });
    expect(fresh.ingestRequest!.conversion).toMatchObject({
      fromAmount: 100,
      fromCurrencyCode: 'USD',
      toAmount: 90,
      toCurrencyCode: 'EUR',
      rate: 0.9,
      fromAccountId: usd.id,
      toAccountId: eur.id,
    });
    expect(fresh.canApply).toEqual({ ok: true });

    const approved = await helpers.approveChatProposal({ proposalId: fresh.id, payload: { revision: fresh.revision } });
    expect(approved.statusCode).toBe(200);

    await until(
      async () =>
        (await Transactions.count({ where: { transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer } })) === 2,
      { timeout: 30_000, interval: 150 },
    );
    const rows = await Transactions.findAll();
    const expense = rows.find((row) => row.transactionType === TRANSACTION_TYPES.expense)!;
    const income = rows.find((row) => row.transactionType === TRANSACTION_TYPES.income)!;
    expect(expense).toMatchObject({ accountId: usd.id });
    expect(expense.amount.toNumber()).toBe(100);
    expect(income).toMatchObject({ accountId: eur.id });
    expect(income.amount.toNumber()).toBe(90);
    expect(expense.transferId).toBe(income.transferId);
    expect(expense.time.toISOString()).toBe(start.toISOString());
  });

  it('settles the waiting exchange card when the same transfer is logged somewhere else', async () => {
    mockNotificationParsing({ answer: () => ({}) });
    const { usd, eur, secret, start } = await setUp();
    await send({ secret, start, body: CONVERSION });
    await waitForCards({ count: 1 });

    await transfer({ fromId: usd.id, toId: eur.id, at: addMinutes(start, 1), sent: 100, received: 90 });

    await until(async () => (await requests())[0]!.status === 'dismissed', { timeout: 15_000, interval: 200 });
    expect((await requests())[0]).toMatchObject({ status: 'dismissed', reason: 'resolvedElsewhere' });
    expect(await inboxCards({ status: 'pending' })).toEqual([]);
  });

  it('keeps the card when the transfer logged elsewhere has other amounts', async () => {
    mockNotificationParsing({ answer: () => ({}) });
    const { usd, eur, secret, start } = await setUp();
    await send({ secret, start, body: CONVERSION });
    await waitForCards({ count: 1 });

    await transfer({ fromId: usd.id, toId: eur.id, at: addMinutes(start, 1), sent: 50, received: 45 });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect((await requests())[0]).toMatchObject({ status: 'parked' });
    expect(await inboxCards({ status: 'pending' })).toHaveLength(1);
  });

  it('keeps the card when the transfer logged elsewhere is a day away', async () => {
    mockNotificationParsing({ answer: () => ({}) });
    const { usd, eur, secret, start } = await setUp();
    await send({ secret, start, body: CONVERSION });
    await waitForCards({ count: 1 });

    await transfer({ fromId: usd.id, toId: eur.id, at: addMinutes(start, 3 * 24 * 60), sent: 100, received: 90 });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect((await requests())[0]).toMatchObject({ status: 'parked' });
  });

  it('settles a payment parked as an own transfer when a transfer with its amount is logged elsewhere', async () => {
    mockNotificationParsing({
      answer: () => ({
        kind: 'debit',
        amount: '50.00',
        currency: 'USD',
        merchant: null,
        isOwnAccountTransfer: true,
        confidence: 0.95,
      }),
    });
    const { usd, usdSpare, secret, start } = await setUp();
    const sent = await send({ secret, start, body: 'Ref 7731: 50.00 USD to own account' });
    expect(sent.body.response).toMatchObject({ outcome: 'parked', reason: 'ownTransfer' });
    await waitForCards({ count: 1 });

    await transfer({ fromId: usd.id, toId: usdSpare.id, at: addMinutes(start, 1), sent: 50, received: 50 });

    await until(async () => (await requests())[0]!.status === 'dismissed', { timeout: 15_000, interval: 200 });
    expect((await requests())[0]).toMatchObject({ reason: 'resolvedElsewhere' });
    expect(await inboxCards({ status: 'pending' })).toEqual([]);
  });

  it('leaves a notice the AI reads (one amount) as it was, and a conversion of one currency to itself too', async () => {
    mockNotificationParsing({ answer: () => ({ kind: 'debit', amount: '100.00', currency: 'USD', confidence: 0.95 }) });
    const { secret, start } = await setUp();

    await send({ secret, start, body: 'Conversion 100.00 USD 90.00 USD Rate 0.9' });

    expect(await requests()).toHaveLength(1);
  });
});
