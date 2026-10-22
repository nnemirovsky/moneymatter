import type { ChatProposalCard, RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { randomUUID } from 'node:crypto';

import { dedupConfig } from '../dedup/constants';

const BASE = global.BASE_CURRENCY_CODE;
const LOG_REQUEST = 'log_ingest_request';
const DEFAULT_DEDUP = { ...dedupConfig };

/** Wallet's notification of an online Apple Pay: the card is Wallet's name for it. */
const walletTemu = ({ time }: { time?: string } = {}) => ({
  kind: 'notification',
  app: 'Wallet',
  title: 'TBC Bank',
  subtitle: 'Temu',
  body: `${BASE} 143.97`,
  ...(time && { time }),
  idempotencyKey: `key-${randomUUID()}`,
});

/** The bank's push for the same payment, 14 seconds later, naming the card with its digits. */
const bankTemu = () => ({
  kind: 'notification',
  app: 'TBC Bank',
  title: 'TBC Bank',
  subtitle: '',
  body: `Purchase ${BASE} 143.97, TEMU.COM, card *1234`,
  idempotencyKey: `key-${randomUUID()}`,
});

const answerBank = () =>
  mockNotificationParsing({
    answer: () => ({
      kind: 'debit',
      amount: '143.97',
      currency: BASE,
      merchant: 'TEMU.COM',
      cardName: 'TBC Concept VISA Platinum',
      cardLastDigits: '1234',
    }),
  });

const send = ({ secret, body }: { secret: string; body: object }) => ingestHelpers.postIngestEvent({ secret, body });

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

const pickAccount = ({ card, accountId }: { card: ChatProposalCard; accountId: RecordId }) =>
  helpers.editChatProposal({
    proposalId: card.id,
    payload: {
      revision: card.revision,
      args: { ...Object.fromEntries(card.fields.map((field) => [field.path, field.value])), accountId },
    },
    raw: true,
  });

const approve = async ({ card, accountId }: { card: ChatProposalCard; accountId: RecordId }) => {
  const edited = await pickAccount({ card, accountId });
  const approved = await helpers.approveChatProposal({ proposalId: card.id, payload: { revision: edited.revision } });
  expect(approved.statusCode).toBe(200);
};

const account = () =>
  helpers.createAccount({
    payload: helpers.buildAccountPayload({ name: 'TBC', currencyCode: BASE, initialBalance: 1000 }),
    raw: true,
  });

const requests = () => IngestRequests.findAll({ where: { pipeline: 'notification' }, order: [['createdAt', 'ASC']] });

const labelsOf = async () => (await helpers.listCardMappings({ raw: true })).map((mapping) => mapping.cardLabel).sort();

describe('the same payment parked by two sources', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    enableServerModel();
    await resetLimits();
  });
  afterEach(async () => {
    Object.assign(dedupConfig, DEFAULT_DEDUP);
    await resetLimits();
  });

  it('waits as one card when Wallet comes first and the bank second, and approving logs once and learns both cards', async () => {
    const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };
    answerBank();
    const tbc = await account();

    const first = await send({ secret, body: walletTemu() });
    const second = await send({ secret, body: bankTemu() });

    expect(first.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownAccount' });
    expect(second.body.response).toMatchObject({ outcome: 'duplicate', notify: false });
    const [wallet, bank] = await requests();
    expect(wallet).toMatchObject({ status: 'parked', reason: 'unknownAccount' });
    expect(bank).toMatchObject({ status: 'dismissed', reason: 'parkedTwin', duplicateOfId: wallet!.id });

    const cards = await waitForCards({ count: 1 });
    expect(cards).toHaveLength(1);
    // The card names the other source and its card.
    expect(cards[0]!.ingestRequest!.alsoSeenIn).toEqual([
      { sourceName: 'TBC Bank', cardName: 'TBC Concept VISA Platinum', cardLastDigits: '1234' },
    ]);

    await approve({ card: cards[0]!, accountId: tbc.id });
    await until(async () => (await IngestRequests.findByPk(wallet!.id))!.status === 'logged', {
      timeout: 20_000,
      interval: 150,
    });

    expect(await helpers.getTransactions({ raw: true })).toHaveLength(1);
    expect(await labelsOf()).toEqual(['TBC Bank', 'TBC Concept VISA Platinum']);
    expect(await inboxCards({ status: 'pending' })).toHaveLength(0);
  });

  it('waits as one card when the bank comes first and Wallet second', async () => {
    const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };
    answerBank();

    await send({ secret, body: bankTemu() });
    const second = await send({ secret, body: walletTemu() });

    expect(second.body.response).toMatchObject({ outcome: 'duplicate' });
    expect(await waitForCards({ count: 1 })).toHaveLength(1);
    const [bank, wallet] = await requests();
    expect(bank).toMatchObject({ status: 'parked' });
    expect(wallet).toMatchObject({ status: 'dismissed', reason: 'parkedTwin', duplicateOfId: bank!.id });
  });

  it('keeps two payments of one source apart: two coffees are two payments', async () => {
    const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };

    await send({ secret, body: walletTemu({ time: new Date(Date.now() - 600_000).toISOString() }) });
    await send({ secret, body: walletTemu({ time: new Date().toISOString() }) });

    expect(await waitForCards({ count: 2 })).toHaveLength(2);
  });

  it('settles the twin that is still waiting when the owner approves the other, and learns its card too', async () => {
    const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };
    answerBank();
    const tbc = await account();
    // Two cards exist for one payment, as they did before twins were joined at parking.
    dedupConfig.twinWindowMs = 1;
    await send({ secret, body: walletTemu() });
    await send({ secret, body: bankTemu() });
    Object.assign(dedupConfig, DEFAULT_DEDUP);
    const cards = await waitForCards({ count: 2 });
    expect(cards).toHaveLength(2);

    await approve({ card: cards[0]!, accountId: tbc.id });
    await until(async () => (await requests()).some((request) => request.status === 'logged'), {
      timeout: 20_000,
      interval: 150,
    });
    expect(await inboxCards({ status: 'pending' })).toHaveLength(0);

    const all = await requests();
    expect(all.filter((request) => request.reason === 'parkedTwin')).toHaveLength(1);
    expect(await helpers.getTransactions({ raw: true })).toHaveLength(1);
    expect(await labelsOf()).toEqual(['TBC Bank', 'TBC Concept VISA Platinum']);
  });

  it('absorbs a waiting twin when the other source logs on a card that is already linked', async () => {
    const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };
    answerBank();
    const tbc = await account();
    await send({ secret, body: walletTemu() });
    await waitForCards({ count: 1 });
    await helpers.createCardMapping({
      payload: { cardLabel: 'TBC Concept VISA Platinum', accountId: tbc.id, lastDigits: '1234' },
      raw: true,
    });

    const bank = await send({ secret, body: bankTemu() });

    expect(bank.body.response.outcome).toBe('logged');
    const [wallet] = await requests();
    expect(wallet).toMatchObject({ status: 'dismissed', reason: 'parkedTwin' });
    await until(async () => (await inboxCards({ status: 'pending' })).length === 0, { timeout: 20_000, interval: 150 });
    expect(await helpers.getTransactions({ raw: true })).toHaveLength(1);
  });
});
