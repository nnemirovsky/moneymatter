import { TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES, type ChatProposalCard, type RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import Transactions from '@models/transactions.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import { readStoredParse } from '@services/ingest/event/stored-parse';
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

/** The owner's two pushes of one exchange: 400 USD out, 360 EUR in, two minutes later. */
const MONEY_OUT = 'Money Transfer:\n400.00 USD\nEXAMPLE CARD\n24/10/2026';
const MONEY_IN = 'Deposit Money: 360.00 EUR\nEXAMPLE CARD\n24/10/2026\n';

/** What the model answers for them: the date alone reads as midnight, which the server must not keep. */
const answerFor = ({ prompt }: { prompt: string }) =>
  prompt.includes('Deposit Money')
    ? { kind: 'credit' as const, amount: '360.00', currency: 'EUR', merchant: null, cardName: 'EXAMPLE CARD' }
    : {
        kind: 'debit' as const,
        amount: '400.00',
        currency: 'USD',
        merchant: 'EXAMPLE CARD',
        occurredAt: '2026-10-24T00:00:00Z',
      };

const send = ({ secret, start, minutes, body }: { secret: string; start: Date; minutes: number; body: string }) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'Example Bank',
      title: 'Example',
      subtitle: '',
      body,
      time: addMinutes(start, minutes).toISOString(),
      idempotencyKey: `push-${randomUUID()}`,
    },
  });

interface SetUpOptions {
  /** Map the bank's card to its accounts, the way the owner's "Example Bank" card is. */
  mapped?: boolean;
  /** Name the accounts after the bank (found by name) instead of leaving them anonymous. */
  names?: [usd: string, eur: string];
}

const setUp = async ({ mapped = true, names = ['Example USD', 'Example EUR'] }: SetUpOptions = {}) => {
  await helpers.addUserCurrencies({ currencyCodes: ['EUR', 'USD'] });
  const day = subDays(startOfDay(new Date()), 6);
  SEEDED_DATES.push(day);
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { AED: 4, EUR: 0.9 } });

  const usd = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ name: names[0], currencyCode: 'USD', initialBalance: 1000 }),
    raw: true,
  });
  const eur = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ name: names[1], currencyCode: 'EUR', initialBalance: 1000 }),
    raw: true,
  });
  if (mapped) {
    await helpers.createCardMapping({ payload: { cardLabel: 'Example Bank', accountId: eur.id }, raw: true });
    await helpers.createCardMapping({
      payload: { cardLabel: 'Example Bank', accountId: usd.id, currencyCode: 'USD' },
      raw: true,
    });
  }

  const { secret } = await ingestHelpers.createTestIngestToken();
  // The bank's app is met on its first notification (one without an amount), and the owner approves it.
  await ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'Example Bank',
      title: 'Example',
      subtitle: '',
      body: 'Welcome',
      idempotencyKey: `hello-${randomUUID()}`,
    },
  });
  const [source] = await helpers.listNotificationSources({ raw: true });
  await helpers.updateNotificationSource({ id: source!.id, payload: { mode: 'approved' }, raw: true });

  return { usd, eur, start: addMinutes(day, 11 * 60), secret };
};

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

const refreshed = (card: ChatProposalCard) => helpers.refreshChatProposal({ proposalId: card.id, raw: true });

const edit = ({ card, changes }: { card: ChatProposalCard; changes: Record<string, unknown> }) =>
  helpers.editChatProposal({
    proposalId: card.id,
    payload: {
      revision: card.revision,
      args: { ...Object.fromEntries(card.fields.map((field) => [field.path, field.value])), ...changes },
    },
    raw: true,
  });

const approve = async ({ card }: { card: ChatProposalCard }) => {
  const approved = await helpers.approveChatProposal({ proposalId: card.id, payload: { revision: card.revision } });
  expect(approved.statusCode).toBe(200);
};

/** Waits for the approved legs to be logged and linked (the rows of `ignore` are older exchanges), and returns them. */
const waitForTransfer = async ({ ignore = [] }: { ignore?: RecordId[] } = {}) => {
  const fresh = async () =>
    (await Transactions.findAll({ order: [['amount', 'ASC']] })).filter((row) => !ignore.includes(row.id));
  await until(
    async () =>
      (await fresh()).filter((row) => row.transferNature === TRANSACTION_TRANSFER_NATURE.common_transfer).length === 2,
    { timeout: 30_000, interval: 150 },
  );

  return fresh();
};

const expectLinkedExchange = async ({
  usdId,
  eurId,
  ignore = [],
}: {
  usdId: RecordId;
  eurId: RecordId;
  ignore?: RecordId[];
}) => {
  const rows = await waitForTransfer({ ignore });
  expect(rows).toHaveLength(2);
  const expense = rows.find((row) => row.transactionType === TRANSACTION_TYPES.expense)!;
  const income = rows.find((row) => row.transactionType === TRANSACTION_TYPES.income)!;

  expect(expense).toMatchObject({ accountId: usdId, transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer });
  expect(expense.amount.toNumber()).toBe(400);
  expect(income).toMatchObject({ accountId: eurId, transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer });
  expect(income.amount.toNumber()).toBe(360);
  expect(expense.transferId).toBe(income.transferId);
  // The owner approved the pair on its card: nothing is left to confirm.
  expect(await helpers.listUnconfirmedCardPayments({ raw: true })).toEqual([]);
  await until(async () => (await requests()).filter((request) => request.status === 'logged').length === 2, {
    timeout: 15_000,
    interval: 150,
  });

  return { expense, income };
};

describe('a currency exchange told in two notifications', () => {
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

  it('waits as one card when the money out comes first, shows both sides and the rate, and approving makes one transfer', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { usd, eur, secret, start } = await setUp();

    const out = await send({ secret, start, minutes: 0, body: MONEY_OUT });
    const inn = await send({ secret, start, minutes: 2, body: MONEY_IN });

    expect(out.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownAccount' });
    expect(inn.body.response).toMatchObject({ outcome: 'duplicate', notify: false });
    const [first, second] = await requests();
    expect(first).toMatchObject({ status: 'parked' });
    expect(second).toMatchObject({ status: 'dismissed', reason: 'conversionLeg', duplicateOfId: first!.id });

    const cards = await waitForCards({ count: 1 });
    expect(cards).toHaveLength(1);
    const card = await refreshed(cards[0]!);
    expect(card.ingestRequest!.conversion).toEqual({
      fromAmount: 400,
      fromCurrencyCode: 'USD',
      toAmount: 360,
      toCurrencyCode: 'EUR',
      rate: 0.9,
      usualRate: null,
      suggestedNote: null,
      fromAccountId: usd.id,
      toAccountId: eur.id,
    });

    // The accounts at the bank are known, so the owner has nothing to choose.
    expect(card.canApply).toEqual({ ok: true });
    await approve({ card });

    await expectLinkedExchange({ usdId: usd.id, eurId: eur.id });
    expect(await inboxCards({ status: 'pending' })).toEqual([]);
  });

  it('waits as one card when the money in comes first', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { usd, eur, secret, start } = await setUp();

    const inn = await send({ secret, start, minutes: 0, body: MONEY_IN });
    const out = await send({ secret, start, minutes: 2, body: MONEY_OUT });

    expect(inn.body.response).toMatchObject({ outcome: 'parked' });
    expect(out.body.response).toMatchObject({ outcome: 'duplicate', notify: false });

    const [card] = await waitForCards({ count: 1 });
    expect((await refreshed(card!)).ingestRequest!.conversion).toMatchObject({ fromAmount: 400, toAmount: 360 });
    await approve({ card: await refreshed(card!) });

    await expectLinkedExchange({ usdId: usd.id, eurId: eur.id });
  });

  it('keeps the time of the notification when the text names only a date', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { usd, eur, secret, start } = await setUp();
    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    await send({ secret, start, minutes: 2, body: MONEY_IN });
    const [card] = await waitForCards({ count: 1 });
    // The model read the date as midnight; no time of day is kept.
    expect(readStoredParse({ value: (await requests())[0]!.parsed })!.payment!.occurredAt).toBeNull();
    await approve({ card: await refreshed(card!) });

    await expectLinkedExchange({ usdId: usd.id, eurId: eur.id });
    const expense = (await Transactions.findOne({ where: { accountId: usd.id } }))!;
    expect(expense.time.toISOString()).toBe(addMinutes(start, 0).toISOString());
  });

  it('gives the other side its card back when the first one is logged on its own', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { usd, secret, start } = await setUp();
    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    await send({ secret, start, minutes: 2, body: MONEY_IN });
    const [first, second] = await requests();
    expect(second).toMatchObject({ status: 'dismissed', reason: 'conversionLeg' });

    // The bank's default account now resolves the money out, so retrying it logs it without the exchange.
    const [source] = await helpers.listNotificationSources({ raw: true });
    await helpers.updateNotificationSource({ id: source!.id, payload: { defaultAccountId: usd.id }, raw: true });
    await helpers.retryCardPaymentRequest({ id: first!.id });

    await until(async () => (await Transactions.count()) === 1, { timeout: 30_000, interval: 150 });
    expect(await IngestRequests.findOne({ where: { id: second!.id } })).toMatchObject({
      status: 'parked',
      reason: 'unknownAccount',
      duplicateOfId: null,
    });
    const cards = await waitForCards({ count: 1 });
    expect(cards.some((card) => card.fields.some((field) => field.value === second!.id))).toBe(true);
    expect(await Transactions.count({ where: { transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer } })).toBe(
      0,
    );
  });

  it('falls back to two separate cards when the other side comes too late', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { secret, start } = await setUp();

    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    const late = await send({ secret, start, minutes: 11, body: MONEY_IN });

    expect(late.body.response).toMatchObject({ outcome: 'parked' });
    const cards = await waitForCards({ count: 2 });
    expect(cards).toHaveLength(2);
    for (const card of cards) expect((await refreshed(card)).ingestRequest!.conversion).toBeNull();
  });

  it('logs a lone side as the payment it is', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { usd, secret, start } = await setUp();

    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    const [card] = await waitForCards({ count: 1 });
    const fresh = await refreshed(card!);
    expect(fresh.ingestRequest!.conversion).toBeNull();

    await approve({ card: await edit({ card: fresh, changes: { accountId: usd.id } }) });
    await until(async () => (await Transactions.count()) === 1, { timeout: 30_000, interval: 150 });
    expect(await Transactions.count({ where: { transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer } })).toBe(
      0,
    );
  });

  it('pairs nothing when the other side could belong to two exchanges', async () => {
    mockNotificationParsing({
      answer: ({ prompt }) =>
        prompt.includes('300.00 USD')
          ? { kind: 'debit', amount: '300.00', currency: 'USD', merchant: 'EXAMPLE CARD' }
          : answerFor({ prompt }),
    });
    const { secret, start } = await setUp();

    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    await send({ secret, start, minutes: 1, body: 'Money Transfer:\n300.00 USD\nEXAMPLE CARD\n24/10/2026' });
    const inn = await send({ secret, start, minutes: 2, body: MONEY_IN });

    expect(inn.body.response).toMatchObject({ outcome: 'parked' });
    const cards = await waitForCards({ count: 3 });
    for (const card of cards) expect((await refreshed(card)).ingestRequest!.conversion).toBeNull();
  });

  it('does not pair a side that names a merchant', async () => {
    mockNotificationParsing({
      answer: ({ prompt }) =>
        prompt.includes('Deposit Money')
          ? { kind: 'credit', amount: '360.00', currency: 'EUR', merchant: 'Salary ACME' }
          : answerFor({ prompt }),
    });
    const { secret, start } = await setUp();

    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    await send({ secret, start, minutes: 2, body: MONEY_IN });

    expect(await waitForCards({ count: 2 })).toHaveLength(2);
  });

  it('recognizes two cards that were already waiting as one exchange, and approving either settles both', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { usd, eur, secret, start } = await setUp();

    // Parsed as two payments, each on a card of its own (as before the exchange was recognized).
    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    await send({ secret, start, minutes: 11, body: MONEY_IN });
    const [out, inn] = await requests();
    expect(out).toMatchObject({ status: 'parked' });
    expect(inn).toMatchObject({ status: 'parked' });
    const cards = await waitForCards({ count: 2 });

    // They are the two sides of one exchange as far as the clock goes.
    await inn!.update({ payload: { ...inn!.payload, time: addMinutes(start, 2).toISOString() } });

    for (const card of cards) {
      expect((await refreshed(card)).ingestRequest!.conversion).toMatchObject({
        fromAmount: 400,
        toAmount: 360,
        rate: 0.9,
        fromAccountId: usd.id,
        toAccountId: eur.id,
      });
    }

    // Approving the card of the money in logs both sides and closes the other card.
    const creditCard = cards.find((card) => card.fields.some((field) => field.value === inn!.id))!;
    await approve({ card: await refreshed(creditCard) });

    await expectLinkedExchange({ usdId: usd.id, eurId: eur.id });
    expect(await inboxCards({ status: 'pending' })).toEqual([]);
  });

  it('asks for the two accounts when the bank has none the server can tell, and never offers another bank', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { usd, eur, secret, start } = await setUp({ mapped: false, names: ['Savings', 'Cash'] });
    // An account of another bank in each currency: never a candidate for this bank's exchange.
    await helpers.createAccount({
      payload: helpers.buildAccountPayload({ name: 'Raiffeisen USD', currencyCode: 'USD', initialBalance: 1 }),
      raw: true,
    });

    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    await send({ secret, start, minutes: 2, body: MONEY_IN });
    const [pending] = await waitForCards({ count: 1 });
    const card = await refreshed(pending!);

    expect(card.ingestRequest!.conversion).toMatchObject({ fromAccountId: null, toAccountId: null });
    expect(card.canApply).toMatchObject({ ok: false });

    const chosen = await edit({ card, changes: { accountId: usd.id, counterAccountId: eur.id } });
    expect(chosen.canApply).toEqual({ ok: true });
    await approve({ card: chosen });

    await expectLinkedExchange({ usdId: usd.id, eurId: eur.id });
  });

  it('starts the card without the single guess in the currency, and logs on the account the owner picks even when it is that guess', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { usd, eur, secret, start } = await setUp({ names: ['Dollar jar', 'Example EUR'] });
    // Named like the app, so the server would guess it for the money out; the owner's "Example Bank" card points elsewhere.
    const guessed = await helpers.createAccount({
      payload: helpers.buildAccountPayload({ name: 'Example Bank USD', currencyCode: 'USD', initialBalance: 1 }),
      raw: true,
    });

    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    await send({ secret, start, minutes: 2, body: MONEY_IN });
    const [pending] = await waitForCards({ count: 1 });
    expect(readStoredParse({ value: (await requests())[0]!.parsed })!.accountGuessId).toBe(guessed.id);

    // Nothing pre-filled: the bank's own accounts are what the card suggests.
    const card = await refreshed(pending!);
    expect(card.fields.find((field) => field.path === 'accountId')).toBeUndefined();
    expect(card.ingestRequest!.conversion).toMatchObject({ fromAccountId: usd.id, toAccountId: eur.id });

    await approve({ card: await edit({ card, changes: { accountId: guessed.id } }) });

    await until(
      async () =>
        (await Transactions.count({ where: { transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer } })) === 2,
      {
        timeout: 30_000,
        interval: 150,
      },
    );
    const expense = (await Transactions.findOne({ where: { transactionType: TRANSACTION_TYPES.expense } }))!;
    const income = (await Transactions.findOne({ where: { transactionType: TRANSACTION_TYPES.income } }))!;
    expect(expense.accountId).toBe(guessed.id);
    expect(income.accountId).toBe(eur.id);
  });

  it('gives the other side back with the gate it parked under', async () => {
    mockNotificationParsing({
      answer: ({ prompt }) =>
        prompt.includes('Deposit Money')
          ? { kind: 'credit', amount: '360.00', currency: 'EUR', merchant: null, isOwnAccountTransfer: true }
          : answerFor({ prompt }),
    });
    const { usd, secret, start } = await setUp();
    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    await send({ secret, start, minutes: 2, body: MONEY_IN });
    const [first, second] = await requests();
    expect(second).toMatchObject({ status: 'dismissed', reason: 'conversionLeg' });

    const [source] = await helpers.listNotificationSources({ raw: true });
    await helpers.updateNotificationSource({ id: source!.id, payload: { defaultAccountId: usd.id }, raw: true });
    await helpers.retryCardPaymentRequest({ id: first!.id });

    await until(async () => (await IngestRequests.findOne({ where: { id: second!.id } }))!.status === 'parked', {
      timeout: 30_000,
      interval: 150,
    });
    expect(await IngestRequests.findOne({ where: { id: second!.id } })).toMatchObject({ reason: 'ownTransfer' });
  });

  it('refuses one account for both sides', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { usd, secret, start } = await setUp();
    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    await send({ secret, start, minutes: 2, body: MONEY_IN });
    const [pending] = await waitForCards({ count: 1 });

    const chosen = await edit({
      card: await refreshed(pending!),
      changes: { accountId: usd.id, counterAccountId: usd.id },
    });
    const approved = await helpers.approveChatProposal({
      proposalId: chosen.id,
      payload: { revision: chosen.revision },
    });

    expect(approved.statusCode).not.toBe(200);
    expect(await Transactions.count()).toBe(0);
  });
});

/** A past exchange the owner already has in the ledger, linked as a transfer with a note. */
const seedPastExchange = async ({
  usdId,
  eurId,
  sent,
  received,
  note,
  daysAgo,
}: {
  usdId: RecordId;
  eurId: RecordId;
  sent: number;
  received: number;
  note: string;
  daysAgo: number;
}) => {
  const time = subDays(new Date(), daysAgo).toISOString();
  const [expense] = await helpers.createTransaction({
    payload: helpers.buildTransactionPayload({ accountId: usdId, amount: sent, time, note }),
    raw: true,
  });
  const [income] = await helpers.createTransaction({
    payload: helpers.buildTransactionPayload({
      accountId: eurId,
      amount: received,
      time,
      transactionType: TRANSACTION_TYPES.income,
    }),
    raw: true,
  });
  await helpers.linkTransactions({ payload: { ids: [[expense!.id, income!.id]] }, raw: true });

  return [expense!.id, income!.id];
};

const probe = ({ secret, title, app = 'Messages' }: { secret: string; title: string; app?: string }) =>
  ingestHelpers.postIngestEvent({ secret, body: { kind: 'notificationProbe', app, title } });

describe("what the owner's history adds to an exchange", () => {
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

  it('reuses the note of the latest exchange between the same accounts', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { usd, eur, secret, start } = await setUp();
    const past = await seedPastExchange({
      usdId: usd.id,
      eurId: eur.id,
      sent: 300,
      received: 270,
      note: 'Exchange · via XCHANGE',
      daysAgo: 4,
    });

    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    await send({ secret, start, minutes: 2, body: MONEY_IN });
    const [pending] = await waitForCards({ count: 1 });
    const card = await refreshed(pending!);

    expect(card.ingestRequest!.conversion).toMatchObject({ usualRate: 0.9, suggestedNote: 'Exchange · via XCHANGE' });
    expect(card.warnings).toEqual([]);
    await approve({ card });
    const { expense } = await expectLinkedExchange({ usdId: usd.id, eurId: eur.id, ignore: past });
    expect(expense.note).toBe('Exchange · via XCHANGE');
  });

  it('finds the exchange between the two accounts among many transfers out of the same account', async () => {
    mockNotificationParsing({ answer: answerFor });
    const { usd, eur, secret, start } = await setUp();
    const savings = await helpers.createAccount({
      payload: helpers.buildAccountPayload({ name: 'Savings', currencyCode: 'EUR', initialBalance: 1 }),
      raw: true,
    });
    await seedPastExchange({
      usdId: usd.id,
      eurId: eur.id,
      sent: 300,
      received: 270,
      note: 'Exchange · via XCHANGE',
      daysAgo: 30,
    });
    for (let day = 1; day <= 12; day += 1) {
      await seedPastExchange({
        usdId: usd.id,
        eurId: savings.id,
        sent: 100,
        received: 90,
        note: 'Savings top-up',
        daysAgo: day,
      });
    }

    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    await send({ secret, start, minutes: 2, body: MONEY_IN });
    const [pending] = await waitForCards({ count: 1 });

    expect((await refreshed(pending!)).ingestRequest!.conversion).toMatchObject({
      usualRate: 0.9,
      suggestedNote: 'Exchange · via XCHANGE',
    });
  });

  it('flags a rate far from the one the owner usually gets', async () => {
    mockNotificationParsing({
      answer: ({ prompt }) =>
        prompt.includes('Deposit Money')
          ? { kind: 'credit', amount: '200.00', currency: 'EUR', merchant: null, cardName: 'EXAMPLE CARD' }
          : answerFor({ prompt }),
    });
    const { usd, eur, secret, start } = await setUp();
    await seedPastExchange({ usdId: usd.id, eurId: eur.id, sent: 300, received: 270, note: 'Exchange', daysAgo: 4 });

    await send({ secret, start, minutes: 0, body: MONEY_OUT });
    await send({ secret, start, minutes: 2, body: 'Deposit Money: 200.00 EUR\nEXAMPLE CARD\n24/10/2026\n' });
    const [pending] = await waitForCards({ count: 1 });
    const card = await refreshed(pending!);

    expect(card.warnings).toEqual([
      { key: 'chat.warnings.ingestConversionRate', params: { rate: 0.5, usual: 0.9, from: 'USD', to: 'EUR' } },
    ]);
  });

  describe('a text message of a business sender', () => {
    const MESSAGE = { title: 'XCHANGE', body: 'Ekzemplo: la interŝanĝo estas farita. Dankon pro uzado.' };

    const pairWithHistory = async () => {
      const setup = await setUp();
      const past = await seedPastExchange({
        usdId: setup.usd.id,
        eurId: setup.eur.id,
        sent: 300,
        received: 270,
        note: 'Exchange · via XCHANGE',
        daysAgo: 4,
      });
      await send({ secret: setup.secret, start: setup.start, minutes: 0, body: MONEY_OUT });
      await send({ secret: setup.secret, start: setup.start, minutes: 2, body: MONEY_IN });
      await waitForCards({ count: 1 });

      return { ...setup, past };
    };

    it('is offered when its name is in the notes of past exchanges, and a phone number, a contact or an unknown ID is not', async () => {
      mockNotificationParsing({ answer: answerFor });
      const { secret } = await pairWithHistory();

      expect((await probe({ secret, title: 'XCHANGE' })).body.response.send).toBe('yes');
      expect((await probe({ secret, title: '+15550100200' })).body.response.send).toBeUndefined();
      expect((await probe({ secret, title: 'Mom' })).body.response.send).toBeUndefined();
      expect((await probe({ secret, title: 'XCHANGE', app: 'WhatsApp' })).body.response.send).toBeUndefined();
      expect((await probe({ secret, title: 'OTHERBIZ' })).body.response.send).toBeUndefined();
    });

    it('is not offered when no exchange waits', async () => {
      mockNotificationParsing({ answer: answerFor });
      const { usd, eur, secret } = await setUp();
      await seedPastExchange({
        usdId: usd.id,
        eurId: eur.id,
        sent: 300,
        received: 270,
        note: 'Exchange · via XCHANGE',
        daysAgo: 4,
      });

      expect((await probe({ secret, title: 'XCHANGE' })).body.response.send).toBeUndefined();
    });

    it('confirms the pair from a text with no amount and gives the exchange its note, never an amount', async () => {
      const exchangeReadPrompts: string[] = [];
      mockNotificationParsing({
        answer: answerFor,
        exchangeReadPrompts,
        exchangeRead: () => ({ confirmsExchange: true, note: 'Exchange · XCHANGE app', confidence: 0.9 }),
      });
      const { usd, eur, secret, past } = await pairWithHistory();
      await probe({ secret, title: 'XCHANGE' });

      const sent = await ingestHelpers.postIngestEvent({
        secret,
        body: {
          kind: 'notification',
          app: 'Messages',
          title: MESSAGE.title,
          subtitle: '',
          body: MESSAGE.body,
          idempotencyKey: `sms-${randomUUID()}`,
        },
      });

      expect(sent.body.response).toMatchObject({ outcome: 'ignored', reason: 'exchangeNoted' });
      expect(exchangeReadPrompts).toHaveLength(1);
      expect(exchangeReadPrompts[0]).toContain('sent 400 USD, received 360 EUR');
      expect(exchangeReadPrompts[0]).toContain('Exchange · via XCHANGE');

      const [pending] = await waitForCards({ count: 1 });
      const card = await refreshed(pending!);
      expect(card.ingestRequest!.conversion!.suggestedNote).toBe('Exchange · XCHANGE app');
      await approve({ card });
      const { expense } = await expectLinkedExchange({ usdId: usd.id, eurId: eur.id, ignore: past });
      expect(expense.note).toBe('Exchange · XCHANGE app');
    });

    it('drops a note that carries a number and changes nothing when the message is not the exchange', async () => {
      mockNotificationParsing({
        answer: answerFor,
        exchangeRead: ({ prompt }) =>
          prompt.includes('Ekzemplo')
            ? { confirmsExchange: true, note: 'Exchange of 400 via XCHANGE', confidence: 0.9 }
            : { confirmsExchange: false, note: null, confidence: 0.9 },
      });
      const { secret } = await pairWithHistory();
      await probe({ secret, title: 'XCHANGE' });
      const send = (body: string) =>
        ingestHelpers.postIngestEvent({
          secret,
          body: {
            kind: 'notification',
            app: 'Messages',
            title: 'XCHANGE',
            subtitle: '',
            body,
            idempotencyKey: `sms-${randomUUID()}`,
          },
        });

      // A note with a number is not kept, so the message is not recorded as having noted the exchange.
      expect((await send(MESSAGE.body)).body.response).toMatchObject({ reason: 'info' });
      expect((await send('Ofertoj de la semajno por vi.')).body.response).toMatchObject({
        outcome: 'ignored',
        reason: 'info',
      });

      const [pending] = await waitForCards({ count: 1 });
      // The numeric note is not kept: the note of the past exchange stands.
      expect((await refreshed(pending!)).ingestRequest!.conversion!.suggestedNote).toBe('Exchange · via XCHANGE');
    });
  });
});
