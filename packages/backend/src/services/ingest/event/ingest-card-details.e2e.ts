import { CATEGORIZATION_SOURCE, type ChatProposalCard, type RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import PayeeAliases from '@models/payee-aliases.model';
import Payees from '@models/payees.model';
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
const MERCHANT = 'ANTHROPIC* CLAUDE SUB';

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

/** What the mocked model reads from the next push. */
let reading: Record<string, unknown> = {};

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

const fieldOf = ({ card, path }: { card: ChatProposalCard; path: string }) =>
  card.fields.find((field) => field.path === path);

const argsWith = ({ card, changes }: { card: ChatProposalCard; changes: Record<string, unknown> }) => ({
  revision: card.revision,
  args: { ...Object.fromEntries(card.fields.map((field) => [field.path, field.value])), ...changes },
});

const edit = ({ card, changes }: { card: ChatProposalCard; changes: Record<string, unknown> }) =>
  helpers.editChatProposal({ proposalId: card.id, payload: argsWith({ card, changes }), raw: true });

/** The same edit, answered with the response, for an edit the API refuses. */
const editResponse = ({ card, changes }: { card: ChatProposalCard; changes: Record<string, unknown> }) =>
  helpers.editChatProposal({ proposalId: card.id, payload: argsWith({ card, changes }) });

const approve = ({ card }: { card: ChatProposalCard }) =>
  helpers.approveChatProposal({ proposalId: card.id, payload: { revision: card.revision } });

const loggedRow = async ({ requestId }: { requestId: RecordId }) => {
  await until(async () => (await IngestRequests.findByPk(requestId))!.status === 'logged', {
    timeout: 20_000,
    interval: 150,
  });

  return (await Transactions.findByPk((await IngestRequests.findByPk(requestId))!.transactionId!))!;
};

const account = ({ name }: { name: string }) =>
  helpers.createAccount({
    payload: helpers.buildAccountPayload({ name, currencyCode: BASE, initialBalance: 1000 }),
    raw: true,
  });

describe('the payee and category of a parked payment card', () => {
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

  /** A card payment on a card no account is linked to, with two accounts to choose from: it waits on its account. */
  const parkPayment = async () => {
    const main = await account({ name: 'Main' });
    const spare = await account({ name: 'Spare' });
    const { secret } = await ingestHelpers.createTestIngestToken();
    reading = { kind: 'debit', amount: '20.00', currency: BASE, merchant: MERCHANT, cardLastDigits: '4242' };
    const res = await ingestHelpers.postIngestEvent({
      secret,
      body: {
        kind: 'notification',
        app: 'Example Bank',
        title: 'Example Bank',
        subtitle: '',
        body: `Purchase ${BASE} 20.00 at ${MERCHANT}, card *4242`,
        idempotencyKey: `push-${randomUUID()}`,
      },
    });
    expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownAccount' });
    await until(async () => (await inboxCards({ toolName: LOG_REQUEST })).length === 1, {
      timeout: 30_000,
      interval: 150,
    });

    return {
      main,
      spare,
      requestId: res.body.response.requestId as RecordId,
      card: (await inboxCards({ toolName: LOG_REQUEST }))[0]!,
    };
  };

  it('shows the new payee the merchant would create and the default category, writing nothing', async () => {
    const { card } = await parkPayment();

    expect(card.ingestRequest?.payee).toEqual({ id: null, name: MERCHANT });
    expect(card.ingestRequest?.category).toMatchObject({ source: 'default' });
    expect(fieldOf({ card, path: 'payeeId' })).toMatchObject({ editable: { type: 'entity', entity: 'payee' } });
    expect(fieldOf({ card, path: 'categoryId' })).toMatchObject({ editable: { type: 'entity', entity: 'category' } });
    expect(await Payees.count({ where: { name: MERCHANT } })).toBe(0);
  });

  it("names an existing payee the merchant is an alias of, with that payee's rule category", async () => {
    const category = await helpers.addCustomCategory({ name: 'AI tools', color: '#123456', raw: true });
    const payee = await helpers.createPayee({
      payload: { name: 'Anthropic', defaultCategoryId: category.id },
      raw: true,
    });
    await helpers.createPayeeAlias({ payeeId: payee.id, rawName: MERCHANT, raw: true });

    const { card } = await parkPayment();

    expect(card.ingestRequest?.payee).toEqual({ id: payee.id, name: 'Anthropic' });
    expect(card.ingestRequest?.category).toEqual({ id: category.id, source: 'payeeRule' });
  });

  it('logs the payee and category the owner chose, and maps the merchant to that payee from now on', async () => {
    const category = await helpers.addCustomCategory({ name: 'AI tools', color: '#123456', raw: true });
    const payee = await helpers.createPayee({ payload: { name: 'Claude' }, raw: true });
    const { main, card, requestId } = await parkPayment();

    const chosen = await edit({ card, changes: { accountId: main.id, payeeId: payee.id, categoryId: category.id } });
    expect(chosen.ingestRequest?.payee).toEqual({ id: payee.id, name: 'Claude' });
    expect(fieldOf({ card: chosen, path: 'payeeId' })?.value).toBe(payee.id);
    expect(fieldOf({ card: chosen, path: 'categoryId' })?.value).toBe(category.id);

    expect((await approve({ card: chosen })).statusCode).toBe(200);

    const logged = await loggedRow({ requestId });
    expect(logged).toMatchObject({ accountId: main.id, payeeId: payee.id, categoryId: category.id });
    expect(logged.categorizationMeta?.source).toBe(CATEGORIZATION_SOURCE.manual);
    expect(await Payees.count({ where: { name: MERCHANT } })).toBe(0);
    expect(await PayeeAliases.count({ where: { payeeId: payee.id, rawName: MERCHANT } })).toBe(1);
  });

  it('logs the payee the merchant resolves to when the owner chose none', async () => {
    const { main, card, requestId } = await parkPayment();

    const chosen = await edit({ card, changes: { accountId: main.id } });
    expect((await approve({ card: chosen })).statusCode).toBe(200);

    const logged = await loggedRow({ requestId });
    const payee = await Payees.findByPk(logged.payeeId!);
    expect(payee?.name).toBe(MERCHANT);
  });

  it("refuses another user's payee or category, and logs nothing", async () => {
    const other = await helpers.provisionSecondUserWithBaseCurrency();
    const { foreignPayee, foreignCategory } = await helpers.asUser({
      cookies: other.cookies,
      fn: async () => ({
        foreignPayee: await helpers.createPayee({ payload: { name: 'Not yours' }, raw: true }),
        foreignCategory: await helpers.addCustomCategory({ name: 'Not yours', color: '#654321', raw: true }),
      }),
    });
    const { main, card, requestId } = await parkPayment();

    const withPayee = await edit({ card, changes: { accountId: main.id, payeeId: foreignPayee.id } });
    expect(withPayee.ingestRequest?.payee).toBeNull();
    expect((await approve({ card: withPayee })).statusCode).toBeGreaterThanOrEqual(400);

    const current = (await inboxCards({ toolName: LOG_REQUEST }))[0]!;
    const withCategory = await edit({
      card: current,
      changes: { accountId: main.id, payeeId: undefined, categoryId: foreignCategory.id },
    });
    expect((await approve({ card: withCategory })).statusCode).toBeGreaterThanOrEqual(400);

    expect((await IngestRequests.findByPk(requestId))!).toMatchObject({ status: 'parked', transactionId: null });
  });

  it('refuses a payee or category on a card logged as a transfer', async () => {
    const { main, spare, card } = await parkPayment();
    const payee = await helpers.createPayee({ payload: { name: 'Claude' }, raw: true });

    const asTransfer = await edit({ card, changes: { accountId: main.id, counterAccountId: spare.id } });
    expect(fieldOf({ card: asTransfer, path: 'payeeId' })).toBeUndefined();
    expect(asTransfer.ingestRequest).not.toHaveProperty('payee');

    const refused = await editResponse({ card: asTransfer, changes: { payeeId: payee.id } });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
  });
});
