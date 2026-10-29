import { TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES, type ChatProposalCard } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import Transactions from '@models/transactions.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing, useAiOnlyNotificationParsing } from '@tests/helpers/notification-ai';
import { addMinutes, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from '../event/constants';

const DEFAULT_TIMINGS = { ...notificationTimings };
const SEEDED_DATES: Date[] = [];
const BODY = 'Debit 40.00 USD';

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
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

const waitForCard = async () => {
  await until(async () => (await inboxCards({ toolName: 'log_ingest_request' })).length === 1, {
    timeout: 30_000,
    interval: 150,
  });

  return (await inboxCards({ toolName: 'log_ingest_request' }))[0]!;
};

const edit = ({ card, changes }: { card: ChatProposalCard; changes: Record<string, unknown> }) =>
  helpers.editChatProposal({
    proposalId: card.id,
    payload: {
      revision: card.revision,
      args: { ...Object.fromEntries(card.fields.map((field) => [field.path, field.value])), ...changes },
    },
    raw: true,
  });

describe('a lone notice logged as a transfer', () => {
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

  const setUp = async () => {
    await helpers.addUserCurrencies({ currencyCodes: ['EUR', 'USD'] });
    const day = subDays(startOfDay(new Date()), 6);
    SEEDED_DATES.push(day);
    await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { EUR: 0.9 } });
    const account = ({ name, currencyCode }: { name: string; currencyCode: string }) =>
      helpers.createAccount({
        payload: helpers.buildAccountPayload({ name, currencyCode, initialBalance: 1000 }),
        raw: true,
      });
    const usd = await account({ name: 'Wallet USD', currencyCode: 'USD' });
    const usdSpare = await account({ name: 'Spare USD', currencyCode: 'USD' });
    const eur = await account({ name: 'Wallet EUR', currencyCode: 'EUR' });
    const start = addMinutes(day, 11 * 60);
    mockNotificationParsing({ answer: () => ({ kind: 'debit', amount: '40.00', currency: 'USD', merchant: null }) });
    const { secret } = await ingestHelpers.createTestIngestToken();
    await ingestHelpers.postIngestEvent({
      secret,
      body: {
        kind: 'notification',
        app: 'Example Bank',
        title: 'Example',
        subtitle: '',
        body: BODY,
        time: start.toISOString(),
        idempotencyKey: `push-${randomUUID()}`,
      },
    });

    return { usd, usdSpare, eur, start, card: await waitForCard() };
  };

  const rowsOf = async () =>
    (await Transactions.findAll({ order: [['amount', 'ASC']] })).filter(
      (row) => row.transferNature === TRANSACTION_TRANSFER_NATURE.common_transfer,
    );

  it('logs the notice and the other side as one exchange at the notice time, with no confirm card', async () => {
    const { usd, eur, start, card } = await setUp();
    const edited = await edit({ card, changes: { accountId: usd.id, counterAccountId: eur.id, counterAmount: 36 } });

    const approved = await helpers.approveChatProposal({
      proposalId: edited.id,
      payload: { revision: edited.revision },
    });
    expect(approved.statusCode).toBe(200);

    await until(async () => (await rowsOf()).length === 2, { timeout: 30_000, interval: 150 });
    const [income, expense] = await rowsOf();
    expect(expense).toMatchObject({ accountId: usd.id, transactionType: TRANSACTION_TYPES.expense });
    expect(expense!.amount.toNumber()).toBe(40);
    expect(income).toMatchObject({ accountId: eur.id, transactionType: TRANSACTION_TYPES.income });
    expect(income!.amount.toNumber()).toBe(36);
    expect(expense!.transferId).toBe(income!.transferId);
    expect(expense!.time.toISOString()).toBe(start.toISOString());

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await inboxCards({ toolName: 'confirm_ingest_payment' })).toEqual([]);
    expect(await helpers.listUnconfirmedCardPayments({ raw: true })).toEqual([]);
  });

  it('refuses another currency without the amount, and logs nothing', async () => {
    const { usd, eur, card } = await setUp();
    const edited = await edit({ card, changes: { accountId: usd.id, counterAccountId: eur.id } });

    const approved = await helpers.approveChatProposal({
      proposalId: edited.id,
      payload: { revision: edited.revision },
    });

    expect(approved.statusCode).toBeGreaterThanOrEqual(400);
    expect(await Transactions.count({ where: { transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer } })).toBe(
      0,
    );
    expect((await IngestRequests.findAll({ where: { pipeline: 'notification' } })).map((row) => row.status)).toEqual([
      'parked',
    ]);
  });

  it('takes the notice amount for the other side in the same currency', async () => {
    const { usd, usdSpare, card } = await setUp();
    const edited = await edit({ card, changes: { accountId: usd.id, counterAccountId: usdSpare.id } });

    const approved = await helpers.approveChatProposal({
      proposalId: edited.id,
      payload: { revision: edited.revision },
    });
    expect(approved.statusCode).toBe(200);

    await until(async () => (await rowsOf()).length === 2, { timeout: 30_000, interval: 150 });
    expect((await rowsOf()).map((row) => row.amount.toNumber())).toEqual([40, 40]);
  });
});
