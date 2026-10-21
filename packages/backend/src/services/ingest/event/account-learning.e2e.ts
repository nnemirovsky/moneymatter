import type { ChatProposalCard, RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import CardAccountMappings from '@models/card-account-mappings.model';
import ChatProposals from '@models/chat-proposals.model';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import Transactions from '@models/transactions.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from './constants';
import type { StoredParse } from './stored-parse';

const BASE = global.BASE_CURRENCY_CODE;
const DEFAULT_TIMINGS = { ...notificationTimings };
const LOG_REQUEST = 'log_ingest_request';

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

const account = ({ name }: { name: string }) =>
  helpers.createAccount({
    payload: helpers.buildAccountPayload({ name, currencyCode: BASE, initialBalance: 1000 }),
    raw: true,
  });

/** What the next push prints and the mocked reader answers: each push differs, so none is a repeat. */
let printedAmount = '3000.00';
let sequence = 0;

/** A push from a seeded bank app that shows an incoming credit and only the last digits of the card; each differs, so none is a repeat. */
const push = () => ({
  kind: 'notification',
  app: 'TBC Bank',
  title: 'TBC Bank',
  subtitle: '',
  body: `Incoming transfer ${BASE} ${printedAmount} to card *1258`,
  idempotencyKey: `key-${randomUUID()}`,
});

const credit = ({ cardLastDigits = '1258' }: { cardLastDigits?: string | null } = {}) => ({
  kind: 'credit' as const,
  amount: printedAmount,
  currency: BASE,
  merchant: 'Salary',
  cardName: null,
  cardLastDigits,
});

const send = ({ secret }: { secret: string }) => {
  printedAmount = (3000 - ++sequence * 10).toFixed(2);

  return ingestHelpers.postIngestEvent({ secret, body: push() });
};

const readParsed = ({ row }: { row: IngestRequests }) => row.parsed as unknown as StoredParse;

const inboxCards = async ({ toolName, status }: { toolName: string; status?: string }): Promise<ChatProposalCard[]> => {
  const threads = (await helpers.listChatThreads({ raw: true })).threads.filter(
    (thread) => thread.kind === 'automationInbox',
  );
  const cards: ChatProposalCard[] = [];
  for (const thread of threads) {
    cards.push(...Object.values((await helpers.getChatThread({ threadId: thread.id, limit: 100, raw: true })).cards));
  }

  return cards.filter((card) => card.toolName === toolName && (!status || card.status === status));
};

const waitForCards = async ({
  toolName,
  count,
  status = 'pending',
}: {
  toolName: string;
  count: number;
  status?: string;
}): Promise<ChatProposalCard[]> => {
  await until(async () => (await inboxCards({ toolName, status })).length >= count, { timeout: 30_000, interval: 150 });

  return inboxCards({ toolName, status });
};

const waitForCard = async (): Promise<ChatProposalCard> =>
  (await waitForCards({ toolName: LOG_REQUEST, count: 1 }))[0]!;

const CONFIRM = 'confirm_ingest_payment';

/** The account picker of the card: stores the account on it the way the UI does. */
const pickAccount = ({ card, accountId }: { card: ChatProposalCard; accountId: RecordId }) =>
  helpers.editChatProposal({
    proposalId: card.id,
    payload: {
      revision: card.revision,
      args: { ...Object.fromEntries(card.fields.map((field) => [field.path, field.value])), accountId },
    },
    raw: true,
  });

const waitingRequests = async () => (await helpers.listCardPaymentRequests({ status: 'parked', raw: true })).length;

const approve = ({ card }: { card: ChatProposalCard }) =>
  helpers.approveChatProposal({ proposalId: card.id, payload: { revision: card.revision } });

const waitUntilLogged = async ({ requestId }: { requestId: RecordId }) => {
  await until(async () => (await IngestRequests.findByPk(requestId))!.status === 'logged', {
    timeout: 20_000,
    interval: 150,
  });

  return (await Transactions.findByPk((await IngestRequests.findByPk(requestId))!.transactionId!))!;
};

describe('which account a parked notification payment goes to', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    notificationTimings.categorizeWaitMs = 3000;
    notificationTimings.retryBackoffMs = 10;
    enableServerModel();
    await resetLimits();
  });

  afterEach(async () => {
    Object.assign(notificationTimings, DEFAULT_TIMINGS);
    await resetLimits();
  });

  /** Three accounts in the payment's currency; only one is named after the bank. */
  const setUp = async () => {
    const bank = await account({ name: 'TBC' });
    await account({ name: 'Gazprom CC' });
    const bereke = await account({ name: 'Bereke' });
    const forte = await account({ name: 'Forte' });

    return { bank, bereke, forte, secret: (await ingestHelpers.createTestIngestToken()).secret };
  };

  it('guesses the account named after the app among several in the currency, and still waits for approval', async () => {
    mockNotificationParsing({ answer: () => credit() });
    const { bank, secret } = await setUp();

    const res = await send({ secret });

    expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownAccount' });
    const request = (await IngestRequests.findByPk(res.body.response.requestId))!;
    expect(readParsed({ row: request }).accountGuessId).toBe(bank.id);
    expect(await Transactions.count()).toBe(0);
  });

  it('makes no guess when the app name matches two accounts', async () => {
    mockNotificationParsing({ answer: () => credit() });
    const { secret } = await setUp();
    await account({ name: 'TBC Bank Savings' });

    const res = await send({ secret });

    const request = (await IngestRequests.findByPk(res.body.response.requestId))!;
    expect(readParsed({ row: request }).accountGuessId).toBeNull();
  });

  it('lists the waiting payment under the card its digits name, and logs it when that card is linked', async () => {
    mockNotificationParsing({ answer: () => credit() });
    const { bank, secret } = await setUp();
    const res = await send({ secret });
    const requestId = res.body.response.requestId as RecordId;

    const waiting = (await helpers.listCardPaymentRequests({ status: 'parked', raw: true })).find(
      (entry) => entry.id === requestId,
    )!;
    expect(waiting).toMatchObject({ cardLabel: 'TBC Bank •1258', cardLastDigits: '1258', accountGuessId: bank.id });
    expect(await helpers.listUnlinkedCards({ raw: true })).toEqual([
      { cardLabel: 'TBC Bank •1258', count: 1, lastDigits: '1258' },
    ]);

    // Linking the card puts its waiting payment back through the pipeline by itself.
    const mapping = await helpers.createCardMapping({
      payload: { cardLabel: 'TBC Bank •1258', lastDigits: '1258', accountId: bank.id },
      raw: true,
    });
    expect(mapping.releasedCount).toBe(1);
    expect(await helpers.listUnlinkedCards({ raw: true })).toEqual([]);
    expect((await waitUntilLogged({ requestId })).accountId).toBe(bank.id);
  });

  describe('the card of the parked payment', () => {
    it('shows the payment and what approving would teach', async () => {
      mockNotificationParsing({ answer: () => credit() });
      const { bank, secret } = await setUp();
      await send({ secret });

      const card = await waitForCard();

      expect(card.fields.find((field) => field.path === 'accountId')?.value).toBe(bank.id);
      expect(card.ingestRequest).toMatchObject({
        reason: 'unknownAccount',
        counterparty: 'Salary',
        sourceName: 'TBC Bank',
        amount: Number(printedAmount),
        currencyCode: BASE,
        direction: 'credit',
        cardLastDigits: '1258',
        willLearn: 'card',
      });
    });

    it('cannot be approved before an account is chosen, with the picker still on the card', async () => {
      mockNotificationParsing({ answer: () => credit() });
      const { secret } = await setUp();
      const res = await send({ secret });
      const card = await waitForCard();
      const stripped = await helpers.editChatProposal({
        proposalId: card.id,
        payload: { revision: card.revision, args: { requestId: res.body.response.requestId } },
        raw: true,
      });

      expect(stripped.canApply).toEqual({ ok: false, reasonKey: 'chat.cards.ingestAccountRequired' });
      expect(stripped.fields.map((field) => field.path)).toContain('accountId');
    });

    it('links the card to the account on approval, so the next payment of the card needs no question', async () => {
      mockNotificationParsing({ answer: () => credit() });
      const { bank, secret } = await setUp();
      const first = await send({ secret });
      const card = await waitForCard();

      expect((await approve({ card })).statusCode).toBe(200);
      const logged = await waitUntilLogged({ requestId: first.body.response.requestId });
      expect(logged.accountId).toBe(bank.id);

      const links = await CardAccountMappings.findAll();
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        cardLabel: 'TBC Bank •1258',
        lastDigits: '1258',
        accountId: bank.id,
        currencyCode: null,
      });

      const second = await send({ secret });
      expect(second.body.response.outcome).toBe('logged');
    });
  });

  describe('a payment that shows no card', () => {
    it('sets the source default account on approval, so the next payment is logged there', async () => {
      mockNotificationParsing({ answer: () => credit({ cardLastDigits: null }) });
      const { bank, secret } = await setUp();
      const first = await send({ secret });
      const card = await waitForCard();
      expect(card.ingestRequest?.willLearn).toBe('sourceDefault');

      expect((await approve({ card })).statusCode).toBe(200);
      await waitUntilLogged({ requestId: first.body.response.requestId });

      const source = (await NotificationSources.findOne({ where: { appName: 'TBC Bank' } }))!;
      expect(source.defaultAccountId).toBe(bank.id);
      expect(await CardAccountMappings.count()).toBe(0);

      const second = await send({ secret });
      expect(second.body.response.outcome).toBe('logged');
    });
  });

  describe('the dead end is gone', () => {
    it('(a) logs a fresh card on the account picked on it, and the waiting list clears', async () => {
      mockNotificationParsing({ answer: () => credit() });
      const { forte, secret } = await setUp();
      const first = await send({ secret });
      const requestId = first.body.response.requestId as RecordId;
      const card = await waitForCard();

      const picked = await pickAccount({ card, accountId: forte.id });
      expect((await approve({ card: picked })).statusCode).toBe(200);

      const logged = await waitUntilLogged({ requestId });
      expect(logged.accountId).toBe(forte.id);
      expect(await waitingRequests()).toBe(0);
    });

    it('(b) recovers a card that failed, from the picker, without a new card', async () => {
      mockNotificationParsing({ answer: () => credit() });
      const { bereke, secret } = await setUp();
      const first = await send({ secret });
      const requestId = first.body.response.requestId as RecordId;
      const card = await waitForCard();
      // The state the owner's card was left in: approved without an account, failed, and posted before the
      // preview carried the digits, the source or the lesson.
      const stored = (await ChatProposals.findByPk(card.id))!;
      await stored.update({
        args: { requestId, direction: 'credit' },
        status: 'failed',
        error: { message: 'Choose the account to log this payment on.' },
        preview: {
          before: {
            id: requestId,
            reason: 'unknownAccount',
            name: 'Salary',
            amount: 3000,
            currencyCode: BASE,
            direction: 'credit',
            cardName: null,
            time: new Date().toISOString(),
          },
        },
      });

      const failed = await helpers.getChatProposal({ proposalId: card.id, raw: true });
      expect(failed.status).toBe('failed');
      expect(failed.ingestRequest).toMatchObject({ reason: 'unknownAccount', amount: 3000, direction: 'credit' });
      expect(failed.fields.map((field) => field.path)).toContain('accountId');

      const edited = await pickAccount({ card: failed, accountId: bereke.id });
      expect(edited.status).toBe('pending');
      expect(edited.canApply).toEqual({ ok: true });
      expect((await approve({ card: edited })).statusCode).toBe(200);
      expect((await waitUntilLogged({ requestId })).accountId).toBe(bereke.id);
    });

    it('(c) logs a waiting payment from the waiting list once its digits are linked', async () => {
      mockNotificationParsing({ answer: () => credit() });
      const { bank, secret } = await setUp();
      const first = await send({ secret });
      const requestId = first.body.response.requestId as RecordId;

      // The link is written behind the service, so nothing re-runs the payment by itself.
      await CardAccountMappings.create({
        userId: (await helpers.getUserInfo({ raw: true })).id,
        cardLabel: 'TBC Bank •1258',
        normalizedLabel: 'tbc bank •1258',
        lastDigits: '1258',
        currencyCode: null,
        accountId: bank.id,
      });

      expect(await helpers.retryCardPaymentRequest({ id: requestId, raw: true })).toMatchObject({ outcome: 'logged' });
      expect((await waitUntilLogged({ requestId })).accountId).toBe(bank.id);
      expect(await waitingRequests()).toBe(0);
    });
  });

  describe('waiting payments of the same card', () => {
    /** Two payments from card 1258, parked on their account; the amounts differ so neither is a repeat. */
    const parkTwo = async () => {
      mockNotificationParsing({ answer: () => credit() });
      const fixture = await setUp();
      const first = await send({ secret: fixture.secret });
      const second = await send({ secret: fixture.secret });

      return {
        ...fixture,
        ids: [first.body.response.requestId, second.body.response.requestId] as RecordId[],
      };
    };

    const expectBothLoggedAwaitingConfirmation = async ({
      ids,
      accountId,
    }: {
      ids: RecordId[];
      accountId: RecordId;
    }) => {
      const transactions: Transactions[] = [];
      for (const requestId of ids) transactions.push(await waitUntilLogged({ requestId }));

      expect(transactions.map((transaction) => transaction.accountId)).toEqual([accountId, accountId]);
      expect(await waitingRequests()).toBe(0);
      // Each payment has its own confirm card, still open: nothing was confirmed for the owner.
      const confirms = await waitForCards({ toolName: CONFIRM, count: 2 });
      expect(confirms.map((card) => card.status)).toEqual(['pending', 'pending']);
    };

    it('logs the others too when one is approved on an account, each for its own OK', async () => {
      const { bank, ids } = await parkTwo();
      const [firstCard] = await waitForCards({ toolName: LOG_REQUEST, count: 2 });
      expect(firstCard!.ingestRequest?.alsoWaiting).toBe(1);

      expect((await approve({ card: firstCard! })).statusCode).toBe(200);

      await expectBothLoggedAwaitingConfirmation({ ids, accountId: bank.id });
      const requestCards = await inboxCards({ toolName: LOG_REQUEST });
      expect(requestCards.map((card) => card.status).toSorted()).toEqual(['applied', 'rejected']);
      expect(await CardAccountMappings.count()).toBe(1);
    }, 60_000);

    it('logs them when the card is linked by hand', async () => {
      const { bank, ids } = await parkTwo();

      const mapping = await helpers.createCardMapping({
        payload: { cardLabel: 'TBC Bank •1258', lastDigits: '1258', accountId: bank.id },
        raw: true,
      });

      expect(mapping.releasedCount).toBe(2);
      await expectBothLoggedAwaitingConfirmation({ ids, accountId: bank.id });
    }, 60_000);

    it('logs the ones that show no card when the source default is set by hand', async () => {
      mockNotificationParsing({ answer: () => credit({ cardLastDigits: null }) });
      const { bank, secret } = await setUp();
      const first = await send({ secret });
      const ids = [first.body.response.requestId as RecordId];
      const source = (await NotificationSources.findOne({ where: { appName: 'TBC Bank' } }))!;

      const updated = await helpers.updateNotificationSource({
        id: source.id,
        payload: { defaultAccountId: bank.id },
        raw: true,
      });

      expect(updated.releasedCount).toBe(1);
      expect((await waitUntilLogged({ requestId: ids[0]! })).accountId).toBe(bank.id);
    });
  });

  describe('the note on the card', () => {
    const noteOf = async ({ requestId }: { requestId: RecordId }) =>
      (await helpers.getTransactionById({
        id: (await waitUntilLogged({ requestId })).id,
        raw: true,
      }))!.note ?? null;

    it('is empty without history, and the owner can write one that lands on the transaction', async () => {
      mockNotificationParsing({ answer: () => credit() });
      const { bank, secret } = await setUp();
      const first = await send({ secret });
      const card = await waitForCard();
      expect(card.fields.map((field) => field.path)).toContain('note');
      expect(card.fields.find((field) => field.path === 'note')?.value).toBeUndefined();

      const edited = await helpers.editChatProposal({
        proposalId: card.id,
        payload: {
          revision: card.revision,
          args: {
            ...Object.fromEntries(
              card.fields.flatMap((field) => (field.value === undefined ? [] : [[field.path, field.value]])),
            ),
            accountId: bank.id,
            note: '  October salary  ',
          },
        },
        raw: true,
      });
      expect((await approve({ card: edited })).statusCode).toBe(200);

      expect(await noteOf({ requestId: first.body.response.requestId })).toBe('October salary');
    });

    it("is the owner's usual note for the payee, and clearing it logs the payment without one", async () => {
      mockNotificationParsing({
        answer: () => ({ ...credit(), merchant: 'Salary', payee: { candidateId: 'p1', newName: null } }),
      });
      const { bank, secret } = await setUp();
      const payee = await helpers.createPayee({ payload: helpers.buildPayeePayload({ name: 'Salary' }), raw: true });
      for (const daysAgo of [10, 20, 30]) {
        await helpers.createTransaction({
          payload: helpers.buildTransactionPayload({
            accountId: bank.id,
            payeeId: payee.id,
            amount: 3000,
            time: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
            note: 'Monthly salary',
          }),
          raw: true,
        });
      }
      const first = await send({ secret });
      const card = await waitForCard();
      expect(card.fields.find((field) => field.path === 'note')?.value).toBe('Monthly salary');

      const cleared = await helpers.editChatProposal({
        proposalId: card.id,
        payload: {
          revision: card.revision,
          args: {
            requestId: first.body.response.requestId,
            accountId: bank.id,
            direction: 'credit',
            note: '',
          },
        },
        raw: true,
      });
      expect((await approve({ card: cleared })).statusCode).toBe(200);

      expect(await noteOf({ requestId: first.body.response.requestId })).toBeNull();
    });
  });
});
