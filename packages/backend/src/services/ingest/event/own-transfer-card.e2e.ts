import { TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES, type ChatProposalCard, type RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import Transactions from '@models/transactions.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing, useAiOnlyNotificationParsing } from '@tests/helpers/notification-ai';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from './constants';

const BASE = global.BASE_CURRENCY_CODE;
const DEFAULT_TIMINGS = { ...notificationTimings };
const LOG_REQUEST = 'log_ingest_request';

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

/** What the mocked model reads from the next push. */
let reading: Record<string, unknown> = {};

const push = ({ secret, body }: { secret: string; body: string }) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'Example Bank',
      title: 'Example Bank',
      subtitle: '',
      body,
      idempotencyKey: `push-${randomUUID()}`,
    },
  });

const waitUntilLogged = async ({ requestId }: { requestId: RecordId }) =>
  until(async () => (await IngestRequests.findByPk(requestId))!.status === 'logged', {
    timeout: 20_000,
    interval: 150,
  });

/** A card payment of the source on the card a link sends to one account: it lands in the source's history. */
const payWithCard = async ({ secret, digits }: { secret: string; digits: string }) => {
  reading = { kind: 'debit', amount: '12.00', currency: BASE, merchant: 'Shop', cardLastDigits: digits };
  const res = await push({ secret, body: `Purchase ${BASE} 12.00 at Shop, card *${digits}` });
  expect(res.body.response.outcome).toBe('logged');
  await waitUntilLogged({ requestId: res.body.response.requestId });
};

const inboxCards = async ({ toolName }: { toolName: string }): Promise<ChatProposalCard[]> => {
  const threads = (await helpers.listChatThreads({ raw: true })).threads.filter(
    (thread) => thread.kind === 'automationInbox',
  );
  const cards: ChatProposalCard[] = [];
  for (const thread of threads) {
    cards.push(...Object.values((await helpers.getChatThread({ threadId: thread.id, limit: 100, raw: true })).cards));
  }

  return cards.filter((card) => card.toolName === toolName);
};

/** A notice of a transfer between the owner's accounts that names neither: it waits on a card of its own. */
const transferNotice = async ({
  secret,
  amount = '100.00',
  kind = 'debit',
}: {
  secret: string;
  amount?: string;
  kind?: 'debit' | 'credit';
}) => {
  reading = { kind, amount, currency: BASE, merchant: null, cardLastDigits: null, isOwnAccountTransfer: true };
  const res = await push({ secret, body: `Transfer between accounts: ${amount} ${BASE}` });
  expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'ownTransfer' });
  await until(async () => (await inboxCards({ toolName: LOG_REQUEST })).length === 1, {
    timeout: 30_000,
    interval: 150,
  });

  return {
    requestId: res.body.response.requestId as RecordId,
    card: (await inboxCards({ toolName: LOG_REQUEST }))[0]!,
  };
};

const fieldOf = ({ card, path }: { card: ChatProposalCard; path: string }) =>
  card.fields.find((field) => field.path === path)?.value;

const edit = ({ card, changes }: { card: ChatProposalCard; changes: Record<string, unknown> }) =>
  helpers.editChatProposal({
    proposalId: card.id,
    payload: {
      revision: card.revision,
      args: { ...Object.fromEntries(card.fields.map((field) => [field.path, field.value])), ...changes },
    },
    raw: true,
  });

const approve = ({ card }: { card: ChatProposalCard }) =>
  helpers.approveChatProposal({ proposalId: card.id, payload: { revision: card.revision } });

const transferRows = async () => {
  await until(
    async () =>
      (await Transactions.count({ where: { transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer } })) === 2,
    { timeout: 30_000, interval: 150 },
  );
  const rows = await Transactions.findAll({
    where: { transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer },
  });
  const expense = rows.find((row) => row.transactionType === TRANSACTION_TYPES.expense)!;
  const income = rows.find((row) => row.transactionType === TRANSACTION_TYPES.income)!;
  expect(expense.transferId).toBeTruthy();
  expect(expense.transferId).toBe(income.transferId);

  return { expense, income };
};

describe('the card of an own-account transfer notice', () => {
  useSelfHostWithoutServerAiKeys();
  useAiOnlyNotificationParsing();

  beforeEach(async () => {
    enableServerModel();
    notificationTimings.categorizeWaitMs = 50;
    mockNotificationParsing({ answer: () => reading });
    await resetLimits();
  });
  afterEach(async () => {
    Object.assign(notificationTimings, DEFAULT_TIMINGS);
    await resetLimits();
  });

  const account = ({ name, initialBalance = 1000 }: { name: string; initialBalance?: number }) =>
    helpers.createAccount({
      payload: helpers.buildAccountPayload({ name, currencyCode: BASE, initialBalance }),
      raw: true,
    });

  /** Two accounts in the currency the source logged to, Savings most recently. */
  const setUp = async ({ checkingBalance = 1000 }: { checkingBalance?: number } = {}) => {
    const checking = await account({ name: 'Checking', initialBalance: checkingBalance });
    const savings = await account({ name: 'Savings' });
    await helpers.createCardMapping({
      payload: { cardLabel: 'Example Bank •1111', lastDigits: '1111', accountId: checking.id },
      raw: true,
    });
    await helpers.createCardMapping({
      payload: { cardLabel: 'Example Bank •2222', lastDigits: '2222', accountId: savings.id },
      raw: true,
    });
    const { secret } = await ingestHelpers.createTestIngestToken();
    await payWithCard({ secret, digits: '1111' });
    await payWithCard({ secret, digits: '2222' });

    return { checking, savings, secret };
  };

  it('guesses both sides, the most recently used account sending a debit, and approving logs one transfer', async () => {
    const { checking, savings, secret } = await setUp();
    const { card } = await transferNotice({ secret });

    expect(fieldOf({ card, path: 'accountId' })).toBe(savings.id);
    expect(fieldOf({ card, path: 'counterAccountId' })).toBe(checking.id);
    expect(fieldOf({ card, path: 'direction' })).toBe('debit');
    expect(card.ingestRequest).toMatchObject({
      reason: 'ownTransfer',
      counter: { accountId: checking.id, currencyCode: BASE, amount: 100 },
    });
    expect(card.canApply).toEqual({ ok: true });
    expect(card.safe).toBe(false);

    expect((await approve({ card })).statusCode).toBe(200);

    const { expense, income } = await transferRows();
    expect(expense).toMatchObject({ accountId: savings.id });
    expect(income).toMatchObject({ accountId: checking.id });
    expect(expense.amount.toNumber()).toBe(100);
    expect(income.amount.toNumber()).toBe(100);
  });

  it('swaps the sides when the owner flips the direction on the card', async () => {
    const { checking, savings, secret } = await setUp();
    const { card } = await transferNotice({ secret });

    const swapped = await edit({ card, changes: { direction: 'credit' } });
    expect((await approve({ card: swapped })).statusCode).toBe(200);

    const { expense, income } = await transferRows();
    expect(expense).toMatchObject({ accountId: checking.id });
    expect(income).toMatchObject({ accountId: savings.id });
  });

  it('lands a credit notice on the most recently used account', async () => {
    const { checking, savings, secret } = await setUp();
    const { card } = await transferNotice({ secret, kind: 'credit' });

    expect(fieldOf({ card, path: 'accountId' })).toBe(savings.id);
    expect(fieldOf({ card, path: 'counterAccountId' })).toBe(checking.id);
    expect(fieldOf({ card, path: 'direction' })).toBe('credit');

    expect((await approve({ card })).statusCode).toBe(200);

    const { expense, income } = await transferRows();
    expect(expense).toMatchObject({ accountId: checking.id });
    expect(income).toMatchObject({ accountId: savings.id });
  });

  it('sends from the only account whose balance covers the amount', async () => {
    const { checking, savings, secret } = await setUp({ checkingBalance: 5000 });
    const { card } = await transferNotice({ secret, amount: '2000.00' });

    expect(fieldOf({ card, path: 'accountId' })).toBe(checking.id);
    expect(fieldOf({ card, path: 'counterAccountId' })).toBe(savings.id);
  });

  it('refuses to approve a transfer whose own side was cleared, and logs nothing', async () => {
    const { secret } = await setUp();
    const { card, requestId } = await transferNotice({ secret });

    const cleared = await edit({ card, changes: { accountId: undefined } });
    expect(cleared.canApply).toEqual({ ok: false, reasonKey: 'chat.cards.ingestAccountRequired' });

    expect((await approve({ card: cleared })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await IngestRequests.findByPk(requestId))!.status).toBe('parked');
    expect(await Transactions.count({ where: { transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer } })).toBe(
      0,
    );
  });

  it('makes no guess from a source with one account in its history, and logs a plain payment as before', async () => {
    const checking = await account({ name: 'Checking' });
    await helpers.createCardMapping({
      payload: { cardLabel: 'Example Bank •1111', lastDigits: '1111', accountId: checking.id },
      raw: true,
    });
    const { secret } = await ingestHelpers.createTestIngestToken();
    await payWithCard({ secret, digits: '1111' });
    const { card, requestId } = await transferNotice({ secret });

    expect(fieldOf({ card, path: 'accountId' })).toBeUndefined();
    expect(fieldOf({ card, path: 'counterAccountId' })).toBeUndefined();
    expect(card.ingestRequest?.counter).toBeUndefined();

    const picked = await edit({ card, changes: { accountId: checking.id } });
    expect((await approve({ card: picked })).statusCode).toBe(200);

    await waitUntilLogged({ requestId });
    const logged = (await Transactions.findByPk((await IngestRequests.findByPk(requestId))!.transactionId!))!;
    expect(logged).toMatchObject({ accountId: checking.id, transactionType: TRANSACTION_TYPES.expense });
    expect(logged.amount.toNumber()).toBe(100);
    expect(logged.transferId).toBeNull();
  });

  it('makes no guess from a source with no history', async () => {
    await account({ name: 'Checking' });
    await account({ name: 'Savings' });
    const { secret } = await ingestHelpers.createTestIngestToken();
    const { card } = await transferNotice({ secret });

    expect(fieldOf({ card, path: 'accountId' })).toBeUndefined();
    expect(fieldOf({ card, path: 'counterAccountId' })).toBeUndefined();
  });
});
