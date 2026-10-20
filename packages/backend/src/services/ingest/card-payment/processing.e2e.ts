import { CATEGORIZATION_MODE, CATEGORIZATION_SOURCE, type RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, describe, expect, it } from '@jest/globals';
import BrandLogos from '@models/brand-logos.model';
import IngestRequests from '@models/ingest-requests.model';
import * as helpers from '@tests/helpers';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { getLunchFlowBalanceMock, getLunchFlowTransactionsMock } from '@tests/mocks/lunchflow/mock-api';
import { addHours, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

const CARD = 'TBC Visa';
const MERCHANT = 'Cafe Heart of Batumi';

const payment = (overrides: Record<string, unknown> = {}) => ({
  amount: '47.00',
  merchant: MERCHANT,
  card: CARD,
  source: 'apple-pay',
  idempotencyKey: `key-${randomUUID()}`,
  ...overrides,
});

const send = ({ secret, body }: { secret: string; body: object }) => ingestHelpers.postCardPayment({ secret, body });

/** Where a row lands when nothing categorizes it: the user's own pointer, not the first seeded category. */
const userDefaultCategoryId = async () => (await helpers.getUserInfo({ raw: true })).defaultCategoryId;

/** Links the card to `account` (a fresh base-currency account when omitted) and mints a token. */
const linkCard = async ({ account }: { account?: { id: RecordId } } = {}) => {
  const target = account ?? (await helpers.createAccount({ raw: true }));
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: target.id }, raw: true });
  const { secret } = await ingestHelpers.createTestIngestToken();

  return { account: target, secret };
};

/** Sends one payment that must be logged and returns the answer. */
const ingest = async ({ secret, overrides = {} }: { secret: string; overrides?: Record<string, unknown> }) => {
  const res = await send({ secret, body: payment(overrides) });

  expect(res.status).toBe(200);
  expect(res.body.response.outcome).toBe('logged');

  return res.body.response as {
    summary: string;
    transactionId: RecordId;
    planned: boolean;
    categoryPending: boolean;
  };
};

const storedTransaction = async ({ transactionId }: { transactionId: RecordId }) =>
  (await helpers.getTransactionById({ id: transactionId, raw: true }))!;

const createCategory = (name: string) => helpers.addCustomCategory({ name, color: '#336699', raw: true });

const seedHistory = ({
  accountId,
  payeeId,
  categoryId,
  daysAgo,
}: {
  accountId: RecordId;
  payeeId: RecordId;
  categoryId: RecordId;
  daysAgo: number;
}) =>
  helpers.createTransaction({
    payload: helpers.buildTransactionPayload({
      accountId,
      payeeId,
      categoryId,
      time: subDays(new Date(), daysAgo).toISOString(),
    }),
    raw: true,
  });

/** A payee named like the merchant, with its history seeded before any default category is set. */
const payeeWithHistory = async ({
  accountId,
  history,
}: {
  accountId: RecordId;
  history: { categoryId: RecordId; daysAgo: number }[];
}) => {
  const payee = await helpers.createPayee({ payload: helpers.buildPayeePayload({ name: MERCHANT }), raw: true });

  for (const entry of history) {
    await seedHistory({ accountId, payeeId: payee.id, ...entry });
  }

  return payee;
};

const noteRule = ({ keyword, categoryId }: { keyword: string; categoryId: RecordId }) =>
  helpers.createAutomation({
    payload: {
      name: 'Heart is a treat',
      conditions: { match: 'all', items: [{ field: 'note', operator: 'contains_any', value: [keyword] }] },
      actions: [{ type: 'set_category', categoryId }],
    },
    raw: true,
  });

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

const SEEDED_DATES: Date[] = [];

/** A day with a pinned USD→AED market rate, so a conversion has an exact, known figure. */
const seedRateDay = async ({
  daysAgo,
  aedPerUsd = 3.5,
  otherRatesPerUsd = {},
}: {
  daysAgo: number;
  aedPerUsd?: number;
  otherRatesPerUsd?: Record<string, number>;
}) => {
  const day = subDays(startOfDay(new Date()), daysAgo);
  SEEDED_DATES.push(day);
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { AED: aedPerUsd, ...otherRatesPerUsd } });

  return { day, time: addHours(day, 12).toISOString() };
};

afterEach(async () => {
  await helpers.clearExchangeRatesForDates({ dates: SEEDED_DATES.splice(0) });
});

describe('card payment processing', () => {
  describe('payee', () => {
    it('creates a payee and an alias for a first-seen merchant and resolves its logo', async () => {
      await BrandLogos.create({
        normalizedName: 'cafe heart of batumi',
        domain: 'heartofbatumi.ge',
        brandName: MERCHANT,
        source: 'seed',
      });
      const { secret } = await linkCard();

      const first = await ingest({ secret });
      const tx = await storedTransaction(first);

      const payees = await helpers.listPayees({ raw: true });
      expect(payees).toHaveLength(1);
      expect(payees[0]).toMatchObject({ id: tx.payeeId, name: MERCHANT, normalizedName: 'cafe heart of batumi' });

      const detail = await helpers.getPayeeById({ id: tx.payeeId!, raw: true });
      expect(detail.aliases?.map((alias) => alias.normalizedName)).toContain('cafe heart of batumi');

      await until(async () => (await helpers.getPayeeById({ id: tx.payeeId!, raw: true })).logoDomain !== null, {
        timeout: 10_000,
        interval: 200,
      });
      expect((await helpers.getPayeeById({ id: tx.payeeId!, raw: true })).logoDomain).toBe('heartofbatumi.ge');

      const second = await ingest({ secret, overrides: { amount: '12.00' } });
      expect((await storedTransaction(second)).payeeId).toBe(tx.payeeId);
      expect(await helpers.listPayees({ raw: true })).toHaveLength(1);
    });

    it('links the existing payee behind a known alias', async () => {
      const payee = await helpers.createPayee({
        payload: helpers.buildPayeePayload({ name: 'Heart of Batumi' }),
        raw: true,
      });
      await helpers.createPayeeAlias({ payeeId: payee.id, rawName: MERCHANT, raw: true });
      const { secret } = await linkCard();

      const logged = await ingest({ secret });

      expect((await storedTransaction(logged)).payeeId).toBe(payee.id);
      expect(await helpers.listPayees({ raw: true })).toHaveLength(1);
    });

    it('links no payee for an ignored merchant name', async () => {
      await helpers.addIgnoredName({ rawName: MERCHANT, raw: true });
      const { secret } = await linkCard();

      const logged = await ingest({ secret });

      expect((await storedTransaction(logged)).payeeId ?? null).toBeNull();
      expect(await helpers.listPayees({ raw: true })).toEqual([]);
    });
  });

  describe('category', () => {
    it('uses the default category and reports no pending answer when nothing else applies', async () => {
      const { secret } = await linkCard();

      const logged = await ingest({ secret });

      expect((await storedTransaction(logged)).categoryId).toBe(await userDefaultCategoryId());
      expect(logged.categoryPending).toBe(false);
      expect(logged.summary).toMatch(/ → Uncategorized$/);
    });

    it('lets an enforce payee default win over the history', async () => {
      const { account, secret } = await linkCard();
      const [history, fixed] = await Promise.all([createCategory('Lunch'), createCategory('Bar, cafe')]);
      const payee = await payeeWithHistory({
        accountId: account.id,
        history: [
          { categoryId: history.id, daysAgo: 5 },
          { categoryId: history.id, daysAgo: 6 },
        ],
      });
      await helpers.updatePayee({
        id: payee.id,
        payload: { defaultCategoryId: fixed.id, categorizationMode: CATEGORIZATION_MODE.enforce },
        raw: true,
      });

      const logged = await ingest({ secret });
      const tx = await storedTransaction(logged);

      expect(tx.categoryId).toBe(fixed.id);
      expect(tx.categorizationMeta?.source).toBe(CATEGORIZATION_SOURCE.payeeRule);
      expect(logged.summary).toMatch(/ → Bar, cafe$/);
    });

    it('lets a hint payee default win over the history and leaves the row open for AI', async () => {
      const { account, secret } = await linkCard();
      const [history, hinted] = await Promise.all([createCategory('Lunch'), createCategory('Bar, cafe')]);
      const payee = await payeeWithHistory({
        accountId: account.id,
        history: [{ categoryId: history.id, daysAgo: 5 }],
      });
      await helpers.updatePayee({
        id: payee.id,
        payload: { defaultCategoryId: hinted.id, categorizationMode: CATEGORIZATION_MODE.hint },
        raw: true,
      });

      const tx = await storedTransaction(await ingest({ secret }));

      expect(tx.categoryId).toBe(hinted.id);
      expect(tx.categorizationMeta ?? null).toBeNull();
    });

    it('takes the most frequent past category of the payee, ignoring plans and the default category', async () => {
      const { account, secret } = await linkCard();
      const [frequent, recent] = await Promise.all([createCategory('Lunch'), createCategory('Coffee')]);
      const defaultCategoryId = await userDefaultCategoryId();
      const payee = await payeeWithHistory({
        accountId: account.id,
        history: [
          { categoryId: frequent.id, daysAgo: 20 },
          { categoryId: frequent.id, daysAgo: 10 },
          { categoryId: recent.id, daysAgo: 1 },
          ...[2, 3, 4, 5].map((daysAgo) => ({ categoryId: defaultCategoryId, daysAgo })),
        ],
      });
      for (const daysAgo of [1, 2, 3]) {
        await helpers.createPlannedTransaction({
          payload: {
            accountId: account.id,
            payeeId: payee.id,
            categoryId: recent.id,
            time: subDays(new Date(), daysAgo).toISOString(),
          },
          raw: true,
        });
      }

      const logged = await ingest({ secret });
      const tx = await storedTransaction(logged);

      expect(tx.categoryId).toBe(frequent.id);
      expect(tx.categorizationMeta ?? null).toBeNull();
      expect(logged.summary).toMatch(/ → Lunch$/);
    });

    it('breaks a tie between past categories in favor of the most recent one', async () => {
      const { account, secret } = await linkCard();
      const [older, newer] = await Promise.all([createCategory('Lunch'), createCategory('Coffee')]);
      await payeeWithHistory({
        accountId: account.id,
        history: [
          { categoryId: older.id, daysAgo: 20 },
          { categoryId: newer.id, daysAgo: 2 },
        ],
      });

      const tx = await storedTransaction(await ingest({ secret }));

      expect(tx.categoryId).toBe(newer.id);
    });

    it('lets a user automation win over the payee default and the history on a manual account', async () => {
      const { account, secret } = await linkCard();
      const [history, fixed, ruled] = await Promise.all([
        createCategory('Lunch'),
        createCategory('Bar, cafe'),
        createCategory('Treats'),
      ]);
      const payee = await payeeWithHistory({
        accountId: account.id,
        history: [{ categoryId: history.id, daysAgo: 5 }],
      });
      await helpers.updatePayee({
        id: payee.id,
        payload: { defaultCategoryId: fixed.id, categorizationMode: CATEGORIZATION_MODE.enforce },
        raw: true,
      });
      await noteRule({ keyword: 'heart', categoryId: ruled.id });

      const logged = await ingest({ secret });
      const tx = await storedTransaction(logged);

      expect(tx.categoryId).toBe(ruled.id);
      expect(tx.categorizationMeta?.source).toBe(CATEGORIZATION_SOURCE.userRule);
      expect(logged.summary).toMatch(/ → Treats$/);
    });
  });

  describe('a card with an account per currency', () => {
    /**
     * The owner's TBC card: a GEL and a USD account of its own, and the base-currency account as the
     * default for every other currency. Rates per USD make the cross rates exact: 1 GEL = 2 AED and
     * 1 EUR = 8 AED.
     */
    const setUpMultiCurrencyCard = async () => {
      await helpers.addUserCurrencies({ currencyCodes: ['GEL', 'USD', 'EUR'] });
      const { time } = await seedRateDay({ daysAgo: 6, aedPerUsd: 4, otherRatesPerUsd: { GEL: 2, EUR: 0.5 } });
      const fallback = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'Default' }),
        raw: true,
      });
      const gel = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'GEL', currencyCode: 'GEL' }),
        raw: true,
      });
      const usd = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'USD', currencyCode: 'USD' }),
        raw: true,
      });

      const link = ({ accountId, currencyCode }: { accountId: RecordId; currencyCode?: string }) =>
        helpers.createCardMapping({ payload: { cardLabel: CARD, accountId, currencyCode }, raw: true });
      const fallbackLink = await link({ accountId: fallback.id });
      await link({ accountId: gel.id, currencyCode: 'GEL' });
      await link({ accountId: usd.id, currencyCode: 'USD' });
      const { secret } = await ingestHelpers.createTestIngestToken();

      return { secret, time, fallback, fallbackLink, gel, usd };
    };

    it('books a GEL payment on the GEL account without a conversion', async () => {
      const { secret, time, gel } = await setUpMultiCurrencyCard();

      const logged = await ingest({ secret, overrides: { amount: '10.00', currency: 'GEL', time } });

      expect(await storedTransaction(logged)).toMatchObject({ accountId: gel.id, amount: 10, currencyCode: 'GEL' });
      expect(logged.summary).toBe(`Logged 10.00 GEL at ${MERCHANT} → Uncategorized`);
    });

    it('books a USD payment on the USD account without a conversion', async () => {
      const { secret, time, usd } = await setUpMultiCurrencyCard();

      const logged = await ingest({ secret, overrides: { amount: '10.00', currency: 'USD', time } });

      expect(await storedTransaction(logged)).toMatchObject({ accountId: usd.id, amount: 10, currencyCode: 'USD' });
    });

    it('books a payment in a currency with no account of its own on the default, converted', async () => {
      const { secret, time, fallback } = await setUpMultiCurrencyCard();

      const logged = await ingest({ secret, overrides: { amount: '10.00', currency: 'EUR', time } });

      expect(await storedTransaction(logged)).toMatchObject({
        accountId: fallback.id,
        amount: 80,
        originalAmount: 10,
        originalCurrencyCode: 'EUR',
      });
    });

    it('reads the currency from the amount text: a code, then a symbol', async () => {
      const { secret, time, gel, usd } = await setUpMultiCurrencyCard();

      const byCode = await ingest({ secret, overrides: { amount: '10.00 USD', time } });
      const bySymbol = await ingest({ secret, overrides: { amount: '₾10.00', time } });

      expect((await storedTransaction(byCode)).accountId).toBe(usd.id);
      expect((await storedTransaction(bySymbol)).accountId).toBe(gel.id);
    });

    it('books a payment that states no currency on the default account', async () => {
      const { secret, time, fallback } = await setUpMultiCurrencyCard();

      const logged = await ingest({ secret, overrides: { amount: '10.00', time } });

      expect(await storedTransaction(logged)).toMatchObject({
        accountId: fallback.id,
        currencyCode: global.BASE_CURRENCY_CODE,
      });
    });

    it('parks a payment in a currency the card has no account for when the card has no default', async () => {
      const { secret, time, fallbackLink } = await setUpMultiCurrencyCard();
      await helpers.deleteCardMapping({ id: fallbackLink.id });

      const parked = await send({ secret, body: payment({ amount: '10.00', currency: 'EUR', time }) });
      const stillLogged = await send({ secret, body: payment({ amount: '10.00', currency: 'GEL', time }) });

      expect(parked.status).toBe(202);
      expect(parked.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownCard' });
      expect(stillLogged.status).toBe(200);
      // The card still needs a default for its other currencies, so it stays on the unlinked list.
      expect(await helpers.listUnlinkedCards({ raw: true })).toEqual([{ cardLabel: CARD, count: 1 }]);
    });

    it('logs the parked payment on the default once the card has one', async () => {
      const { secret, time, fallback, fallbackLink } = await setUpMultiCurrencyCard();
      await helpers.deleteCardMapping({ id: fallbackLink.id });
      const body = payment({ amount: '10.00', currency: 'EUR', time });
      const parked = await send({ secret, body });
      await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: fallback.id }, raw: true });

      const retried = await helpers.retryCardPaymentRequest({ id: parked.body.response.requestId, raw: true });

      expect(retried.outcome).toBe('logged');
      expect(await helpers.listUnlinkedCards({ raw: true })).toEqual([]);
    });

    it('names the default account in a dry run', async () => {
      const { secret } = await setUpMultiCurrencyCard();

      const res = await send({ secret, body: { dryRun: true, card: CARD } });

      expect(res.body.response.summary).toMatch(/Card "TBC Visa" → Default$/);
    });
  });

  describe('currency', () => {
    it('converts a payment in another currency and keeps the original amount', async () => {
      await helpers.addUserCurrencies({ currencyCodes: ['USD'] });
      const { time } = await seedRateDay({ daysAgo: 6 });
      const { secret } = await linkCard();

      // 12.19 x 3.5 = 42.665, a tie that half-even rounds down to 42.66 and half-up would send to 42.67.
      const logged = await ingest({ secret, overrides: { amount: '12.19', currency: 'USD', time } });
      const tx = await storedTransaction(logged);

      expect(tx).toMatchObject({ amount: 42.66, originalAmount: 12.19, originalCurrencyCode: 'USD' });
      expect(logged.summary).toBe(
        `Logged 12.19 USD (42.66 ${global.BASE_CURRENCY_CODE}) at ${MERCHANT} → Uncategorized`,
      );
    });

    it('parks a payment whose currency has no rate to the account currency', async () => {
      await helpers.addUserCurrencies({ currencyCodes: ['SSP'] });
      await helpers.removeExchangeRatesForCurrency({ code: 'SSP' });
      const { time } = await seedRateDay({ daysAgo: 7 });
      const { secret } = await linkCard();

      const res = await send({ secret, body: payment({ currency: 'SSP', time }) });

      expect(res.status).toBe(202);
      expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'rateUnavailable' });
      expect(res.body.response.summary).toBe(
        `Not logged yet: no SSP→${global.BASE_CURRENCY_CODE} rate for ${time.slice(0, 10)}`,
      );
      expect(await helpers.getTransactions({ raw: true })).toEqual([]);

      const stored = await IngestRequests.findOne({ where: { id: res.body.response.requestId } });
      expect(stored).toMatchObject({ status: 'parked', reason: 'rateUnavailable' });
    });

    it('parks a payment when the account has no rate to the base currency', async () => {
      await helpers.addUserCurrencies({ currencyCodes: ['KPW'] });
      const account = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ currencyCode: 'KPW' }),
        raw: true,
      });
      await helpers.removeExchangeRatesForCurrency({ code: 'KPW' });
      const { time } = await seedRateDay({ daysAgo: 8 });
      const { secret } = await linkCard({ account });

      const res = await send({ secret, body: payment({ time }) });

      expect(res.status).toBe(202);
      expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'rateUnavailable' });
      expect(res.body.response.summary).toBe(
        `Not logged yet: no KPW→${global.BASE_CURRENCY_CODE} rate for ${time.slice(0, 10)}`,
      );
      expect(await helpers.getTransactions({ raw: true })).toEqual([]);

      const stored = await IngestRequests.findOne({ where: { id: res.body.response.requestId } });
      expect(stored).toMatchObject({ status: 'parked', reason: 'rateUnavailable', transactionId: null });
    });

    it('parks a payment into a custom-currency account that has no rate yet', async () => {
      const created = await helpers.createCustomCurrency({ payload: { code: 'LYT', name: 'Loyalty', decimals: 2 } });
      expect(created.statusCode).toBe(201);
      const account = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ currencyCode: 'LYT', initialBalance: 0 }),
        raw: true,
      });
      const { secret } = await linkCard({ account });

      const res = await send({ secret, body: payment({ currency: global.BASE_CURRENCY_CODE }) });

      expect(res.status).toBe(202);
      expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'rateUnavailable' });
      expect(res.body.response.summary).toContain(`no ${global.BASE_CURRENCY_CODE}→LYT rate`);
      expect(await helpers.getTransactions({ raw: true })).toEqual([]);
    });
  });

  describe('bank-connected account', () => {
    it('creates a planned row that does not touch the balance and says the bank will confirm it', async () => {
      const account = await connectedAccount();
      const { secret } = await linkCard({ account });
      const before = await helpers.getAccount({ id: account.id, raw: true });

      const logged = await ingest({ secret });
      const tx = await storedTransaction(logged);

      expect(logged.planned).toBe(true);
      expect(tx.isPlanned).toBe(true);
      expect(logged.summary).toMatch(
        /^Noted 47\.00 [A-Z]{3} at Cafe Heart of Batumi → Uncategorized; the bank sync will confirm it$/,
      );
      expect((await helpers.getAccount({ id: account.id, raw: true })).currentBalance).toEqual(before.currentBalance);
    });

    it('runs the user automations on the plan, but still not on a plan the user wrote', async () => {
      const account = await connectedAccount();
      const { secret } = await linkCard({ account });
      const ruled = await createCategory('Treats');
      await noteRule({ keyword: 'heart', categoryId: ruled.id });

      const [userPlan] = await helpers.createPlannedTransaction({
        payload: { accountId: account.id, note: 'Heart of the matter' },
        raw: true,
      });
      const logged = await ingest({ secret });
      const tx = await storedTransaction(logged);

      expect(tx).toMatchObject({ isPlanned: true, categoryId: ruled.id });
      expect(tx.categorizationMeta?.source).toBe(CATEGORIZATION_SOURCE.userRule);
      expect(logged.summary).toMatch(/ → Treats; the bank sync will confirm it$/);

      const written = await storedTransaction({ transactionId: userPlan!.id });
      expect(written.categoryId).toBe(global.DEFAULT_CATEGORY_ID);
      expect(written.categorizationMeta ?? null).toBeNull();
    });
  });

  describe('time', () => {
    it('stores the time the payment was sent with', async () => {
      const { secret } = await linkCard();
      const sentAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
      sentAt.setMilliseconds(0);

      const tx = await storedTransaction(await ingest({ secret, overrides: { time: sentAt.toISOString() } }));

      expect(new Date(tx.time).toISOString()).toBe(sentAt.toISOString());
    });
  });
});
