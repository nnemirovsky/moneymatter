import {
  ACCOUNT_STATUSES,
  TRANSACTION_TRANSFER_NATURE,
  type ChatProposalCard,
  type ChatProposalStatus,
  type ChatThread,
  type RecordId,
} from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import CardAccountMappings from '@models/card-account-mappings.model';
import ChatMessages from '@models/chat-messages.model';
import ChatProposals from '@models/chat-proposals.model';
import ChatThreads from '@models/chat-threads.model';
import { connection } from '@models/connection';
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
import { mockNotificationParsing, useAiOnlyNotificationParsing } from '@tests/helpers/notification-ai';
import { addMinutes, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

import { mergeInboxThreads } from '../../../migrations/utils/merge-inbox-threads-20261022';
import { inboxConfig } from './inbox-config';

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
const seedRateDay = async ({ eurPerUsd = 1 }: { eurPerUsd?: number } = {}) => {
  const day = subDays(startOfDay(new Date()), 6);
  SEEDED_DATES.push(day);
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { AED: 4, GEL: 2, EUR: eurPerUsd } });

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
  /** When the card's message was posted; now by default. */
  postedAt?: Date;
  /** When the owner (or the inbox) decided the card; unset on a waiting card. */
  decidedAt?: Date;
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

  if (card.postedAt) await backdateMessage({ id: message.id, createdAt: card.postedAt });

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
    decidedAt: card.decidedAt ?? null,
  });
};

/** `createdAt` is written by Sequelize on insert; a case about age moves it back afterwards. */
const backdateMessage = async ({ id, createdAt }: { id: string; createdAt: Date }) => {
  await connection.sequelize.query('UPDATE "ChatMessages" SET "createdAt" = :createdAt WHERE id = :id', {
    replacements: { id, createdAt },
  });
};

/** A notice in the inbox: a message with no card, which the inbox treats as a resolved item. */
const seedNotice = async ({ thread, userId, postedAt }: { thread: ChatThreads; userId: number; postedAt?: Date }) => {
  const message = await ChatMessages.create({
    threadId: thread.id,
    userId,
    role: 'assistant',
    status: 'complete',
    parts: [{ type: 'notice', id: randomUUID(), key: 'chat.inbox.notices.test', params: {} }],
  });
  if (postedAt) await backdateMessage({ id: message.id, createdAt: postedAt });

  return message;
};

const answerFor = ({ prompt }: { prompt: string }) =>
  prompt.includes('Deposit Money: 778.50')
    ? {
        kind: 'credit' as const,
        amount: '778.50',
        currency: 'GEL',
        merchant: 'Deposit Money',
        cardName: 'EXAMPLE CARD',
      }
    : {
        kind: 'debit' as const,
        amount: '300.00',
        currency: 'USD',
        merchant: 'Money Transfer',
        cardName: 'EXAMPLE CARD',
      };

const threadOf = async ({ id }: { id: string }) => (await ChatThreads.findByPk(id))!;

/** The statuses of a thread's cards, oldest decision first. */
const remainingStatuses = async ({ threadId }: { threadId: string }) =>
  (await ChatProposals.findAll({ where: { threadId }, order: [['decidedAt', 'ASC']] })).map((card) => card.status);

/** A thread as the list shows it, badge included. */
const listed = async ({ id }: { id: string }) =>
  (await helpers.listChatThreads({ raw: true })).threads.find((thread) => thread.id === id)!;

const becomeReadOnly = () => helpers.setUserBilling({ trialEndsAt: new Date(Date.now() - 86_400_000) });

describe('Automation inbox', () => {
  useSelfHostWithoutServerAiKeys();
  useAiOnlyNotificationParsing();

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
        // The waiting card is what the thread's badge counts.
        badgeCount: 1,
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

    it('refuses to move the payment to an archived account or a loan, and keeps it unconfirmed', async () => {
      const { main, secret } = await setUp();
      const res = await wallet({ secret, body: `${BASE} 43.60` });
      const card = await waitForCard({ toolName: CONFIRM });
      const transactionId = (await IngestRequests.findByPk(res.body.response.requestId))!.transactionId!;
      const archived = await account({ name: 'Archived' });
      await helpers.updateAccount({ id: archived.id, payload: { status: ACCOUNT_STATUSES.archived } });
      const loan = await helpers.createLoan({
        payload: helpers.buildCreateLoanPayload({ currencyCode: BASE }),
        raw: true,
      });

      for (const accountId of [archived.id, loan.id]) {
        const edited = await helpers.editChatProposal({
          proposalId: card.id,
          payload: {
            revision: (await cardById({ id: card.id })).revision,
            args: {
              ...card.fields.reduce((acc, field) => ({ ...acc, [field.path]: field.value }), {}),
              accountId,
            },
          },
          raw: true,
        });
        const approved = await approve({ card: edited });

        expect(approved.statusCode).toBe(ERROR_CODES.ValidationError);
      }
      expect((await Transactions.findOne({ where: { id: transactionId } }))!.accountId).toBe(main.id);
      expect(await unconfirmedIds()).toEqual([transactionId]);
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
      const gel = await account({ name: 'Example GEL', currencyCode: 'GEL' });
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
      const setUpShortCard = async ({ withEur = false }: { withEur?: boolean } = {}) => {
        await helpers.addUserCurrencies({ currencyCodes: ['GEL', 'USD', ...(withEur ? ['EUR'] : [])] });
        // With EUR at 1.6 per USD the EUR estimate (23.53) differs from the suggested USD one (14.7).
        const noon = await seedRateDay(withEur ? { eurPerUsd: 1.6 } : {});
        const gel = await account({ name: 'Example GEL', currencyCode: 'GEL', initialBalance: 10 });
        const usd = await account({ name: 'Example USD', currencyCode: 'USD', initialBalance: 500 });
        await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: gel.id }, raw: true });
        await helpers.createCardMapping({
          payload: { cardLabel: CARD, accountId: usd.id, currencyCode: 'USD' },
          raw: true,
        });
        const eur = withEur ? await account({ name: 'Example EUR', currencyCode: 'EUR', initialBalance: 100 }) : null;
        if (eur) {
          await helpers.createCardMapping({
            payload: { cardLabel: CARD, accountId: eur.id, currencyCode: 'EUR' },
            raw: true,
          });
        }
        const { secret } = await ingestHelpers.createTestIngestToken();
        await wallet({ secret, card: CARD, body: woltOnlinePayment.wallet.body, time: noon.toISOString() });
        const card = await waitForCard({ toolName: CONFIRM });

        return { gel, usd, eur: eur!, card: card! };
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
        expect((await Transactions.findOne())!.amount.toNumber()).toBe(29.41);
        expect(await balanceOf({ id: gel.id })).toBe(10 - 29.41);
        expect(await unconfirmedIds()).toEqual([]);
      });

      it('applies the amount the owner entered when keeping the account the payment was logged to', async () => {
        const { gel, card } = await setUpShortCard();

        const edited = await helpers.editChatProposal({
          proposalId: card.id,
          payload: {
            revision: card.revision,
            args: {
              ...card.fields.reduce((acc, field) => ({ ...acc, [field.path]: field.value }), {}),
              accountId: gel.id,
              amount: 30,
            },
          },
          raw: true,
        });
        const approved = await approve({ card: edited });

        expect(approved.statusCode).toBe(200);
        const tx = (await Transactions.findOne())!;
        expect(tx.accountId).toBe(gel.id);
        expect(tx.amount.toNumber()).toBe(30);
        expect(await balanceOf({ id: gel.id })).toBe(10 - 30);
        expect(await unconfirmedIds()).toEqual([]);
      });

      describe('picking another candidate on the card', () => {
        const editCard = ({ card, args }: { card: ChatProposalCard; args: Record<string, unknown> }) =>
          helpers.editChatProposal({
            proposalId: card.id,
            payload: {
              revision: card.revision,
              args: { ...card.fields.reduce((acc, field) => ({ ...acc, [field.path]: field.value }), {}), ...args },
            },
            raw: true,
          });

        it("books the chosen candidate's own estimate when the amount is left as pre-filled", async () => {
          const { usd, eur, card } = await setUpShortCard({ withEur: true });
          expect(fieldOf({ card, path: 'accountId' })).toBe(usd.id);
          expect(fieldOf({ card, path: 'amount' })).toBe(14.7);

          const approved = await approve({ card: await editCard({ card, args: { accountId: eur.id } }) });

          expect(approved.statusCode).toBe(200);
          const tx = (await Transactions.findOne())!;
          expect(tx.accountId).toBe(eur.id);
          expect(tx.amount.toNumber()).toBe(23.53);
          expect(await balanceOf({ id: eur.id })).toBe(100 - 23.53);
        });

        it('books the entered amount on the suggested account', async () => {
          const { usd, card } = await setUpShortCard({ withEur: true });

          const approved = await approve({ card: await editCard({ card, args: { amount: 14.5 } }) });

          expect(approved.statusCode).toBe(200);
          const tx = (await Transactions.findOne())!;
          expect(tx.accountId).toBe(usd.id);
          expect(tx.amount.toNumber()).toBe(14.5);
        });

        it('books the entered amount on the chosen candidate', async () => {
          const { eur, card } = await setUpShortCard({ withEur: true });

          const approved = await approve({ card: await editCard({ card, args: { accountId: eur.id, amount: 23 } }) });

          expect(approved.statusCode).toBe(200);
          const tx = (await Transactions.findOne())!;
          expect(tx.accountId).toBe(eur.id);
          expect(tx.amount.toNumber()).toBe(23);
        });
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
      // Another amount: the same text within seconds would fold into the first request.
      const second = await wallet({ secret, body: `${BASE} 44.60` });
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
      // Written behind the service: linking the card through it would log the payment by itself.
      await CardAccountMappings.create({
        userId: (await helpers.getUserInfo({ raw: true })).id,
        cardLabel: 'Unlinked Mastercard',
        normalizedLabel: 'unlinked mastercard',
        lastDigits: null,
        currencyCode: null,
        accountId: main.id,
      });

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

    it('names the source on the card, labels its row as the source and offers the three modes', async () => {
      const { source } = await parkOnNewSource({ app: 'Cashly' });
      const card = await waitForCard({ toolName: SET_SOURCE });

      expect(card.labels?.[`notificationSource:${source.id}`]).toBe('Cashly');
      const sourceField = card.fields.find((field) => field.path === 'sourceId')!;
      expect(sourceField.labelKey).toBe('chat.fields.notificationSource');
      const modeField = card.fields.find((field) => field.path === 'mode')!;
      expect(modeField.labelKey).toBe('chat.fields.mode');
      expect(JSON.stringify(modeField.editable)).toEqual(expect.stringContaining('approved'));
      expect(JSON.stringify(modeField.editable)).toEqual(expect.stringContaining('muted'));
      expect(JSON.stringify(modeField.editable)).toEqual(expect.stringContaining('context'));
    });

    it.each(['context', 'muted'] as const)(
      'sets the mode %s chosen on the card and drops what the source held',
      async (mode) => {
        const { source } = await parkOnNewSource();
        const card = await waitForCard({ toolName: SET_SOURCE });
        const edited = await helpers.editChatProposal({
          proposalId: card.id,
          payload: { revision: card.revision, args: { sourceId: source.id, mode } },
          raw: true,
        });

        const approved = await approve({ card: edited });

        expect(approved.statusCode).toBe(200);
        expect((await NotificationSources.findByPk(source.id))!.mode).toBe(mode);
        // Neither mode reads the payment text it held: a context source never reaches the payment parser.
        expect(await IngestRequests.count({ where: { sourceId: source.id } })).toBe(0);
        expect(await Transactions.count()).toBe(0);
      },
    );

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
      const gel = await account({ name: 'Example GEL', currencyCode: 'GEL' });
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
    const TRANSFER_OUT = 'Money Transfer: 300.00 USD\nEXAMPLE CARD\n20/10/2026';
    const DEPOSIT_IN = 'Deposit Money: 778.50 GEL\nEXAMPLE CARD\n20/10/2026';
    const raisePair = async () => {
      enableServerModel();
      mockNotificationParsing({ answer: answerFor });
      await helpers.addUserCurrencies({ currencyCodes: ['GEL', 'USD'] });
      const day = subDays(startOfDay(new Date()), 6);
      SEEDED_DATES.push(day);
      await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { AED: 4, GEL: 2.6 } });
      const gel = await account({ name: 'Example GEL', currencyCode: 'GEL' });
      const usd = await account({ name: 'Example USD', currencyCode: 'USD' });
      await helpers.createCardMapping({ payload: { cardLabel: 'EXAMPLE CARD', accountId: gel.id }, raw: true });
      await helpers.createCardMapping({
        payload: { cardLabel: 'EXAMPLE CARD', accountId: usd.id, currencyCode: 'USD' },
        raw: true,
      });
      const { secret } = await ingestHelpers.createTestIngestToken();
      const start = addMinutes(day, 14 * 60);
      const push = (minutes: number, body: string) =>
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
    /** The user's inbox thread with the given cards, written directly: lifecycle cases need states no flow reaches quickly. */
    const seedInboxThread = async ({ cards = [], createdAt }: { cards?: SeedCard[]; createdAt?: Date } = {}) => {
      const { id: userId } = await helpers.getUserInfo({ raw: true });
      const thread = await ChatThreads.create({
        userId,
        title: 'Automation inbox',
        titleSource: 'model',
        pinned: true,
        kind: 'automationInbox',
        inboxState: 'live',
        lastMessageAt: new Date(),
        lastReadAt: new Date(),
        expiresAt: null,
        ...(createdAt && { createdAt }),
      });

      const proposals: ChatProposals[] = [];
      for (const card of cards) {
        proposals.push(await seedCard({ thread, userId, card }));
      }

      return { thread, proposals, userId };
    };

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

    describe('one permanent thread', () => {
      it('holds both cards when two items arrive together and there is no inbox yet', async () => {
        const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };

        await Promise.all([parkNewSource({ secret, app: 'Cashly' }), parkNewSource({ secret, app: 'Paymo' })]);
        await waitForCards({ toolName: SET_SOURCE, count: 2 });

        const threads = await inboxThreads();
        expect(threads).toHaveLength(1);
        expect(threads[0]).toMatchObject({ pinned: true, expiresAt: null });
        expect(await ChatThreads.count({ where: { kind: 'automationInbox' } })).toBe(1);
        expect(await inboxCards({ toolName: SET_SOURCE })).toHaveLength(2);
      });

      it('keeps posting into the same thread however old it is and whatever it holds', async () => {
        const { thread } = await seedInboxThread({
          cards: [{ status: 'applied' }, { status: 'rejected' }],
          createdAt: new Date(Date.now() - 90 * 86_400_000),
        });
        const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };

        await parkNewSource({ secret, app: 'Cashly' });
        await waitForCards({ toolName: SET_SOURCE });

        const threads = await ChatThreads.findAll({ where: { kind: 'automationInbox' } });
        expect(threads.map((row) => row.id)).toEqual([thread.id]);
        expect(await ChatProposals.count({ where: { threadId: thread.id } })).toBe(3);
      });

      it('stays when its last waiting card is resolved or expires', async () => {
        const { thread, proposals } = await seedInboxThread({
          cards: [{ status: 'pending' }, { status: 'pending', expiresAt: new Date(Date.now() - 1000) }],
        });

        await helpers.rejectChatProposal({ proposalId: proposals[0]!.id });
        // Reading the thread expires the due card.
        await helpers.getChatThread({ threadId: thread.id, raw: true });

        expect(await threadOf({ id: thread.id })).toMatchObject({ pinned: true, expiresAt: null });
      });

      it('refuses to delete or unpin it with 409, with or without a waiting card', async () => {
        for (const cards of [[{ status: 'pending' as const }], [{ status: 'applied' as const }]]) {
          await ChatThreads.destroy({ where: { kind: 'automationInbox' } });
          const { thread } = await seedInboxThread({ cards });

          expect((await helpers.deleteChatThread({ threadId: thread.id })).statusCode).toBe(ERROR_CODES.ConflictError);
          expect((await helpers.updateChatThread({ threadId: thread.id, payload: { pinned: false } })).statusCode).toBe(
            ERROR_CODES.ConflictError,
          );
          expect(await ChatThreads.findByPk(thread.id)).not.toBeNull();
        }
      });

      it('refuses a second inbox thread for the same user at the database', async () => {
        const { userId } = await seedInboxThread();

        await expect(
          ChatThreads.create({
            userId,
            title: 'Automation inbox',
            titleSource: 'model',
            pinned: true,
            kind: 'automationInbox',
            inboxState: 'live',
            lastMessageAt: new Date(),
            expiresAt: null,
          }),
        ).rejects.toThrow();
      });

      it('no longer answers the archive and clear-resolved routes', async () => {
        const { thread } = await seedInboxThread({ cards: [{ status: 'applied' }] });

        for (const action of ['archive', 'clear-resolved']) {
          const response = await helpers.makeRequest({ method: 'post', url: `/chat/threads/${thread.id}/${action}` });
          expect(response.statusCode).toBe(404);
        }
      });
    });

    describe('pruning', () => {
      const DAY = 86_400_000;
      const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

      it('keeps the newest resolved items up to the setting and every item that still waits', async () => {
        const resolved: SeedCard[] = Array.from({ length: 12 }, (_, index) => ({
          status: index % 2 ? ('applied' as const) : ('rejected' as const),
          postedAt: daysAgo(2),
          // The first one was decided the longest ago.
          decidedAt: new Date(Date.now() - (12 - index) * 60_000),
        }));
        const { thread, proposals } = await seedInboxThread({
          cards: [
            { status: 'pending', postedAt: daysAgo(3) },
            { status: 'stale', postedAt: daysAgo(3) },
            { status: 'failed', postedAt: daysAgo(3) },
            ...resolved,
          ],
        });

        const response = await helpers.updateChatSettings({ payload: { inboxKeepResolved: 10 } });

        expect(response.statusCode).toBe(200);
        expect(response.body.response).toEqual({ retentionDays: 30, inboxKeepResolved: 10 });
        const left = await ChatProposals.findAll({ where: { threadId: thread.id } });
        const leftIds = new Set(left.map((card) => card.id));
        // The two decided first are gone, with their messages.
        expect(leftIds.has(proposals[3]!.id)).toBe(false);
        expect(leftIds.has(proposals[4]!.id)).toBe(false);
        expect(left).toHaveLength(13);
        expect(left.filter((card) => ['pending', 'stale', 'failed'].includes(card.status))).toHaveLength(3);
        expect(await ChatMessages.count({ where: { threadId: thread.id } })).toBe(13);
      });

      it('deletes resolved items older than the chat history, counting from when they were decided', async () => {
        const { userId, thread } = await seedInboxThread({
          cards: [
            { status: 'applied', postedAt: daysAgo(20), decidedAt: daysAgo(10) },
            { status: 'rejected', postedAt: daysAgo(20), decidedAt: daysAgo(2) },
            { status: 'pending', postedAt: daysAgo(40) },
          ],
        });
        await seedNotice({ thread, userId, postedAt: daysAgo(9) });
        await seedNotice({ thread, userId, postedAt: daysAgo(1) });

        await helpers.updateChatSettings({ payload: { retentionDays: 7 } });

        expect((await remainingStatuses({ threadId: thread.id })).toSorted()).toEqual(['pending', 'rejected']);
        expect(await ChatMessages.count({ where: { threadId: thread.id } })).toBe(3);
      });

      it('keeps resolved items of any age when the chat history is kept forever', async () => {
        const { thread } = await seedInboxThread({
          cards: [{ status: 'applied', postedAt: daysAgo(400), decidedAt: daysAgo(400) }],
        });

        await helpers.updateChatSettings({ payload: { retentionDays: null } });

        expect(await remainingStatuses({ threadId: thread.id })).toEqual(['applied']);
      });

      it('prunes on a new item too', async () => {
        await helpers.updateChatSettings({ payload: { inboxKeepResolved: 10 } });
        const { userId, thread } = await seedInboxThread({
          cards: Array.from({ length: 11 }, (_, index) => ({
            status: 'applied' as const,
            decidedAt: new Date(Date.now() - (11 - index) * 60_000),
          })),
        });
        await seedNotice({ thread, userId, postedAt: daysAgo(1) });
        const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };

        await parkNewSource({ secret, app: 'Cashly' });
        await waitForCards({ toolName: SET_SOURCE });

        await until(async () => (await ChatMessages.count({ where: { threadId: thread.id } })) === 11, {
          timeout: 20_000,
          interval: 150,
        });
        expect(await ChatProposals.count({ where: { threadId: thread.id, status: 'applied' } })).toBe(10);
      });

      it.each([9, 1001, 10.5])('refuses to keep %s resolved items with 422 and changes nothing', async (value) => {
        const response = await helpers.updateChatSettings({ payload: { inboxKeepResolved: value } });

        expect(response.statusCode).toBe(ERROR_CODES.ValidationError);
        expect(
          (await helpers.updateChatSettings({ payload: { retentionDays: 30 }, raw: true })).inboxKeepResolved,
        ).toBe(100);
      });

      it('keeps the retention when only the number of items changes', async () => {
        await helpers.updateChatSettings({ payload: { retentionDays: 90 } });

        const settings = await helpers.updateChatSettings({ payload: { inboxKeepResolved: 500 }, raw: true });

        expect(settings).toEqual({ retentionDays: 90, inboxKeepResolved: 500 });
      });
    });

    describe('badges', () => {
      it('counts the cards that wait for the owner and the notices that arrived since the inbox was viewed', async () => {
        const { userId, thread } = await seedInboxThread({
          cards: [{ status: 'pending' }, { status: 'stale' }, { status: 'applied' }, { status: 'failed' }],
        });
        await seedNotice({ thread, userId });

        expect((await listed({ id: thread.id })).badgeCount).toBe(3);
        expect((await helpers.getChatBadgeTotal({ raw: true })).total).toBe(3);

        // Viewing reads the notice; the cards keep counting until they are answered.
        const page = await helpers.getChatThread({ threadId: thread.id, raw: true });
        expect(page.thread.badgeCount).toBe(2);
        expect((await listed({ id: thread.id })).badgeCount).toBe(2);
      });

      it('counts a chat reply until the thread is viewed, by opening it or by presence', async () => {
        const { id: userId } = await helpers.getUserInfo({ raw: true });
        const chat = await helpers.createChatThread({ raw: true });
        const other = await helpers.createChatThread({ raw: true });
        const reply = ({ threadId }: { threadId: string }) =>
          ChatMessages.create({
            threadId,
            userId,
            role: 'assistant',
            status: 'complete',
            parts: [{ type: 'text', id: randomUUID(), text: 'Done.' }],
          });
        expect((await listed({ id: chat.id })).badgeCount).toBe(0);

        await reply({ threadId: chat.id });
        await reply({ threadId: chat.id });
        await reply({ threadId: other.id });

        expect((await listed({ id: chat.id })).badgeCount).toBe(2);
        expect((await helpers.getChatBadgeTotal({ raw: true })).total).toBe(3);

        await helpers.getChatThread({ threadId: chat.id, raw: true });
        expect((await listed({ id: chat.id })).badgeCount).toBe(0);

        expect((await helpers.putChatPresence({ threadId: other.id })).statusCode).toBe(200);
        expect((await listed({ id: other.id })).badgeCount).toBe(0);
        expect((await helpers.getChatBadgeTotal({ raw: true })).total).toBe(0);
      });

      it('does not count a reply that is still streaming', async () => {
        const { id: userId } = await helpers.getUserInfo({ raw: true });
        const chat = await helpers.createChatThread({ raw: true });
        await ChatMessages.create({ threadId: chat.id, userId, role: 'assistant', status: 'streaming', parts: [] });

        expect((await listed({ id: chat.id })).badgeCount).toBe(0);
      });
    });

    describe('merging the inboxes a user had before one permanent thread', () => {
      it('moves every message and card into the live thread, keeps one per user and deletes the rest', async () => {
        const { id: userId } = await helpers.getUserInfo({ raw: true });
        const newest = new Date();
        // Made over HTTP, so before the transaction below locks the table.
        const chat = await helpers.createChatThread({ raw: true });

        await expect(
          connection.sequelize.transaction(async (transaction) => {
            // The index of one inbox per user did not exist when there were several.
            await connection.sequelize.query('DROP INDEX "ChatThreads_userId_inbox_unique"', { transaction });
            const make = (state: string, lastMessageAt: Date) =>
              ChatThreads.create(
                {
                  userId,
                  title: 'Automation inbox',
                  titleSource: 'model',
                  pinned: state !== 'closed',
                  kind: 'automationInbox',
                  inboxState: state,
                  lastMessageAt,
                  lastReadAt: lastMessageAt,
                  expiresAt: state === 'closed' ? new Date(Date.now() + 86_400_000) : null,
                },
                { transaction },
              );
            const closed = await make('closed', new Date(Date.now() - 20 * 86_400_000));
            const open = await make('open', newest);
            const live = await make('live', new Date(Date.now() - 86_400_000));
            await seedCard({ thread: closed, userId, card: { status: 'applied' } });
            await seedCard({ thread: open, userId, card: { status: 'pending' } });
            await seedCard({ thread: live, userId, card: { status: 'pending' } });

            await mergeInboxThreads({ queryInterface: connection.sequelize.getQueryInterface(), transaction });

            const inboxes = await ChatThreads.findAll({ where: { kind: 'automationInbox' }, transaction });
            expect(inboxes.map((thread) => thread.id)).toEqual([live.id]);
            expect(inboxes[0]).toMatchObject({ inboxState: 'live', pinned: true, expiresAt: null });
            expect(inboxes[0]!.lastMessageAt.getTime()).toBe(newest.getTime());
            expect(await ChatProposals.count({ where: { threadId: live.id }, transaction })).toBe(3);
            expect(await ChatMessages.count({ where: { threadId: live.id }, transaction })).toBe(3);
            expect(await ChatThreads.findByPk(chat.id, { transaction })).not.toBeNull();

            throw new Error('rollback');
          }),
        ).rejects.toThrow('rollback');
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

  it('can change how many resolved items the inbox keeps', async () => {
    await becomeReadOnly();

    const response = await helpers.updateChatSettings({ payload: { inboxKeepResolved: 50 } });

    expect(response.statusCode).toBe(200);
    expect(response.body.response).toMatchObject({ inboxKeepResolved: 50 });
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
