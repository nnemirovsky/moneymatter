import {
  BANK_PROVIDER_TYPE,
  CATEGORIZATION_SOURCE,
  CATEGORIZATION_TRIGGER,
  type ExternalMonobankTransactionResponse,
  type RecordId,
} from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Transactions from '@models/transactions.model';
import { categorizationQueue } from '@services/ai-categorization/categorization-queue';
import { CATEGORIZATION_SCOPE } from '@services/ai-categorization/categorization-scope';
import * as helpers from '@tests/helpers';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { useSelfHost } from '@tests/helpers/self-host';
import { FixedTransaction, MOCK_IDENTIFICATION_HASH_1 } from '@tests/mocks/enablebanking/data';
import { VALID_GEMINI_API_KEY, createGeminiMock } from '@tests/mocks/gemini/mock-api';
import { getMonobankTransactionsMock } from '@tests/mocks/monobank/mock-api';
import { addHours, format, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

const CARD = 'TBC Visa';
const MERCHANT = 'Cafe Heart of Batumi';
const AI_CATEGORY = 'Coffee';

// Powers of two keep every converted figure exact: 1 USD = 4 AED = 8 UAH = 2 EUR.
const RATES_PER_USD = { AED: 4, UAH: 8, EUR: 2 };
const SEEDED_DAYS_BACK = 12;
const AED_PER_UAH = RATES_PER_USD.AED / RATES_PER_USD.UAH;

const SEEDED_DATES: Date[] = [];

const seedRates = async () => {
  for (let daysAgo = 0; daysAgo <= SEEDED_DAYS_BACK; daysAgo += 1) {
    const day = subDays(startOfDay(new Date()), daysAgo);
    SEEDED_DATES.push(day);
    await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: RATES_PER_USD });
  }
};

const payment = (overrides: Record<string, unknown> = {}) => ({
  amount: '47.00',
  merchant: MERCHANT,
  card: CARD,
  source: 'apple-pay',
  idempotencyKey: `key-${randomUUID()}`,
  ...overrides,
});

/** Links the card to `accountId` and mints an ingest token. */
const linkCard = async ({ accountId }: { accountId: RecordId }) => {
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId }, raw: true });
  const { secret } = await ingestHelpers.createTestIngestToken();

  return { secret };
};

/** Sends one payment that must be noted as a plan on the bank-connected account. */
const ingestPlan = async ({ secret, overrides = {} }: { secret: string; overrides?: Record<string, unknown> }) => {
  const res = await ingestHelpers.postCardPayment({ secret, body: payment(overrides) });

  expect(res.status).toBe(200);
  expect(res.body.response).toMatchObject({ outcome: 'logged', planned: true });

  return res.body.response.transactionId as RecordId;
};

const readRow = async ({ id }: { id: RecordId }) => (await helpers.getTransactionById({ id, raw: true }))!;

const readExternalData = async ({ id }: { id: RecordId }) => {
  const row = await Transactions.findByPk(id);

  return (row!.externalData ?? {}) as Record<string, unknown> & {
    cardPayment?: { merchant?: string };
    applyAutomations?: boolean;
    plannedMerge?: { mergedAt?: string };
  };
};

const createCategory = (name: string) => helpers.addCustomCategory({ name, color: '#336699', raw: true });

const noteRule = ({ keyword, categoryId }: { keyword: string; categoryId: RecordId }) =>
  helpers.createAutomation({
    payload: {
      name: 'Heart is a treat',
      conditions: { match: 'all', items: [{ field: 'note', operator: 'contains_any', value: [keyword] }] },
      actions: [{ type: 'set_category', categoryId }],
    },
    raw: true,
  });

const listAccountTransactions = ({ accountId }: { accountId: RecordId }) =>
  helpers.getTransactions({ accountIds: [accountId], raw: true });

const syncAccount = async ({
  connectionId,
  accountId,
  transactions,
}: {
  connectionId: string;
  accountId: RecordId;
  transactions: ExternalMonobankTransactionResponse[];
}) => {
  global.mswMockServer.use(getMonobankTransactionsMock({ response: transactions }));

  const { jobGroupId } = await helpers.bankDataProviders.syncTransactionsForAccount({
    connectionId,
    accountId,
    raw: true,
  });
  const result = await helpers.bankDataProviders.waitForSyncJobsToComplete({
    connectionId,
    jobGroupId: jobGroupId!,
    timeoutMs: 20000,
  });
  expect(result.status).toBe('completed');
};

/** Matching needs one real row on the account; a sync into an empty one is an initial pull. */
const anchoredAccount = async () => {
  const { account } = await helpers.monobank.mockTransactions({
    transactions: [{ amount: -1234, time: subDays(startOfDay(new Date()), 10), description: 'ANCHOR CHARGE' }],
  });
  const { connections } = await helpers.bankDataProviders.listUserConnections({ raw: true });
  const connectionId = connections.find((c) => c.providerType === BANK_PROVIDER_TYPE.MONOBANK)!.id;

  let seeded = await listAccountTransactions({ accountId: account.id });
  for (let attempt = 0; attempt < 10 && seeded.length === 0; attempt += 1) {
    await helpers.sleep(300);
    seeded = await listAccountTransactions({ accountId: account.id });
  }
  expect(seeded).toHaveLength(1);

  return { connectionId, accountId: account.id };
};

const booking = ({
  cents,
  counterName = '',
  description = '',
  daysAgo = 1,
}: {
  cents: number;
  counterName?: string;
  description?: string;
  daysAgo?: number;
}) =>
  helpers.monobank.buildTransaction({
    amount: -cents,
    time: addHours(subDays(startOfDay(new Date()), daysAgo), 12),
    counterName,
    description,
  });

const setupConnectionWithAccount = async () => {
  const connectResult = await helpers.bankDataProviders.connectProvider({
    providerType: BANK_PROVIDER_TYPE.ENABLE_BANKING,
    credentials: helpers.enablebanking.mockCredentials(),
    raw: true,
  });
  const state = await helpers.enablebanking.getConnectionState(connectResult.connectionId);
  await helpers.makeRequest({
    method: 'post',
    url: '/bank-data-providers/enablebanking/oauth-callback',
    payload: {
      connectionId: connectResult.connectionId,
      code: helpers.enablebanking.mockAuthCode,
      state,
    },
  });
  const { syncedAccounts } = await helpers.bankDataProviders.connectSelectedAccounts({
    connectionId: connectResult.connectionId,
    accountExternalIds: [MOCK_IDENTIFICATION_HASH_1],
    raw: true,
  });

  return { connectionId: connectResult.connectionId, accountId: syncedAccounts[0]!.id };
};

describe('Card-payment plans – settlement on bank sync', () => {
  beforeEach(async () => {
    await seedRates();
  });

  afterEach(async () => {
    await helpers.clearExchangeRatesForDates({ dates: SEEDED_DATES.splice(0) });
  });

  describe('Monobank', () => {
    const setup = async () => {
      const bank = await anchoredAccount();
      const { secret } = await linkCard({ accountId: bank.accountId });

      return { ...bank, secret };
    };

    it('merges an exact-amount booking as it does for any plan', async () => {
      const { connectionId, accountId, secret } = await setup();
      const planId = await ingestPlan({ secret });

      await syncAccount({
        connectionId,
        accountId,
        transactions: [booking({ cents: 4700, description: 'PURCHASE' })],
      });

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(2);
      const merged = rows.find((row) => row.id === planId)!;
      expect(merged).toMatchObject({ isPlanned: false, amount: 47 });
      expect((await readExternalData({ id: planId })).plannedMerge?.mergedAt).toBeTruthy();

      // The text says nothing about the merchant, so it is not learned as an alias.
      const payee = await helpers.getPayeeById({ id: merged.payeeId!, raw: true });
      expect(payee.aliases?.map((alias) => alias.normalizedName)).not.toContain('purchase');
    }, 60000);

    it('merges a tipped booking from the same merchant, keeping the plan payee and category', async () => {
      const { connectionId, accountId, secret } = await setup();
      const treats = await createCategory('Treats');
      await noteRule({ keyword: 'heart', categoryId: treats.id });
      const planId = await ingestPlan({ secret });
      const plan = await readRow({ id: planId });
      expect(plan).toMatchObject({ categoryId: treats.id, refAmount: 47 * AED_PER_UAH });

      const incoming = booking({ cents: 5200, counterName: MERCHANT });
      await syncAccount({ connectionId, accountId, transactions: [incoming] });

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(2);
      const merged = rows.find((row) => row.id === planId)!;
      expect(merged).toMatchObject({
        isPlanned: false,
        amount: 52,
        refAmount: 52 * AED_PER_UAH,
        categoryId: treats.id,
        payeeId: plan.payeeId,
        originalId: incoming.id,
      });
    }, 60000);

    it('merges a booking whose descriptor differs from the Wallet name and learns the descriptor as an alias', async () => {
      const { connectionId, accountId, secret } = await setup();
      const planId = await ingestPlan({ secret });
      const plan = await readRow({ id: planId });

      await syncAccount({
        connectionId,
        accountId,
        transactions: [booking({ cents: 5200, counterName: 'HEART OF BATUMI CAFE BATUMI GE' })],
      });

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === planId)).toMatchObject({ isPlanned: false, amount: 52 });

      const payee = await helpers.getPayeeById({ id: plan.payeeId!, raw: true });
      expect(payee.aliases?.map((alias) => alias.normalizedName)).toContain('heart of batumi cafe batumi ge');
      expect(await helpers.listPayees({ raw: true })).toHaveLength(1);
    }, 60000);

    it('merges a foreign-currency plan with the bank amount, keeping the payment currency figures', async () => {
      const { connectionId, accountId, secret } = await setup();
      const planId = await ingestPlan({
        secret,
        overrides: {
          amount: '12.50',
          currency: 'USD',
          time: addHours(subDays(startOfDay(new Date()), 5), 12).toISOString(),
        },
      });
      expect(await readRow({ id: planId })).toMatchObject({ amount: 100, originalAmount: 12.5 });

      await syncAccount({
        connectionId,
        accountId,
        transactions: [booking({ cents: 10400, counterName: 'CAFE HEART OF BATUMI', daysAgo: 1 })],
      });

      const merged = (await listAccountTransactions({ accountId })).find((row) => row.id === planId)!;
      expect(merged).toMatchObject({
        isPlanned: false,
        amount: 104,
        refAmount: 104 * AED_PER_UAH,
        originalAmount: 12.5,
        originalCurrencyCode: 'USD',
      });
    }, 60000);

    it('takes the merchant from the description when the bank sends no counterparty', async () => {
      const { connectionId, accountId, secret } = await setup();
      const planId = await ingestPlan({ secret });

      await syncAccount({
        connectionId,
        accountId,
        transactions: [booking({ cents: 5200, description: 'HEART OF BATUMI CAFE' })],
      });

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === planId)).toMatchObject({ isPlanned: false, amount: 52 });
    }, 60000);

    it('merges a booking whose merchant is a known alias of the plan payee', async () => {
      const { connectionId, accountId, secret } = await setup();
      const planId = await ingestPlan({ secret });
      const plan = await readRow({ id: planId });
      // Every token is under 3 characters or a number, so only the learned alias can link it.
      await helpers.createPayeeAlias({ payeeId: plan.payeeId!, rawName: '7-11', raw: true });

      await syncAccount({
        connectionId,
        accountId,
        transactions: [booking({ cents: 5200, counterName: '7-11' })],
      });

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === planId)).toMatchObject({ isPlanned: false, amount: 52 });
    }, 60000);

    it('leaves a tolerance booking from another merchant as its own row and lets the exact one merge', async () => {
      const { connectionId, accountId, secret } = await setup();
      const planId = await ingestPlan({ secret });

      const other = booking({ cents: 5200, counterName: 'SPAR BATUMI', daysAgo: 2 });
      const exact = booking({ cents: 4700, counterName: 'SPAR BATUMI', daysAgo: 1 });
      await syncAccount({ connectionId, accountId, transactions: [other, exact] });

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === planId)).toMatchObject({
        isPlanned: false,
        amount: 47,
        originalId: exact.id,
      });
      expect(rows.find((row) => row.originalId === other.id)).toMatchObject({ isPlanned: false, amount: 52 });

      // The exact-amount booking settled the plan, but its text is another shop and is not learned.
      const merged = rows.find((row) => row.id === planId)!;
      const payee = await helpers.getPayeeById({ id: merged.payeeId!, raw: true });
      expect(payee.aliases?.map((alias) => alias.normalizedName) ?? []).not.toContain('spar batumi');
    }, 60000);

    it('does not merge a tolerance booking from another shop that shares only the city and a category word', async () => {
      const { connectionId, accountId, secret } = await setup();
      const planId = await ingestPlan({ secret });
      const plan = await readRow({ id: planId });

      await syncAccount({
        connectionId,
        accountId,
        transactions: [booking({ cents: 5200, counterName: 'CAFE BATUMI GE' })],
      });

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === planId)).toMatchObject({ isPlanned: true, amount: 47 });

      const payee = await helpers.getPayeeById({ id: plan.payeeId!, raw: true });
      expect(payee.aliases?.map((alias) => alias.normalizedName) ?? []).not.toContain('cafe batumi ge');
    }, 60000);

    it('does not merge a tolerance booking whose text is another known payee, even when a token is shared', async () => {
      const { connectionId, accountId, secret } = await setup();
      const planId = await ingestPlan({ secret });
      const garden = await helpers.createPayee({ payload: { name: 'Heart Garden Grill' }, raw: true });

      await syncAccount({
        connectionId,
        accountId,
        transactions: [booking({ cents: 5200, counterName: 'HEART GARDEN GRILL' })],
      });

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === planId)).toMatchObject({ isPlanned: true, amount: 47 });
      expect(rows.find((row) => row.payeeId === garden.id)).toMatchObject({ isPlanned: false, amount: 52 });
    }, 60000);

    it('does not shrink a split plan below its split total, and still merges a booking that covers it', async () => {
      const { connectionId, accountId, secret } = await setup();
      const planId = await ingestPlan({ secret });
      const splitCategory = await createCategory('Split part');
      await helpers.updateTransaction({
        id: planId,
        payload: { splits: [{ categoryId: splitCategory.id, amount: 45 }] },
        raw: true,
      });

      const tooLow = booking({ cents: 4000, counterName: MERCHANT, daysAgo: 2 });
      await syncAccount({ connectionId, accountId, transactions: [tooLow] });

      let rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === planId)).toMatchObject({ isPlanned: true, amount: 47 });

      const covering = booking({ cents: 4600, counterName: MERCHANT, daysAgo: 1 });
      await syncAccount({ connectionId, accountId, transactions: [covering] });

      rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === planId)).toMatchObject({ isPlanned: false, amount: 46 });
    }, 60000);

    it('gives each of two equal-amount plans the booking of its own shop when the dates drift', async () => {
      const { connectionId, accountId, secret } = await setup();
      const heartTime = addHours(subDays(startOfDay(new Date()), 3), 12).toISOString();
      const sparTime = addHours(subDays(startOfDay(new Date()), 1), 12).toISOString();
      const heartPlanId = await ingestPlan({ secret, overrides: { time: heartTime } });
      const sparPlanId = await ingestPlan({ secret, overrides: { merchant: 'Spar Batumi', time: sparTime } });
      const heartPayeeId = (await readRow({ id: heartPlanId })).payeeId;
      const sparPayeeId = (await readRow({ id: sparPlanId })).payeeId;
      expect(heartPayeeId).not.toBe(sparPayeeId);

      // The Heart booking is dated next to the Spar plan, and the Spar booking next to the Heart plan.
      const heartBooking = booking({ cents: 4700, counterName: 'CAFE HEART OF BATUMI', daysAgo: 1 });
      const sparBooking = booking({ cents: 4700, counterName: 'SPAR BATUMI GE', daysAgo: 3 });
      await syncAccount({ connectionId, accountId, transactions: [heartBooking, sparBooking] });

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === heartPlanId)).toMatchObject({
        isPlanned: false,
        originalId: heartBooking.id,
        payeeId: heartPayeeId,
      });
      expect(rows.find((row) => row.id === sparPlanId)).toMatchObject({
        isPlanned: false,
        originalId: sparBooking.id,
        payeeId: sparPayeeId,
      });
    }, 60000);

    it('does not merge a booking more than 25 % away from the plan', async () => {
      const { connectionId, accountId, secret } = await setup();
      const planId = await ingestPlan({ secret });

      const incoming = booking({ cents: 7000, counterName: MERCHANT });
      await syncAccount({ connectionId, accountId, transactions: [incoming] });

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === planId)).toMatchObject({ isPlanned: true, amount: 47 });
      expect(rows.find((row) => row.originalId === incoming.id)).toMatchObject({ isPlanned: false, amount: 70 });
    }, 60000);

    it('still needs the exact amount for a plan the user wrote', async () => {
      const { connectionId, accountId } = await setup();
      const [userPlan] = await helpers.createPlannedTransaction({
        payload: { accountId, amount: 47, time: new Date().toISOString(), note: MERCHANT },
        raw: true,
      });

      await syncAccount({
        connectionId,
        accountId,
        transactions: [booking({ cents: 5200, counterName: MERCHANT })],
      });

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === userPlan!.id)).toMatchObject({ isPlanned: true, amount: 47 });
    }, 60000);

    it('settles the plan whose amount is closer when two card-payment plans fit', async () => {
      const { connectionId, accountId, secret } = await setup();
      const nearer = await ingestPlan({ secret, overrides: { amount: '55.00' } });
      const farther = await ingestPlan({ secret, overrides: { amount: '47.00' } });

      await syncAccount({
        connectionId,
        accountId,
        transactions: [booking({ cents: 5200, counterName: MERCHANT })],
      });

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === nearer)).toMatchObject({ isPlanned: false, amount: 52 });
      expect(rows.find((row) => row.id === farther)).toMatchObject({ isPlanned: true, amount: 47 });
    }, 60000);

    describe('automations and AI after a merge', () => {
      let originalGeminiApiKey: string | undefined;
      let queueAdd: jest.SpiedFunction<typeof categorizationQueue.add>;

      beforeEach(() => {
        originalGeminiApiKey = process.env.GEMINI_API_KEY;
        queueAdd = jest.spyOn(categorizationQueue, 'add');
      });

      afterEach(() => {
        queueAdd.mockRestore();

        if (originalGeminiApiKey === undefined) {
          delete process.env.GEMINI_API_KEY;
        } else {
          process.env.GEMINI_API_KEY = originalGeminiApiKey;
        }
      });

      const jobsFor = ({ transactionId }: { transactionId: RecordId }) =>
        queueAdd.mock.calls
          .map(([, data]) => data as { transactionIds: string[]; scope: string; trigger: string })
          .filter((job) => job.transactionIds.includes(transactionId));

      it('keeps the category a rule set at ingest and queues no AI job', async () => {
        const { connectionId, accountId, secret } = await setup();
        const treats = await createCategory('Treats');
        await noteRule({ keyword: 'heart', categoryId: treats.id });
        const planId = await ingestPlan({ secret });

        process.env.GEMINI_API_KEY = VALID_GEMINI_API_KEY;
        await syncAccount({
          connectionId,
          accountId,
          transactions: [booking({ cents: 5200, counterName: MERCHANT })],
        });

        const merged = await readRow({ id: planId });
        expect(merged).toMatchObject({ isPlanned: false, categoryId: treats.id });
        expect(merged.categorizationMeta?.source).toBe(CATEGORIZATION_SOURCE.userRule);
        expect(jobsFor({ transactionId: planId })).toEqual([]);
      }, 60000);

      it('queues an AI job for an uncategorized merged row and keeps the card-payment data', async () => {
        const { connectionId, accountId, secret } = await setup();
        await createCategory(AI_CATEGORY);
        const planId = await ingestPlan({ secret });

        process.env.GEMINI_API_KEY = VALID_GEMINI_API_KEY;
        global.mswMockServer.use(createGeminiMock({ categorizationsByName: { 1: AI_CATEGORY } }));
        await syncAccount({
          connectionId,
          accountId,
          transactions: [booking({ cents: 5200, counterName: MERCHANT })],
        });

        expect(jobsFor({ transactionId: planId })).toEqual([
          expect.objectContaining({
            scope: CATEGORIZATION_SCOPE.anyCategory,
            trigger: CATEGORIZATION_TRIGGER.sync,
          }),
        ]);

        const externalData = await readExternalData({ id: planId });
        expect(externalData.cardPayment?.merchant).toBe(MERCHANT);
        expect(externalData.applyAutomations).toBe(true);
        expect(externalData.plannedMerge?.mergedAt).toBeTruthy();

        await until(
          async () => (await readRow({ id: planId })).categorizationMeta?.source === CATEGORIZATION_SOURCE.ai,
          {
            timeout: 20_000,
            interval: 250,
          },
        );
        expect((await readRow({ id: planId })).categoryId).not.toBe(global.DEFAULT_CATEGORY_ID);
      }, 90000);
    });
  });

  describe('Enable Banking', () => {
    // Enable Banking is closed on the cloud edition.
    useSelfHost();

    beforeEach(() => {
      helpers.enablebanking.resetSessionCounter();
    });

    afterEach(() => {
      helpers.enablebanking.resetTransactionConfig();
    });

    const CARD_ROW = { currency: 'EUR', isExpense: true, counterpartyIban: null } as const;

    const ANCHOR: FixedTransaction = {
      ...CARD_ROW,
      status: 'BOOK',
      amount: '99.00',
      bookingDate: '2025-10-01',
      entryReference: 'card_payment_anchor_ref',
      remittanceInformation: ['ANCHOR CHARGE'],
    };

    it('merges a pending hold at the plan amount, then lets a booking at another amount land as its own row (known limit)', async () => {
      await helpers.patchUserSettings({ patch: { importPendingBankTransactions: true }, raw: true });
      helpers.enablebanking.setFixedTransactions([ANCHOR]);
      const { connectionId, accountId } = await setupConnectionWithAccount();
      expect(await listAccountTransactions({ accountId })).toHaveLength(1);

      const { secret } = await linkCard({ accountId });
      const planId = await ingestPlan({ secret });

      const sync = () => helpers.bankDataProviders.syncTransactionsForAccount({ connectionId, accountId, raw: true });

      helpers.enablebanking.setFixedTransactions([
        {
          ...CARD_ROW,
          status: 'PDNG',
          amount: '47.00',
          transactionDate: format(subDays(new Date(), 1), 'yyyy-MM-dd'),
          remittanceInformation: ['CARD HOLD'],
        },
      ]);
      await sync();

      const afterHold = await listAccountTransactions({ accountId });
      expect(afterHold).toHaveLength(2);
      expect(afterHold.find((row) => row.id === planId)).toMatchObject({ isPlanned: false, amount: 47 });

      helpers.enablebanking.setFixedTransactions([
        {
          ...CARD_ROW,
          status: 'BOOK',
          amount: '52.00',
          bookingDate: format(subDays(new Date(), 1), 'yyyy-MM-dd'),
          entryReference: 'card_payment_booked_ref',
          remittanceInformation: ['CARD CAPTURE'],
        },
      ]);
      await sync();

      const rows = await listAccountTransactions({ accountId });
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === planId)).toMatchObject({ isPlanned: false, amount: 47 });
      expect(rows.find((row) => row.note === 'CARD CAPTURE')).toMatchObject({ amount: 52 });
    }, 90000);
  });
});
