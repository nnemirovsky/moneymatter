import {
  TRANSACTION_TRANSFER_NATURE,
  type ChatProposalCard,
  type ChatProposalStatus,
  type ChatThread,
  type RecordId,
} from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import ChatMessages from '@models/chat-messages.model';
import ChatProposals from '@models/chat-proposals.model';
import ChatThreads from '@models/chat-threads.model';
import DuplicateSuggestions from '@models/duplicate-suggestions.model';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import Transactions from '@models/transactions.model';
import { getDismissalsForUser } from '@models/transfer-suggestion-dismissals.model';
import { redisClient } from '@root/redis-client';
import { RateLimitService } from '@services/common/rate-limit.service';
import { buildLockKey } from '@services/currencies/base-currency-lock';
import { notificationTimings } from '@services/ingest/event/constants';
import { woltOnlinePayment } from '@services/ingest/event/fixtures/notifications';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { addMinutes, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

import { inboxConfig } from './inbox-transitions';

const CARD = woltOnlinePayment.tap.card;
const BASE = global.BASE_CURRENCY_CODE;
const DEFAULT_TIMINGS = { ...notificationTimings };
const DEFAULT_INBOX_CONFIG = { ...inboxConfig };
const SEEDED_DATES: Date[] = [];

const CONFIRM = 'confirm_ingest_payment';
const LOG_REQUEST = 'log_ingest_request';
const SET_SOURCE = 'set_notification_source';
const MERGE = 'merge_duplicate_transactions';
const LINK = 'link_transfer';

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

/** A day with pinned rates (1 USD = 2 GEL = 1 EUR = 4 AED), so every converted amount is exact. */
const seedRateDay = async () => {
  const day = subDays(startOfDay(new Date()), 6);
  SEEDED_DATES.push(day);
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { AED: 4, GEL: 2, EUR: 1 } });

  return addMinutes(day, 14 * 60 + 38);
};

const account = ({
  name,
  currencyCode = BASE,
  initialBalance = 1000,
}: {
  name: string;
  currencyCode?: string;
  initialBalance?: number;
}) =>
  helpers.createAccount({
    payload: helpers.buildAccountPayload({ name, currencyCode, initialBalance }),
    raw: true,
  });

const balanceOf = async ({ id }: { id: string }) => (await helpers.getAccount({ id, raw: true })).currentBalance;

/** A base-currency account linked to the card, and a token. */
const setUp = async () => {
  const main = await account({ name: 'Main' });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: main.id }, raw: true });

  return { main, secret: (await ingestHelpers.createTestIngestToken()).secret };
};

let sequence = 0;

/** A Wallet notification: the card, the merchant and the amount. The amount differs per call by default. */
const wallet = ({ secret, body, card = CARD, time }: { secret: string; body?: string; card?: string; time?: string }) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'Wallet',
      title: card,
      subtitle: 'Wolt',
      body: body ?? `${BASE} ${(10 + ++sequence).toFixed(2)}`,
      ...(time && { time }),
      idempotencyKey: `wallet-${randomUUID()}`,
    },
  });

const inboxThreads = async (): Promise<ChatThread[]> =>
  (await helpers.listChatThreads({ raw: true })).threads.filter((thread) => thread.kind === 'automationInbox');

const inboxCards = async ({ toolName }: { toolName?: string } = {}): Promise<ChatProposalCard[]> => {
  const cards: ChatProposalCard[] = [];
  for (const thread of await inboxThreads()) {
    const page = await helpers.getChatThread({ threadId: thread.id, limit: 100, raw: true });
    cards.push(...Object.values(page.cards));
  }

  return toolName ? cards.filter((card) => card.toolName === toolName) : cards;
};

/** The inbox is filled by event listeners after the answer went out, so a test waits for its cards. */
const waitForCards = async ({
  toolName,
  count = 1,
  status = 'pending',
}: {
  toolName: string;
  count?: number;
  status?: ChatProposalStatus;
}): Promise<ChatProposalCard[]> => {
  await until(async () => (await inboxCards({ toolName })).filter((card) => card.status === status).length >= count, {
    timeout: 20_000,
    interval: 150,
  });

  return (await inboxCards({ toolName })).filter((card) => card.status === status);
};

const waitForCard = async (params: { toolName: string; status?: ChatProposalStatus }): Promise<ChatProposalCard> =>
  (await waitForCards({ ...params, count: 1 }))[0]!;

const cardById = async ({ id }: { id: string }) => helpers.getChatProposal({ proposalId: id, raw: true });

const approve = ({ card, confirmation }: { card: ChatProposalCard; confirmation?: string }) =>
  helpers.approveChatProposal({
    proposalId: card.id,
    payload: { revision: card.revision, ...(confirmation && { confirmation }) },
  });

const fieldOf = ({ card, path }: { card: ChatProposalCard; path: string }) =>
  card.fields.find((field) => field.path === path)?.value;

const unconfirmedIds = async () =>
  (await helpers.listUnconfirmedCardPayments({ raw: true })).map((entry) => entry.transactionId);

const storedProposal = (id: string) => ChatProposals.findByPk(id);

const TRANSFER_NATURE_COMMON = TRANSACTION_TRANSFER_NATURE.common_transfer;

interface SeedCard {
  status: ChatProposalStatus;
  expiresAt?: Date;
  toolName?: string;
  args?: Record<string, unknown>;
}

/** One message and its card, written directly: lifecycle cases need states no flow reaches quickly. */
const seedCard = async ({ thread, userId, card }: { thread: ChatThreads; userId: number; card: SeedCard }) => {
  const proposalId = randomUUID();
  const args = card.args ?? { sourceId: randomUUID(), mode: 'approved' };
  const message = await ChatMessages.create({
    threadId: thread.id,
    userId,
    role: 'assistant',
    status: 'complete',
    parts: [{ type: 'proposal', id: randomUUID(), proposalId }],
  });

  return ChatProposals.create({
    id: proposalId,
    threadId: thread.id,
    messageId: message.id,
    userId,
    toolName: card.toolName ?? SET_SOURCE,
    proposedArgs: args,
    args,
    cardKind: 'update',
    entity: 'notificationSource',
    status: card.status,
    expiresAt: card.expiresAt ?? new Date(Date.now() + 86_400_000),
  });
};

const answerFor = ({ prompt }: { prompt: string }) =>
  prompt.includes('Deposit Money: 778.50')
    ? {
        kind: 'credit' as const,
        amount: '778.50',
        currency: 'GEL',
        merchant: 'Deposit Money',
        cardName: 'TBC CARD',
      }
    : {
        kind: 'debit' as const,
        amount: '300.00',
        currency: 'USD',
        merchant: 'Money Transfer',
        cardName: 'TBC CARD',
      };

const threadOf = async ({ id }: { id: string }) => (await ChatThreads.findByPk(id))!;

const becomeReadOnly = () => helpers.setUserBilling({ trialEndsAt: new Date(Date.now() - 86_400_000) });

describe('Automation inbox', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    notificationTimings.categorizeWaitMs = 50;
    notificationTimings.retryBackoffMs = 10;
    await resetLimits();
  });

  afterEach(async () => {
    Object.assign(notificationTimings, DEFAULT_TIMINGS);
    Object.assign(inboxConfig, DEFAULT_INBOX_CONFIG);
    await helpers.clearExchangeRatesForDates({ dates: SEEDED_DATES.splice(0) });
    await resetLimits();
  });

  describe('the confirm card of a logged payment', () => {
    it('posts one card per payment in a pinned system thread, without any AI connection', async () => {
      const { main, secret } = await setUp();

      const res = await wallet({ secret, body: `${BASE} 43.60` });
      expect(res.body.response.outcome).toBe('logged');

      const card = await waitForCard({ toolName: CONFIRM });
      const [thread] = await inboxThreads();

      expect(thread).toMatchObject({
        kind: 'automationInbox',
        inboxState: 'live',
        pinned: true,
        title: 'Automation inbox',
        expiresAt: null,
        connectionId: null,
      });
      expect(card).toMatchObject({ status: 'pending', toolName: CONFIRM, canApply: { ok: true } });
      expect(fieldOf({ card, path: 'accountId' })).toBe(main.id);
      expect(fieldOf({ card, path: 'amount' })).toBe(43.6);
      // Thirty days, not the assistant's day.
      const lifetimeDays = (new Date(card.expiresAt).getTime() - new Date(card.createdAt).getTime()) / 86_400_000;
      expect(Math.round(lifetimeDays)).toBe(30);

      const page = await helpers.getChatThread({ threadId: thread!.id, raw: true });
      expect(page.messages).toHaveLength(1);
      expect(page.messages[0]).toMatchObject({ role: 'assistant', status: 'complete' });
      expect(page.messages[0]!.parts).toEqual([{ type: 'proposal', id: expect.any(String), proposalId: card.id }]);
    });

    it('confirms the payment on approve and leaves it as it was logged', async () => {
      const { main, secret } = await setUp();
      const res = await wallet({ secret, body: `${BASE} 43.60` });
      const card = await waitForCard({ toolName: CONFIRM });
      const transactionId = (await IngestRequests.findByPk(res.body.response.requestId))!.transactionId!;
      expect(await unconfirmedIds()).toEqual([transactionId]);

      const approved = await approve({ card });

      expect(approved.statusCode).toBe(200);
      expect(approved.body.response.card.status).toBe('applied');
      expect(await unconfirmedIds()).toEqual([]);
      expect(await balanceOf({ id: main.id })).toBe(1000 - 43.6);
      expect(await Transactions.count()).toBe(1);
    });

    it('applies only the account, amount, payee and category the owner changed on the card', async () => {
      const { main, secret } = await setUp();
      const other = await account({ name: 'Other' });
      const dining = await helpers.addCustomCategory({ name: 'Dining', color: '#336699', raw: true });
      const payee = await helpers.createPayee({ payload: { name: 'Corner cafe' }, raw: true });
      const res = await wallet({ secret, body: `${BASE} 43.60` });
      const card = await waitForCard({ toolName: CONFIRM });
      const transactionId = (await IngestRequests.findByPk(res.body.response.requestId))!.transactionId!;

      const edited = await helpers.editChatProposal({
        proposalId: card.id,
        payload: {
          revision: card.revision,
          args: {
            ...card.fields.reduce((acc, field) => ({ ...acc, [field.path]: field.value }), {}),
            accountId: other.id,
            amount: 50,
            payeeId: payee.id,
            categoryId: dining.id,
          },
        },
        raw: true,
      });
      const approved = await approve({ card: edited });

      expect(approved.statusCode).toBe(200);
      expect(await Transactions.findByPk(transactionId)).toMatchObject({
        accountId: other.id,
        payeeId: payee.id,
        categoryId: dining.id,
      });
      expect((await Transactions.findByPk(transactionId))!.amount.toNumber()).toBe(50);
      expect(await balanceOf({ id: other.id })).toBe(950);
      expect(await balanceOf({ id: main.id })).toBe(1000);
      expect(await unconfirmedIds()).toEqual([]);
    });

    it('deletes the payment on reject and gives the balance back', async () => {
      const { main, secret } = await setUp();
      await wallet({ secret, body: `${BASE} 43.60` });
      const card = await waitForCard({ toolName: CONFIRM });
      expect(await balanceOf({ id: main.id })).toBe(1000 - 43.6);

      const rejected = await helpers.rejectChatProposal({ proposalId: card.id });

      expect(rejected.statusCode).toBe(200);
      expect(rejected.body.response.card).toMatchObject({ status: 'rejected' });
      expect(await Transactions.count()).toBe(0);
      expect(await balanceOf({ id: main.id })).toBe(1000);
    });

    it('refuses the reject while a base-currency change holds the lock, and keeps both the card and the payment', async () => {
      const { secret } = await setUp();
      await wallet({ secret, body: `${BASE} 43.60` });
      const card = await waitForCard({ toolName: CONFIRM });
      const user = await helpers.getUserInfo({ raw: true });

      await redisClient.set(buildLockKey(user.id), 'test', 'EX', 30);
      try {
        const rejected = await helpers.rejectChatProposal({ proposalId: card.id });
        expect(rejected.statusCode).toBe(ERROR_CODES.Locked);
      } finally {
        await redisClient.del(buildLockKey(user.id));
      }

      expect((await cardById({ id: card.id })).status).toBe('pending');
      expect(await Transactions.count()).toBe(1);
    });

    it('updates the card of the first source when a second source of the payment arrives, and adds no second card', async () => {
      await helpers.addUserCurrencies({ currencyCodes: ['GEL'] });
      const noon = await seedRateDay();
      const gel = await account({ name: 'TBC GEL', currencyCode: 'GEL' });
      await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: gel.id }, raw: true });
      const { secret } = await ingestHelpers.createTestIngestToken();

      const tap = await ingestHelpers.postCardPayment({
        secret,
        body: {
          ...woltOnlinePayment.tap,
          source: 'apple-pay',
          time: new Date(noon.getTime() + 3000).toISOString(),
          idempotencyKey: `tap-${randomUUID()}`,
        },
      });
      expect(tap.body.response.outcome).toBe('logged');
      const first = await waitForCard({ toolName: CONFIRM });

      const second = await wallet({ secret, card: CARD, body: 'GEL 29.41', time: noon.toISOString() });
      expect(second.body.response.outcome).toBe('attached');

      await until(async () => (await cardById({ id: first.id })).revision > first.revision, {
        timeout: 20_000,
        interval: 150,
      });
      expect(await Transactions.count()).toBe(1);
      const cards = await inboxCards({ toolName: CONFIRM });
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ id: first.id, status: 'pending' });
    });

    describe('the short-balance correction', () => {
      /** The owner's multi-currency card: GEL is the default account with a short balance, USD holds the money. */
      const setUpShortCard = async () => {
        await helpers.addUserCurrencies({ currencyCodes: ['GEL', 'USD'] });
        const noon = await seedRateDay();
        const gel = await account({ name: 'TBC GEL', currencyCode: 'GEL', initialBalance: 10 });
        const usd = await account({ name: 'TBC USD', currencyCode: 'USD', initialBalance: 500 });
        await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: gel.id }, raw: true });
        await helpers.createCardMapping({
          payload: { cardLabel: CARD, accountId: usd.id, currencyCode: 'USD' },
          raw: true,
        });
        const { secret } = await ingestHelpers.createTestIngestToken();
        await wallet({ secret, card: CARD, body: woltOnlinePayment.wallet.body, time: noon.toISOString() });
        const card = await waitForCard({ toolName: CONFIRM });

        return { gel, usd, card: card! };
      };

      it('is part of the one card: the suggested account and its estimate come pre-filled', async () => {
        const { usd, card } = await setUpShortCard();

        expect(fieldOf({ card, path: 'accountId' })).toBe(usd.id);
        expect(fieldOf({ card, path: 'amount' })).toBe(14.7);
        expect(card.warnings).toEqual([
          { key: 'chat.warnings.ingestEstimate', params: { amount: 14.7, currencyCode: 'USD' } },
        ]);
        expect(await inboxCards({ toolName: CONFIRM })).toHaveLength(1);
      });

      it('moves the payment to the suggested account on approve and confirms it', async () => {
        const { gel, usd, card } = await setUpShortCard();
        expect(await balanceOf({ id: gel.id })).toBe(10 - 29.41);

        const approved = await approve({ card });

        expect(approved.statusCode).toBe(200);
        const tx = (await Transactions.findOne({ where: { accountId: usd.id } }))!;
        expect(tx.amount.toNumber()).toBe(14.7);
        expect(tx.originalCurrencyCode).toBe('GEL');
        expect(tx.originalAmount!.toNumber()).toBe(29.41);
        expect(await balanceOf({ id: gel.id })).toBe(10);
        expect(await balanceOf({ id: usd.id })).toBe(500 - 14.7);
        expect(await unconfirmedIds()).toEqual([]);
      });

      it('keeps the payment where it was logged when the owner picks that account on the card', async () => {
        const { gel, card } = await setUpShortCard();

        const edited = await helpers.editChatProposal({
          proposalId: card.id,
          payload: {
            revision: card.revision,
            args: {
              ...card.fields.reduce((acc, field) => ({ ...acc, [field.path]: field.value }), {}),
              accountId: gel.id,
            },
          },
          raw: true,
        });
        const approved = await approve({ card: edited });

        expect(approved.statusCode).toBe(200);
        expect((await Transactions.findOne())!.accountId).toBe(gel.id);
        expect(await balanceOf({ id: gel.id })).toBe(10 - 29.41);
        expect(await unconfirmedIds()).toEqual([]);
      });
    });
  });

  describe('a payment settled somewhere else', () => {
    const loggedWithCard = async () => {
      const { main, secret } = await setUp();
      const res = await wallet({ secret, body: `${BASE} 43.60` });
      const card = await waitForCard({ toolName: CONFIRM });
      const transactionId = (await IngestRequests.findByPk(res.body.response.requestId))!.transactionId!;

      return { main, secret, card: card, transactionId };
    };

    it('closes the card as resolvedElsewhere and confirms the row when the owner edits it', async () => {
      const { card, transactionId } = await loggedWithCard();

      const edited = await helpers.updateTransaction({ id: transactionId, payload: { note: 'Lunch' }, raw: true });
      expect(edited[0]!.note).toBe('Lunch');

      const closed = await cardById({ id: card.id });
      expect(closed.status).toBe('rejected');
      expect((await storedProposal(card.id))!.statusReason).toBe('resolvedElsewhere');
      expect(await unconfirmedIds()).toEqual([]);
    });

    it('closes the card when the owner deletes the payment', async () => {
      const { card, transactionId } = await loggedWithCard();

      await helpers.deleteTransaction({ id: transactionId });

      expect((await storedProposal(card.id))!).toMatchObject({ status: 'rejected', statusReason: 'resolvedElsewhere' });
    });

    it('closes the card of a row that Reconciliation hides', async () => {
      const { card, transactionId } = await loggedWithCard();

      const removed = await helpers.reconciliationRemove({ transactionIds: [transactionId], raw: true });

      expect(removed.removedIds).toEqual([transactionId]);
      expect(await storedProposal(card.id)).toMatchObject({ status: 'rejected', statusReason: 'resolvedElsewhere' });
    });

    it('closes the cards of both rows of a merge and confirms the survivor', async () => {
      const { secret, card, transactionId } = await loggedWithCard();
      const second = await wallet({ secret, body: `${BASE} 43.60` });
      const otherTx = (await IngestRequests.findByPk(second.body.response.requestId))!;
      await until(async () => (await inboxCards({ toolName: CONFIRM })).length === 2, {
        timeout: 20_000,
        interval: 150,
      });
      const otherCard = (await inboxCards({ toolName: CONFIRM })).find((entry) => entry.id !== card.id)!;
      expect(otherTx.transactionId).not.toBe(transactionId);

      await helpers.reconciliationMerge({
        transactionIds: [transactionId, otherTx.transactionId!],
        survivorId: transactionId,
        raw: true,
      });

      expect(await storedProposal(card.id)).toMatchObject({ status: 'rejected', statusReason: 'resolvedElsewhere' });
      expect(await storedProposal(otherCard.id)).toMatchObject({
        status: 'rejected',
        statusReason: 'resolvedElsewhere',
      });
      expect(await unconfirmedIds()).toEqual([]);
    });
  });

  describe('the card of a parked payment', () => {
    /** A payment from a card the owner never linked: it waits, and the inbox asks which account it belongs to. */
    const parkOnUnknownCard = async () => {
      const main = await account({ name: 'Main' });
      const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };
      const res = await wallet({ secret, card: 'Unlinked Mastercard', body: `${BASE} 43.60` });
      expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownAccount' });
      const card = await waitForCard({ toolName: LOG_REQUEST });
      const requestId = res.body.response.requestId as RecordId;

      return { main, secret, card: card, requestId };
    };

    it('shows the request, with the only account in the payment currency pre-filled', async () => {
      const { main, card, requestId } = await parkOnUnknownCard();

      expect(card).toMatchObject({ toolName: LOG_REQUEST, entity: 'ingestRequest', status: 'pending' });
      expect(fieldOf({ card, path: 'requestId' })).toBe(requestId);
      expect(fieldOf({ card, path: 'accountId' })).toBe(main.id);
      expect(fieldOf({ card, path: 'direction' })).toBe('debit');
      expect((await IngestRequests.findByPk(requestId))!.proposalId).toBe(card.id);

      const stored = (await storedProposal(card.id))!;
      expect(stored.preview!.before).toMatchObject({ reason: 'unknownAccount', name: 'Wolt', amount: 43.6 });
    });

    it('logs the payment on the account the owner picked when the card is approved', async () => {
      const { card, requestId } = await parkOnUnknownCard();
      const second = await account({ name: 'Second' });
      const edited = await helpers.editChatProposal({
        proposalId: card.id,
        payload: {
          revision: card.revision,
          args: {
            ...card.fields.reduce((acc, field) => ({ ...acc, [field.path]: field.value }), {}),
            accountId: second.id,
          },
        },
        raw: true,
      });

      const approved = await approve({ card: edited });

      expect(approved.statusCode).toBe(200);
      expect(approved.body.response.card.status).toBe('applied');
      await until(async () => (await IngestRequests.findByPk(requestId))!.status === 'logged', {
        timeout: 20_000,
        interval: 150,
      });
      const tx = (await Transactions.findByPk((await IngestRequests.findByPk(requestId))!.transactionId!))!;
      expect(tx.accountId).toBe(second.id);
      expect(await balanceOf({ id: second.id })).toBe(1000 - 43.6);
    });

    it('refuses to approve a request whose account is unknown and not chosen', async () => {
      const { card, requestId } = await parkOnUnknownCard();
      await account({ name: 'Second' });
      const stripped = await helpers.editChatProposal({
        proposalId: card.id,
        payload: { revision: card.revision, args: { requestId } },
        raw: true,
      });

      const approved = await approve({ card: stripped });

      expect(approved.statusCode).toBeGreaterThanOrEqual(400);
      expect((await IngestRequests.findByPk(requestId))!.status).toBe('parked');
      expect(await Transactions.count()).toBe(0);
    });

    it('dismisses the request when the card is rejected', async () => {
      const { card, requestId } = await parkOnUnknownCard();

      const rejected = await helpers.rejectChatProposal({ proposalId: card.id });

      expect(rejected.statusCode).toBe(200);
      expect((await IngestRequests.findByPk(requestId))!.status).toBe('dismissed');
      expect(await Transactions.count()).toBe(0);
    });

    it('closes the card as resolvedElsewhere when the request is dismissed from the waiting list', async () => {
      const { card, requestId } = await parkOnUnknownCard();

      await helpers.dismissCardPaymentRequest({ id: requestId });

      expect(await storedProposal(card.id)).toMatchObject({ status: 'rejected', statusReason: 'resolvedElsewhere' });
    });

    it('closes the card as resolvedElsewhere when the payment is logged from the waiting list', async () => {
      const { main, card, requestId } = await parkOnUnknownCard();
      await helpers.createCardMapping({ payload: { cardLabel: 'Unlinked Mastercard', accountId: main.id }, raw: true });

      const retried = await helpers.retryCardPaymentRequest({ id: requestId, raw: true });

      expect(retried.outcome).toBe('logged');
      expect(await storedProposal(card.id)).toMatchObject({ status: 'rejected', statusReason: 'resolvedElsewhere' });
    });
  });

  describe('the card of a source waiting for approval', () => {
    const notification = ({ app, body }: { app: string; body?: string }) => ({
      kind: 'notification',
      app,
      title: app,
      subtitle: '',
      body: body ?? `Purchase ${BASE} 12.50 at SHOP`,
      idempotencyKey: `push-${randomUUID()}`,
    });

    const parkOnNewSource = async ({ app = 'Cashly' }: { app?: string } = {}) => {
      const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };
      const res = await ingestHelpers.postIngestEvent({ secret, body: notification({ app }) });
      expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'sourceNotApproved' });
      const source = (await NotificationSources.findOne({ where: { appName: app } }))!;
      await until(async () => Boolean((await NotificationSources.findByPk(source.id))!.proposalId), {
        timeout: 20_000,
        interval: 150,
      });

      return { secret, source: (await NotificationSources.findByPk(source.id))! };
    };

    it('posts one card per source however many notifications it sent, and never shows the message', async () => {
      const { secret, source } = await parkOnNewSource();
      await ingestHelpers.postIngestEvent({ secret, body: notification({ app: 'Cashly' }) });
      await helpers.sleep(500);

      const cards = await waitForCards({ toolName: SET_SOURCE });
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ entity: 'notificationSource', status: 'pending' });
      expect(fieldOf({ card: cards[0]!, path: 'sourceId' })).toBe(source.id);
      expect(source.proposalId).toBe(cards[0]!.id);

      const stored = (await storedProposal(cards[0]!.id))!;
      expect(stored.preview!.before).toMatchObject({ name: 'Cashly', mode: 'pending' });
      expect(String((stored.preview!.before as { amountSeen: string }).amountSeen)).toContain('12.50');
      expect(JSON.stringify(stored)).not.toContain('SHOP');
    });

    it('approves the source and processes what it held, on the default account the owner set on the card', async () => {
      enableServerModel();
      mockNotificationParsing({
        answer: () => ({ kind: 'debit', amount: '12.50', currency: BASE, merchant: 'SHOP' }),
      });
      const main = await account({ name: 'Main' });
      const { source } = await parkOnNewSource();
      const card = await waitForCard({ toolName: SET_SOURCE });
      const edited = await helpers.editChatProposal({
        proposalId: card.id,
        payload: {
          revision: card.revision,
          args: { sourceId: source.id, mode: 'approved', defaultAccountId: main.id },
        },
        raw: true,
      });

      const approved = await approve({ card: edited });

      expect(approved.statusCode).toBe(200);
      expect(await NotificationSources.findByPk(source.id)).toMatchObject({
        mode: 'approved',
        defaultAccountId: main.id,
      });
      await until(async () => (await Transactions.count()) === 1, { timeout: 20_000, interval: 150 });
      expect((await Transactions.findOne())!.accountId).toBe(main.id);
    });

    it('mutes the source and deletes what it held when the card is rejected', async () => {
      const { source } = await parkOnNewSource();
      const card = await waitForCard({ toolName: SET_SOURCE });

      const rejected = await helpers.rejectChatProposal({ proposalId: card.id });

      expect(rejected.statusCode).toBe(200);
      expect((await NotificationSources.findByPk(source.id))!.mode).toBe('muted');
      expect(await IngestRequests.count({ where: { sourceId: source.id } })).toBe(0);
    });

    it('closes the card as resolvedElsewhere when the source is approved on the settings page', async () => {
      const { source } = await parkOnNewSource();
      const card = await waitForCard({ toolName: SET_SOURCE });

      await helpers.updateNotificationSource({ id: source.id, payload: { mode: 'muted' }, raw: true });

      expect(await storedProposal(card.id)).toMatchObject({ status: 'rejected', statusReason: 'resolvedElsewhere' });
    });

    it('closes the card as resolvedElsewhere when the source is forgotten', async () => {
      const { source } = await parkOnNewSource();
      const card = await waitForCard({ toolName: SET_SOURCE });

      await helpers.deleteNotificationSource({ id: source.id });

      expect(await storedProposal(card.id)).toMatchObject({ status: 'rejected', statusReason: 'resolvedElsewhere' });
    });
  });

  describe('the card of a duplicate suggestion', () => {
    const JUDGED = {
      judge: () => ({ matches: [{ id: 'c1', confidence: 0.95, reason: 'Same shop and amount, a minute apart.' }] }),
    };

    /** A GEL account linked to the card, a hand-typed row and a Wallet payment the judge calls its duplicate. */
    const raiseSuggestion = async () => {
      enableServerModel();
      mockNotificationParsing({ answer: () => ({}), ...JUDGED });
      await helpers.addUserCurrencies({ currencyCodes: ['GEL'] });
      const noon = await seedRateDay();
      const gel = await account({ name: 'TBC GEL', currencyCode: 'GEL' });
      await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: gel.id }, raw: true });
      const { secret } = await ingestHelpers.createTestIngestToken();
      const [typed] = await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: gel.id,
          amount: 29.41,
          time: new Date(noon.getTime() - 60_000).toISOString(),
        }),
        raw: true,
      });

      const res = await wallet({ secret, card: CARD, body: woltOnlinePayment.wallet.body, time: noon.toISOString() });
      expect(res.body.response.outcome).toBe('logged');
      const card = await waitForCard({ toolName: MERGE });
      const [suggestion] = await helpers.listDuplicateSuggestions({ raw: true });
      const requestRow = (await IngestRequests.findByPk(res.body.response.requestId))!;

      return {
        gel,
        typedId: typed!.id as RecordId,
        ingestId: requestRow.transactionId!,
        card: card,
        suggestion: suggestion!,
      };
    };

    it('offers the merge with the survivor the dedup rules chose, and never merges on its own', async () => {
      const { typedId, ingestId, card, suggestion } = await raiseSuggestion();

      expect(card).toMatchObject({ toolName: MERGE, status: 'pending' });
      expect(fieldOf({ card, path: 'survivorId' })).toBe(typedId);
      expect((fieldOf({ card, path: 'transactionIds' }) as string[]).toSorted()).toEqual(
        [typedId, ingestId].toSorted(),
      );
      expect((await DuplicateSuggestions.findByPk(suggestion.id))!.proposalId).toBe(card.id);
      expect(await Transactions.count()).toBe(2);
    });

    it('merges when the card is approved and settles the suggestion and the confirm card of the removed row', async () => {
      const { ingestId, card, suggestion } = await raiseSuggestion();
      const confirm = await waitForCard({ toolName: CONFIRM });

      const approved = await approve({ card, confirmation: card.confirmation.phrase });

      expect(approved.statusCode).toBe(200);
      expect(approved.body.response.card.status).toBe('applied');
      expect((await DuplicateSuggestions.findByPk(suggestion.id))!.status).toBe('merged');
      expect(await Transactions.count()).toBe(1);
      expect(await Transactions.findByPk(ingestId)).toBeNull();
      expect(await storedProposal(confirm.id)).toMatchObject({ status: 'rejected', statusReason: 'resolvedElsewhere' });
    });

    it('dismisses the suggestion for good when the card is rejected', async () => {
      const { card, suggestion } = await raiseSuggestion();

      const rejected = await helpers.rejectChatProposal({ proposalId: card.id });

      expect(rejected.statusCode).toBe(200);
      expect((await DuplicateSuggestions.findByPk(suggestion.id))!.status).toBe('dismissed');
      expect(await Transactions.count()).toBe(2);
    });

    it('closes the card as resolvedElsewhere when the pair is dismissed in Reconciliation', async () => {
      const { card, suggestion } = await raiseSuggestion();

      await helpers.dismissDuplicateSuggestion({ id: suggestion.id });

      expect(await storedProposal(card.id)).toMatchObject({ status: 'rejected', statusReason: 'resolvedElsewhere' });
    });

    it('closes the card as resolvedElsewhere when one row of the pair is merged elsewhere', async () => {
      const { typedId, ingestId, card } = await raiseSuggestion();

      await helpers.reconciliationMerge({ transactionIds: [typedId, ingestId], survivorId: typedId, raw: true });

      expect(await storedProposal(card.id)).toMatchObject({ status: 'rejected', statusReason: 'resolvedElsewhere' });
    });
  });

  describe('the card of a currency-conversion pair', () => {
    const TRANSFER_OUT = 'Money Transfer: 300.00 USD\nTBC CARD\n20/10/2026';
    const DEPOSIT_IN = 'Deposit Money: 778.50 GEL\nTBC CARD\n20/10/2026';
    const raisePair = async () => {
      enableServerModel();
      mockNotificationParsing({ answer: answerFor });
      await helpers.addUserCurrencies({ currencyCodes: ['GEL', 'USD'] });
      const day = subDays(startOfDay(new Date()), 6);
      SEEDED_DATES.push(day);
      await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { AED: 4, GEL: 2.6 } });
      const gel = await account({ name: 'TBC GEL', currencyCode: 'GEL' });
      const usd = await account({ name: 'TBC USD', currencyCode: 'USD' });
      await helpers.createCardMapping({ payload: { cardLabel: 'TBC CARD', accountId: gel.id }, raw: true });
      await helpers.createCardMapping({
        payload: { cardLabel: 'TBC CARD', accountId: usd.id, currencyCode: 'USD' },
        raw: true,
      });
      const { secret } = await ingestHelpers.createTestIngestToken();
      const start = addMinutes(day, 14 * 60);
      const push = (minutes: number, body: string) =>
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
      await push(0, TRANSFER_OUT);
      await push(6, DEPOSIT_IN);
      const card = await waitForCard({ toolName: LINK });
      const expense = (await Transactions.findOne({ where: { accountId: usd.id } }))!;
      const income = (await Transactions.findOne({ where: { accountId: gel.id } }))!;

      return { card: card, expense, income };
    };

    it('asks once, for the pair, whichever leg arrived last', async () => {
      const { card, expense, income } = await raisePair();

      expect(card).toMatchObject({ toolName: LINK, status: 'pending' });
      expect(fieldOf({ card, path: 'baseTxId' })).toBe(expense.id);
      expect(fieldOf({ card, path: 'oppositeTxId' })).toBe(income.id);
      expect(await inboxCards({ toolName: LINK })).toHaveLength(1);
    });

    it('links the legs as a transfer on approve and answers the confirm cards of both', async () => {
      const { card, expense, income } = await raisePair();

      const approved = await approve({ card });

      expect(approved.statusCode).toBe(200);
      for (const id of [expense.id, income.id]) {
        expect((await Transactions.findByPk(id))!.transferNature).toBe(TRANSFER_NATURE_COMMON);
      }
      await until(async () => (await inboxCards({ toolName: CONFIRM })).every((entry) => entry.status !== 'pending'), {
        timeout: 20_000,
        interval: 150,
      });
      expect(await unconfirmedIds()).toEqual([]);
    });

    it('remembers the pair as not a transfer when the card is rejected', async () => {
      const { card, expense, income } = await raisePair();

      const rejected = await helpers.rejectChatProposal({ proposalId: card.id });

      expect(rejected.statusCode).toBe(200);
      const userId = expense.userId;
      expect(await getDismissalsForUser({ userId })).toEqual([
        expect.objectContaining({ expenseTransactionId: expense.id, incomeTransactionId: income.id }),
      ]);
    });

    it('closes the card as resolvedElsewhere when the pair is linked on the transactions page', async () => {
      const { card, expense, income } = await raisePair();

      await helpers.linkTransactions({ payload: { ids: [[expense.id, income.id]] }, raw: true });

      expect(await storedProposal(card.id)).toMatchObject({ status: 'rejected', statusReason: 'resolvedElsewhere' });
    });

    it('closes the card as resolvedElsewhere when the pair is dismissed on the transactions page', async () => {
      const { card, expense, income } = await raisePair();

      await helpers.dismissTransferSuggestion({
        expenseTransactionId: expense.id,
        incomeTransactionId: income.id,
        raw: true,
      });

      expect(await storedProposal(card.id)).toMatchObject({ status: 'rejected', statusReason: 'resolvedElsewhere' });
    });
  });

  describe('the thread', () => {
    /** An inbox thread with the given cards, written directly: lifecycle cases need states no flow reaches quickly. */
    const seedInboxThread = async ({
      state = 'live',
      cards = [],
      createdAt,
    }: {
      state?: 'live' | 'open' | 'closed';
      cards?: SeedCard[];
      createdAt?: Date;
    } = {}) => {
      const { id: userId } = await helpers.getUserInfo({ raw: true });
      const thread = await ChatThreads.create({
        userId,
        title: 'Automation inbox',
        titleSource: 'model',
        pinned: state !== 'closed',
        kind: 'automationInbox',
        inboxState: state,
        lastMessageAt: new Date(),
        expiresAt: null,
        ...(createdAt && { createdAt }),
      });

      const proposals: ChatProposals[] = [];
      for (const card of cards) {
        proposals.push(await seedCard({ thread, userId, card }));
      }

      return { thread, proposals, userId };
    };

    describe('no assistant', () => {
      it('refuses a message with 409', async () => {
        const { thread } = await seedInboxThread({ cards: [{ status: 'pending' }] });

        const sent = await helpers.sendChatMessage({ threadId: thread.id, payload: { text: 'Hello' } });

        expect(sent.statusCode).toBe(ERROR_CODES.ConflictError);
      });

      it('refuses a comment on a card with 409', async () => {
        const { proposals } = await seedInboxThread({ cards: [{ status: 'pending' }] });

        const commented = await helpers.commentOnChatProposal({ proposalId: proposals[0]!.id, text: 'Why?' });

        expect(commented.statusCode).toBe(ERROR_CODES.ConflictError);
      });
    });

    describe('one live thread', () => {
      const parkNewSource = ({ secret, app }: { secret: string; app: string }) =>
        ingestHelpers.postIngestEvent({
          secret,
          body: {
            kind: 'notification',
            app,
            title: app,
            subtitle: '',
            body: `Purchase ${BASE} 12.50 at SHOP`,
            idempotencyKey: `push-${randomUUID()}`,
          },
        });

      it('holds both cards when two items arrive together and there is no live thread yet', async () => {
        const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };

        await Promise.all([parkNewSource({ secret, app: 'Cashly' }), parkNewSource({ secret, app: 'Paymo' })]);
        await waitForCards({ toolName: SET_SOURCE, count: 2 });

        const threads = await inboxThreads();
        expect(threads).toHaveLength(1);
        expect(threads[0]).toMatchObject({ inboxState: 'live', pinned: true });
        expect(await ChatThreads.count({ where: { kind: 'automationInbox', inboxState: 'live' } })).toBe(1);
        expect(await inboxCards({ toolName: SET_SOURCE })).toHaveLength(2);
      });

      it('opens a full thread that still has pending cards, keeps it pinned, and starts a new live one', async () => {
        inboxConfig.maxCards = 2;
        const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };

        for (const app of ['Cashly', 'Paymo', 'Spendly']) {
          await parkNewSource({ secret, app });
          await until(
            async () => (await NotificationSources.findOne({ where: { appName: app } }))?.proposalId != null,
            {
              timeout: 20_000,
              interval: 150,
            },
          );
        }

        const threads = await ChatThreads.findAll({
          where: { kind: 'automationInbox' },
          order: [['createdAt', 'ASC']],
        });
        expect(threads.map((thread) => [thread.inboxState, thread.pinned])).toEqual([
          ['open', true],
          ['live', true],
        ]);
        expect(await ChatProposals.count({ where: { threadId: threads[0]!.id } })).toBe(2);
      });

      it('closes an open thread when its last pending card is resolved, unpins it, and then lets it be deleted', async () => {
        const { thread, proposals } = await seedInboxThread({
          state: 'open',
          cards: [{ status: 'pending' }, { status: 'pending' }],
        });

        await helpers.rejectChatProposal({ proposalId: proposals[0]!.id });
        expect(await threadOf({ id: thread.id })).toMatchObject({ inboxState: 'open', pinned: true });

        await helpers.rejectChatProposal({ proposalId: proposals[1]!.id });

        expect(await threadOf({ id: thread.id })).toMatchObject({ inboxState: 'closed', pinned: false });
        expect((await helpers.deleteChatThread({ threadId: thread.id })).statusCode).toBe(200);
      });

      it('closes an open thread whose last pending card expires, through the existing card expiry', async () => {
        const { thread } = await seedInboxThread({
          state: 'open',
          cards: [{ status: 'pending', expiresAt: new Date(Date.now() - 1000) }, { status: 'applied' }],
        });

        // Reading the thread expires the due card.
        const page = await helpers.getChatThread({ threadId: thread.id, raw: true });

        expect(
          Object.values(page.cards)
            .map((card) => card.status)
            .toSorted(),
        ).toEqual(['applied', 'expired']);
        expect(await threadOf({ id: thread.id })).toMatchObject({ inboxState: 'closed', pinned: false });
        expect((await helpers.deleteChatThread({ threadId: thread.id })).statusCode).toBe(200);
      });

      it('rolls an old live thread with nothing pending over to a new one', async () => {
        const { thread } = await seedInboxThread({
          state: 'live',
          cards: [{ status: 'applied' }],
          createdAt: new Date(Date.now() - 8 * 86_400_000),
        });
        const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };

        await parkNewSource({ secret, app: 'Cashly' });
        await waitForCards({ toolName: SET_SOURCE });

        expect(await threadOf({ id: thread.id })).toMatchObject({ inboxState: 'closed', pinned: false });
        const live = await ChatThreads.findAll({ where: { kind: 'automationInbox', inboxState: 'live' } });
        expect(live).toHaveLength(1);
        expect(live[0]!.id).not.toBe(thread.id);
      });
    });

    describe('protection', () => {
      it.each(['live', 'open'] as const)('refuses to delete or unpin a %s thread with 409', async (state) => {
        const { thread } = await seedInboxThread({ state, cards: [{ status: 'pending' }] });

        expect((await helpers.deleteChatThread({ threadId: thread.id })).statusCode).toBe(ERROR_CODES.ConflictError);
        expect((await helpers.updateChatThread({ threadId: thread.id, payload: { pinned: false } })).statusCode).toBe(
          ERROR_CODES.ConflictError,
        );
        expect(await ChatThreads.findByPk(thread.id)).not.toBeNull();
      });

      it('deletes a closed thread like any other', async () => {
        const { thread } = await seedInboxThread({ state: 'closed', cards: [{ status: 'rejected' }] });

        expect((await helpers.deleteChatThread({ threadId: thread.id })).statusCode).toBe(200);
        expect(await ChatThreads.findByPk(thread.id)).toBeNull();
      });
    });

    describe('Clear resolved', () => {
      it('deletes the messages of resolved cards and keeps the ones still waiting', async () => {
        const { thread, proposals } = await seedInboxThread({
          cards: [{ status: 'pending' }, { status: 'applied' }, { status: 'rejected' }, { status: 'stale' }],
        });

        const cleared = await helpers.clearResolvedChatThread({ threadId: thread.id });

        expect(cleared.statusCode).toBe(200);
        expect(cleared.body.response).toEqual({ deletedMessages: 2 });
        const left = await ChatProposals.findAll({ where: { threadId: thread.id }, order: [['createdAt', 'ASC']] });
        expect(left.map((card) => card.id)).toEqual([proposals[0]!.id, proposals[3]!.id]);
        expect(await ChatMessages.count({ where: { threadId: thread.id } })).toBe(2);
      });

      it('refuses a thread that is not the inbox', async () => {
        const chat = await helpers.createChatThread({ raw: true });

        expect((await helpers.clearResolvedChatThread({ threadId: chat.id })).statusCode).toBe(
          ERROR_CODES.ValidationError,
        );
      });
    });

    describe('Archive', () => {
      it('refuses while a card is pending with 409, and closes the thread once nothing is', async () => {
        const { thread, proposals } = await seedInboxThread({ cards: [{ status: 'pending' }, { status: 'applied' }] });

        const refused = await helpers.archiveChatThread({ threadId: thread.id });
        expect(refused.statusCode).toBe(ERROR_CODES.ConflictError);
        expect(await threadOf({ id: thread.id })).toMatchObject({ inboxState: 'live', pinned: true });

        await helpers.rejectChatProposal({ proposalId: proposals[0]!.id });
        const archived = await helpers.archiveChatThread({ threadId: thread.id });

        expect(archived.statusCode).toBe(200);
        expect(archived.body.response).toMatchObject({ inboxState: 'closed', pinned: false });
        expect(await threadOf({ id: thread.id })).toMatchObject({ inboxState: 'closed', pinned: false });
      });

      it('lets the next item open a new live thread', async () => {
        const { thread } = await seedInboxThread({ cards: [{ status: 'applied' }] });
        await helpers.archiveChatThread({ threadId: thread.id });
        const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };

        await ingestHelpers.postIngestEvent({
          secret,
          body: {
            kind: 'notification',
            app: 'Cashly',
            title: 'Cashly',
            subtitle: '',
            body: `Purchase ${BASE} 12.50 at SHOP`,
            idempotencyKey: `push-${randomUUID()}`,
          },
        });
        await waitForCards({ toolName: SET_SOURCE });

        const live = await ChatThreads.findAll({ where: { kind: 'automationInbox', inboxState: 'live' } });
        expect(live).toHaveLength(1);
        expect(live[0]!.id).not.toBe(thread.id);
      });

      it('refuses a thread that is not the inbox', async () => {
        const chat = await helpers.createChatThread({ raw: true });

        expect((await helpers.archiveChatThread({ threadId: chat.id })).statusCode).toBe(ERROR_CODES.ValidationError);
      });
    });
  });
});

describe('Automation inbox for a read-only user (lapsed plan)', () => {
  const seedThreadWith = async ({ cards }: { cards: SeedCard[] }) => {
    const { id: userId } = await helpers.getUserInfo({ raw: true });
    const thread = await ChatThreads.create({
      userId,
      title: 'Automation inbox',
      titleSource: 'model',
      pinned: true,
      kind: 'automationInbox',
      inboxState: 'live',
      lastMessageAt: new Date(),
      expiresAt: null,
    });
    const proposals: ChatProposals[] = [];
    for (const card of cards) {
      proposals.push(await seedCard({ thread, userId, card }));
    }

    return { thread, proposals };
  };

  it('can clear resolved items and archive the inbox', async () => {
    const { thread } = await seedThreadWith({ cards: [{ status: 'applied' }, { status: 'rejected' }] });
    await becomeReadOnly();

    const cleared = await helpers.clearResolvedChatThread({ threadId: thread.id });
    const archived = await helpers.archiveChatThread({ threadId: thread.id });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.body.response).toEqual({ deletedMessages: 2 });
    expect(archived.statusCode).toBe(200);
    expect(archived.body.response).toMatchObject({ inboxState: 'closed' });
  });

  it('cannot delete a payment by rejecting its confirm card (402), and the payment stays', async () => {
    const bankAccount = await helpers.createAccount({ raw: true });
    const [tx] = await helpers.createTransaction({
      payload: helpers.buildTransactionPayload({ accountId: bankAccount.id, amount: 20 }),
      raw: true,
    });
    await Transactions.update(
      { externalData: { ingest: { unconfirmed: true, requestId: randomUUID(), pipeline: 'notification' } } },
      { where: { id: tx!.id } },
    );
    const { proposals } = await seedThreadWith({
      cards: [{ status: 'pending', toolName: CONFIRM, args: { transactionId: tx!.id } }],
    });
    await becomeReadOnly();

    const rejected = await helpers.rejectChatProposal({ proposalId: proposals[0]!.id });

    expect(rejected.statusCode).toBe(402);
    expect(await Transactions.findByPk(tx!.id)).not.toBeNull();
    expect((await ChatProposals.findByPk(proposals[0]!.id))!.status).toBe('pending');
  });
});
