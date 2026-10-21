import type { ChatProposalCard, RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import CardAccountMappings from '@models/card-account-mappings.model';
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
  helpers.createAccount({ payload: helpers.buildAccountPayload({ name, currencyCode: BASE, initialBalance: 1000 }), raw: true });

/** A push from a seeded bank app that shows an incoming credit and only the last digits of the card. */
const push = () => ({
  kind: 'notification',
  app: 'TBC Bank',
  title: 'TBC Bank',
  subtitle: '',
  body: `Incoming transfer ${BASE} 3000.00 to card *1258`,
  idempotencyKey: `key-${randomUUID()}`,
});

const credit = ({ cardLastDigits = '1258' }: { cardLastDigits?: string | null } = {}) => ({
  kind: 'credit' as const,
  amount: '3000.00',
  currency: BASE,
  merchant: 'Salary',
  cardName: null,
  cardLastDigits,
});

const send = ({ secret }: { secret: string }) => ingestHelpers.postIngestEvent({ secret, body: push() });

const readParsed = ({ row }: { row: IngestRequests }) => row.parsed as unknown as StoredParse;

const waitForCard = async (): Promise<ChatProposalCard> => {
  const find = async () => {
    const threads = (await helpers.listChatThreads({ raw: true })).threads.filter((thread) => thread.kind === 'automationInbox');
    const cards: ChatProposalCard[] = [];
    for (const thread of threads) {
      cards.push(...Object.values((await helpers.getChatThread({ threadId: thread.id, limit: 100, raw: true })).cards));
    }

    return cards.filter((card) => card.toolName === LOG_REQUEST && card.status === 'pending');
  };
  await until(async () => (await find()).length > 0, { timeout: 20_000, interval: 150 });

  return (await find())[0]!;
};

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
    await account({ name: 'Bereke' });

    return { bank, secret: (await ingestHelpers.createTestIngestToken()).secret };
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

  it('lists the waiting payment under the card its digits name, and logs it once that card is linked', async () => {
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

    await helpers.createCardMapping({
      payload: { cardLabel: 'TBC Bank •1258', lastDigits: '1258', accountId: bank.id },
      raw: true,
    });
    expect(await helpers.listUnlinkedCards({ raw: true })).toEqual([]);

    expect(await helpers.retryCardPaymentRequest({ id: requestId, raw: true })).toMatchObject({ outcome: 'logged' });
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
        amount: 3000,
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
});
