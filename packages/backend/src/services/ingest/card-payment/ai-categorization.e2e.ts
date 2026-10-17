import { CATEGORIZATION_MODE, CATEGORIZATION_SOURCE, CATEGORIZATION_TRIGGER, type RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { categorizationQueue } from '@services/ai-categorization/categorization-queue';
import { CATEGORIZATION_SCOPE } from '@services/ai-categorization/categorization-scope';
import * as helpers from '@tests/helpers';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { VALID_GEMINI_API_KEY, createGeminiMock } from '@tests/mocks/gemini/mock-api';
import { getLunchFlowBalanceMock, getLunchFlowTransactionsMock } from '@tests/mocks/lunchflow/mock-api';
import { randomUUID } from 'node:crypto';

import { cardPaymentTimings } from './constants';

const CARD = 'TBC Visa';
const MERCHANT = 'Cafe Heart of Batumi';
const AI_CATEGORY = 'Coffee';

const payment = (overrides: Record<string, unknown> = {}) => ({
  amount: '47.00',
  merchant: MERCHANT,
  card: CARD,
  source: 'apple-pay',
  idempotencyKey: `key-${randomUUID()}`,
  ...overrides,
});

interface LoggedAnswer {
  outcome: string;
  summary: string;
  transactionId: RecordId;
  planned: boolean;
  categoryPending: boolean;
  duplicate?: boolean;
}

/** Links the card to `account` (a fresh base-currency account when omitted) and mints a token. */
const linkCard = async ({ account }: { account?: { id: RecordId } } = {}) => {
  const target = account ?? (await helpers.createAccount({ raw: true }));
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: target.id }, raw: true });
  const { secret } = await ingestHelpers.createTestIngestToken();

  return { account: target, secret };
};

/** Sends one payment that must be logged and returns the answer. */
const ingest = async ({ secret, overrides = {} }: { secret: string; overrides?: Record<string, unknown> }) => {
  const res = await ingestHelpers.postCardPayment({ secret, body: payment(overrides) });

  expect(res.status).toBe(200);
  expect(res.body.response.outcome).toBe('logged');

  return res.body.response as LoggedAnswer;
};

const storedTransaction = async ({ transactionId }: { transactionId: RecordId }) =>
  (await helpers.getTransactionById({ id: transactionId, raw: true }))!;

const createCategory = (name: string) => helpers.addCustomCategory({ name, color: '#336699', raw: true });

const enableAi = () => {
  process.env.GEMINI_API_KEY = VALID_GEMINI_API_KEY;
};

/** Where a row lands when nothing categorizes it. */
const userDefaultCategoryId = async () => (await helpers.getUserInfo({ raw: true })).defaultCategoryId;

const aiAnswers = ({ delayMs }: { delayMs?: number } = {}) =>
  global.mswMockServer.use(createGeminiMock({ categorizationsByName: { 1: AI_CATEGORY }, delayMs }));

/** Pairs LunchFlow and connects its first account, which makes it a bank-connected account. */
const connectedAccount = async () => {
  const { connectionId } = await helpers.lunchflow.pair();

  global.mswMockServer.use(
    getLunchFlowTransactionsMock({ response: { transactions: [], total: 0 } }),
    getLunchFlowBalanceMock(),
  );

  const { accounts } = await helpers.bankDataProviders.listExternalAccounts({ connectionId, raw: true });
  const { syncedAccounts } = await helpers.bankDataProviders.connectSelectedAccounts({
    connectionId,
    accountExternalIds: [accounts[0]!.externalId],
    raw: true,
  });

  return syncedAccounts[0]!;
};

describe('card payment AI categorization', () => {
  let originalGeminiApiKey: string | undefined;
  let originalBudgetMs: number;
  let queueAdd: jest.SpiedFunction<typeof categorizationQueue.add>;

  beforeEach(() => {
    originalGeminiApiKey = process.env.GEMINI_API_KEY;
    originalBudgetMs = cardPaymentTimings.aiWaitBudgetMs;
    queueAdd = jest.spyOn(categorizationQueue, 'add');
  });

  afterEach(() => {
    queueAdd.mockRestore();
    cardPaymentTimings.aiWaitBudgetMs = originalBudgetMs;

    if (originalGeminiApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalGeminiApiKey;
    }
  });

  const queuedJobs = () =>
    queueAdd.mock.calls.map(([, data]) => data as { transactionIds: string[]; scope: string; trigger: string });

  const waitForAiCategory = ({ transactionId }: { transactionId: RecordId }) =>
    until(
      async () => (await storedTransaction({ transactionId })).categorizationMeta?.source === CATEGORIZATION_SOURCE.ai,
      { timeout: 20_000, interval: 250 },
    );

  it('names the AI category in the answer when the AI replies within the budget', async () => {
    enableAi();
    await createCategory(AI_CATEGORY);
    aiAnswers();
    const { secret } = await linkCard();

    const logged = await ingest({ secret });

    expect(logged.categoryPending).toBe(false);
    expect(logged.summary).toMatch(/ → Coffee$/);

    const tx = await storedTransaction(logged);
    expect(tx.categorizationMeta?.source).toBe(CATEGORIZATION_SOURCE.ai);
    expect(queuedJobs()).toHaveLength(1);
    expect(queuedJobs()[0]).toMatchObject({
      transactionIds: [logged.transactionId],
      scope: CATEGORIZATION_SCOPE.anyCategory,
      trigger: CATEGORIZATION_TRIGGER.sync,
    });
  }, 60_000);

  it('answers "categorizing…" when the AI is slower than the budget and categorizes the row later', async () => {
    enableAi();
    cardPaymentTimings.aiWaitBudgetMs = 400;
    const coffee = await createCategory(AI_CATEGORY);
    aiAnswers({ delayMs: 2_500 });
    const { secret } = await linkCard();
    const key = `key-${randomUUID()}`;

    const logged = await ingest({ secret, overrides: { idempotencyKey: key } });

    expect(logged.categoryPending).toBe(true);
    expect(logged.summary).toMatch(/ → categorizing…$/);
    expect((await storedTransaction(logged)).categoryId).toBe(await userDefaultCategoryId());

    await waitForAiCategory(logged);
    expect((await storedTransaction(logged)).categoryId).toBe(coffee.id);

    const replay = await ingest({ secret, overrides: { idempotencyKey: key } });
    expect(replay.duplicate).toBe(true);
    expect(replay.summary).toMatch(/ → Coffee$/);
  }, 60_000);

  it('queues nothing and answers "Uncategorized" when no AI is configured', async () => {
    delete process.env.GEMINI_API_KEY;
    const { secret } = await linkCard();

    const logged = await ingest({ secret });

    expect(logged.categoryPending).toBe(false);
    expect(logged.summary).toMatch(/ → Uncategorized$/);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('queues a hint payee row without waiting and lets the AI override it later', async () => {
    enableAi();
    const [hinted, coffee] = await Promise.all([createCategory('Bar, cafe'), createCategory(AI_CATEGORY)]);
    aiAnswers({ delayMs: 1_500 });
    await helpers.createPayee({
      payload: helpers.buildPayeePayload({
        name: MERCHANT,
        defaultCategoryId: hinted.id,
        categorizationMode: CATEGORIZATION_MODE.hint,
      }),
      raw: true,
    });
    const { secret } = await linkCard();

    const logged = await ingest({ secret });

    expect(logged.categoryPending).toBe(false);
    expect(logged.summary).toMatch(/ → Bar, cafe$/);
    expect((await storedTransaction(logged)).categoryId).toBe(hinted.id);
    expect(queueAdd).toHaveBeenCalledTimes(1);

    await waitForAiCategory(logged);
    expect((await storedTransaction(logged)).categoryId).toBe(coffee.id);
  }, 60_000);

  it('queues a history-categorized row without waiting and lets the AI override it later', async () => {
    enableAi();
    const [history, coffee] = await Promise.all([createCategory('Lunch'), createCategory(AI_CATEGORY)]);
    aiAnswers({ delayMs: 1_500 });
    const { account, secret } = await linkCard();
    const payee = await helpers.createPayee({ payload: helpers.buildPayeePayload({ name: MERCHANT }), raw: true });
    await helpers.createTransaction({
      payload: helpers.buildTransactionPayload({
        accountId: account.id,
        payeeId: payee.id,
        categoryId: history.id,
        time: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
      }),
      raw: true,
    });

    const logged = await ingest({ secret });

    expect(logged.categoryPending).toBe(false);
    expect(logged.summary).toMatch(/ → Lunch$/);
    expect(queueAdd).toHaveBeenCalledTimes(1);

    await waitForAiCategory(logged);
    expect((await storedTransaction(logged)).categoryId).toBe(coffee.id);
  }, 60_000);

  it('queues nothing for an enforce payee category', async () => {
    enableAi();
    const fixed = await createCategory('Bar, cafe');
    await helpers.createPayee({
      payload: helpers.buildPayeePayload({
        name: MERCHANT,
        defaultCategoryId: fixed.id,
        categorizationMode: CATEGORIZATION_MODE.enforce,
      }),
      raw: true,
    });
    const { secret } = await linkCard();

    const logged = await ingest({ secret });

    expect((await storedTransaction(logged)).categorizationMeta?.source).toBe(CATEGORIZATION_SOURCE.payeeRule);
    expect(logged.summary).toMatch(/ → Bar, cafe$/);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('queues nothing for a category set by a rule', async () => {
    enableAi();
    const ruled = await createCategory('Treats');
    await helpers.createAutomation({
      payload: {
        name: 'Heart is a treat',
        conditions: { match: 'all', items: [{ field: 'note', operator: 'contains_any', value: ['heart'] }] },
        actions: [{ type: 'set_category', categoryId: ruled.id }],
      },
      raw: true,
    });
    const { secret } = await linkCard();

    const logged = await ingest({ secret });

    expect((await storedTransaction(logged)).categorizationMeta?.source).toBe(CATEGORIZATION_SOURCE.userRule);
    expect(logged.summary).toMatch(/ → Treats$/);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('queues nothing for a planned row', async () => {
    enableAi();
    await createCategory(AI_CATEGORY);
    aiAnswers();
    const account = await connectedAccount();
    const { secret } = await linkCard({ account });
    queueAdd.mockClear();

    const logged = await ingest({ secret });

    expect(logged.planned).toBe(true);
    expect(logged.categoryPending).toBe(false);
    expect(logged.summary).toMatch(/ → Uncategorized; the bank sync will confirm it$/);
    expect(queueAdd).not.toHaveBeenCalled();
  });
});
