import { buildSourceKey, TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import Transactions from '@models/transactions.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import { approveCardAsIs, confirmCardOf } from '@tests/helpers/ingest-cards';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { addMinutes, format, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from '../event/constants';
import { woltOnlinePayment } from '../event/fixtures/notifications';
import { TAP_SLOT, WALLET_NOTIFICATION_SLOT } from './source-slots';

const CARD = woltOnlinePayment.tap.card;
const DEFAULT_TIMINGS = { ...notificationTimings };
const RATE_DAYS_AGO = 6;
const Example_KEY = buildSourceKey({ bundleId: null, appName: 'Example Bank' });
const BOG_KEY = buildSourceKey({ bundleId: null, appName: 'Bank of Georgia' });

/** The payee answer that works whether the payee exists already (candidate) or not yet (new name). */
const WOLT_PAYEE = { candidateId: 'p1', newName: 'Wolt' };

const SEEDED_DATES: Date[] = [];

/** The date the payment happened on, as the bank's text prints it (`yyyy-MM-dd`). */
let paymentDay = '';

/**
 * A day with pinned rates (1 USD = 2 GEL = 4 AED), so every converted amount is exact. Returns the
 * moment of the Wallet notification, 14:38 UTC; the bank's push reads 18:40 on the wall two minutes later (UTC+4).
 */
const seedRateDay = async () => {
  const day = subDays(startOfDay(new Date()), RATE_DAYS_AGO);
  SEEDED_DATES.push(day);
  paymentDay = format(day, 'yyyy-MM-dd');
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { AED: 4, GEL: 2 } });

  return addMinutes(day, 14 * 60 + 38);
};

type Source = 'tap' | 'wallet' | 'push' | 'bog';

/** The seconds after noon at which each source of the payment reaches the phone. */
const SOURCE_OFFSET_SECONDS: Record<Source, number> = { wallet: 0, tap: 3, push: 125, bog: 150 };

/** What the model answers: the Example push of the owner's phone, or the other bank's text of the same payment. */
const answerFor = ({ prompt }: { prompt: string }) =>
  prompt.includes('EXAMPLE CARD VISA GOLD')
    ? { ...woltOnlinePayment.bankPushAnswer, occurredAt: `${paymentDay}T18:40:00`, payee: WOLT_PAYEE }
    : {
        kind: 'debit' as const,
        amount: '29.41',
        currency: 'GEL',
        merchant: 'WOLT.COM LISBON',
        cardLastDigits: '0000',
        payee: WOLT_PAYEE,
      };

const setUp = async ({ withUsd = false, holdsUsd = false }: { withUsd?: boolean; holdsUsd?: boolean } = {}) => {
  await helpers.addUserCurrencies({ currencyCodes: withUsd || holdsUsd ? ['GEL', 'USD'] : ['GEL'] });
  const noon = await seedRateDay();
  const gel = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ name: 'Example GEL', currencyCode: 'GEL', initialBalance: 1000 }),
    raw: true,
  });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: gel.id, lastDigits: '0000' }, raw: true });

  let usd: { id: RecordId } | null = null;
  if (withUsd) {
    usd = await helpers.createAccount({
      payload: helpers.buildAccountPayload({ name: 'Example USD', currencyCode: 'USD', initialBalance: 500 }),
      raw: true,
    });
    await helpers.createCardMapping({
      payload: { cardLabel: CARD, accountId: usd.id, currencyCode: 'USD' },
      raw: true,
    });
  }

  const { secret } = await ingestHelpers.createTestIngestToken();

  return { gel, usd, secret, noon };
};

const timeOf = ({ noon, seconds }: { noon: Date; seconds: number }) =>
  new Date(noon.getTime() + seconds * 1000).toISOString();

/** Sends one source of the Wolt payment the way its channel does, with the time its device stamped. */
const sendSource = ({
  secret,
  noon,
  source,
  bogBody = 'Purchase 29.41 GEL, WOLT.COM LISBON, card *0000',
}: {
  secret: string;
  noon: Date;
  source: Source;
  /** What the other bank's push prints. */
  bogBody?: string;
}) => {
  const time = timeOf({ noon, seconds: SOURCE_OFFSET_SECONDS[source] });
  const idempotencyKey = `key-${source}-${randomUUID()}`;

  switch (source) {
    case 'tap':
      return ingestHelpers.postCardPayment({
        secret,
        body: { ...woltOnlinePayment.tap, source: 'apple-pay', time, idempotencyKey },
      });

    case 'wallet':
      return ingestHelpers.postIngestEvent({
        secret,
        body: {
          kind: 'notification',
          app: woltOnlinePayment.wallet.appName,
          title: woltOnlinePayment.wallet.title,
          subtitle: woltOnlinePayment.wallet.subtitle,
          body: woltOnlinePayment.wallet.body,
          time,
          idempotencyKey,
        },
      });

    case 'push':
      return ingestHelpers.postIngestEvent({
        secret,
        body: {
          kind: 'notification',
          app: woltOnlinePayment.bankPush.appName,
          title: woltOnlinePayment.bankPush.title,
          subtitle: woltOnlinePayment.bankPush.subtitle,
          body: woltOnlinePayment.bankPush.body,
          time,
          idempotencyKey,
        },
      });

    case 'bog':
      return ingestHelpers.postIngestEvent({
        secret,
        body: {
          kind: 'notification',
          app: 'Bank of Georgia',
          title: 'BOG',
          subtitle: '',
          body: bogBody,
          time,
          idempotencyKey,
        },
      });
  }
};

const allRows = () => Transactions.findAll({ order: [['createdAt', 'ASC']] });

interface StoredSource {
  requestId: RecordId;
  slot: string;
  sourceKey: string | null;
  balanceAfter?: { authoritative: boolean; amount: string } | null;
  occurredAt?: string;
}

const sourcesOf = ({ row }: { row: Transactions }) =>
  ((row.externalData.ingest as { sources: StoredSource[] }).sources ?? []) as StoredSource[];

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

describe('twin and settlement rules', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    enableServerModel();
    notificationTimings.categorizeWaitMs = 50;
    notificationTimings.retryBackoffMs = 10;
    await resetLimits();
  });

  afterEach(async () => {
    Object.assign(notificationTimings, DEFAULT_TIMINGS);
    await helpers.clearExchangeRatesForDates({ dates: SEEDED_DATES.splice(0) });
    await resetLimits();
  });

  describe('one payment, every source, any order', () => {
    it.each<{ order: Source[] }>([
      { order: ['tap', 'wallet', 'push', 'bog'] },
      { order: ['push', 'bog', 'wallet', 'tap'] },
      { order: ['wallet', 'tap', 'bog', 'push'] },
      { order: ['bog', 'push', 'tap', 'wallet'] },
    ])('gives one row with every source for $order', async ({ order }) => {
      mockNotificationParsing({ answer: answerFor });
      const { gel, secret, noon } = await setUp();

      for (const [index, source] of order.entries()) {
        const res = await sendSource({ secret, noon, source });

        expect(res.status).toBe(200);
        if (index === 0) {
          expect(res.body.response.outcome).toBe('logged');
          expect(res.body.response.summary).toMatch(/^Logged /);
        } else if (source === 'tap') {
          // The tap answers like a repeat.
          expect(res.body.response).toMatchObject({ outcome: 'logged', duplicate: true });
          expect(res.body.response.summary).toMatch(/^Already logged 29\.41 GEL at /);
        } else {
          expect(res.body.response.outcome).toBe('attached');
          expect(res.body.response.summary).toMatch(/^Already logged 29\.41 GEL at /);
        }
      }

      const rows = await allRows();
      expect(rows).toHaveLength(1);

      const row = rows[0]!;
      expect(row).toMatchObject({ accountId: gel.id, transactionType: TRANSACTION_TYPES.expense });
      expect(row.amount.toNumber()).toBe(29.41);
      expect(
        sourcesOf({ row })
          .map((source) => source.slot)
          .toSorted(),
      ).toEqual(
        [TAP_SLOT, WALLET_NOTIFICATION_SLOT, `bank:${Example_KEY}:payment`, `bank:${BOG_KEY}:payment`].toSorted(),
      );
      expect((row.externalData.ingest as { cardLastDigits?: string }).cardLastDigits).toBe('0000');
      expect(row.payeeId).toEqual(expect.any(String));

      const payees = await helpers.listPayees({ raw: true });
      expect(payees.map((payee) => payee.name)).toEqual(['Wolt']);
      expect(await helpers.listUnconfirmedCardPayments({ raw: true })).toHaveLength(1);
      // Every source's spelling becomes an alias of the one payee once the owner confirms the payment.
      const aliasesOfWolt = async () =>
        ((await helpers.getPayeeById({ id: payees[0]!.id, raw: true })).aliases ?? []).map(
          (alias) => alias.normalizedName,
        );
      expect(await aliasesOfWolt()).not.toContain('wolt com lisbon');
      await approveCardAsIs({ card: await confirmCardOf({ transactionId: row.id }) });
      expect(await aliasesOfWolt()).toContain('wolt com lisbon');

      const account = await helpers.getAccount({ id: gel.id, raw: true });
      expect(account.currentBalance).toBe(1000 - 29.41);

      const requests = await IngestRequests.findAll();
      expect(requests).toHaveLength(order.length);
      expect(new Set(requests.map((request) => request.transactionId))).toEqual(new Set([row.id]));
    });
  });

  describe('the real Example push after the Wallet notification', () => {
    it('adds the card digits and the bank time, and keeps the multi-currency balance informational', async () => {
      mockNotificationParsing({ answer: answerFor });
      const { secret, noon } = await setUp({ withUsd: true });

      await sendSource({ secret, noon, source: 'wallet' });
      const res = await sendSource({ secret, noon, source: 'push' });
      expect(res.body.response.outcome).toBe('attached');

      const [row] = await allRows();
      const [walletSource, bankSource] = sourcesOf({ row: row! });

      expect(walletSource!.slot).toBe(WALLET_NOTIFICATION_SLOT);
      expect(bankSource!.slot).toBe(`bank:${Example_KEY}:payment`);
      expect((row!.externalData.ingest as { cardLastDigits?: string }).cardLastDigits).toBe('0000');

      // The push prints 18:40 on the wall and the phone stamped it 14:40:05 UTC, so the bank's time is 14:40 UTC.
      expect(row!.time.toISOString()).toBe(new Date(noon.getTime() + 2 * 60_000).toISOString());
      expect(bankSource!.occurredAt).toBe(row!.time.toISOString());

      // GEL and USD both hold money, so the total in GEL is not the GEL account's balance.
      expect(bankSource!.balanceAfter).toMatchObject({ amount: '3816.41', authoritative: false });
    });
  });

  describe('two identical coffees', () => {
    it('gives two rows with two sources each for tap, tap, Wallet, Wallet', async () => {
      mockNotificationParsing({ answer: answerFor });
      const { secret, noon } = await setUp();

      const tap = (seconds: number) =>
        ingestHelpers.postCardPayment({
          secret,
          body: {
            ...woltOnlinePayment.tap,
            source: 'apple-pay',
            time: timeOf({ noon, seconds }),
            idempotencyKey: `tap-${randomUUID()}`,
          },
        });
      const wallet = (seconds: number) =>
        ingestHelpers.postIngestEvent({
          secret,
          body: {
            kind: 'notification',
            app: 'Wallet',
            title: woltOnlinePayment.wallet.title,
            subtitle: woltOnlinePayment.wallet.subtitle,
            body: woltOnlinePayment.wallet.body,
            time: timeOf({ noon, seconds }),
            idempotencyKey: `wallet-${randomUUID()}`,
          },
        });

      const firstTap = await tap(0);
      const secondTap = await tap(60);
      const firstWallet = await wallet(62);
      const secondWallet = await wallet(122);

      expect(firstTap.body.response.duplicate).toBeUndefined();
      expect(secondTap.body.response.duplicate).toBeUndefined();
      expect(firstWallet.body.response.outcome).toBe('attached');
      expect(secondWallet.body.response.outcome).toBe('attached');

      const rows = await allRows();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(
          sourcesOf({ row })
            .map((source) => source.slot)
            .toSorted(),
        ).toEqual([TAP_SLOT, WALLET_NOTIFICATION_SLOT].toSorted());
      }

      const account = await helpers.getAccount({ id: rows[0]!.accountId, raw: true });
      expect(account.currentBalance).toBe(1000 - 2 * 29.41);
    });

    it('keeps two Wallet notifications of the same amount two rows when no tap is involved', async () => {
      const { secret, noon } = await setUp();

      await sendSource({ secret, noon, source: 'wallet' });
      const second = await ingestHelpers.postIngestEvent({
        secret,
        body: {
          kind: 'notification',
          app: 'Wallet',
          title: woltOnlinePayment.wallet.title,
          subtitle: woltOnlinePayment.wallet.subtitle,
          body: woltOnlinePayment.wallet.body,
          time: timeOf({ noon, seconds: 600 }),
          idempotencyKey: `wallet-${randomUUID()}`,
        },
      });

      expect(second.body.response.outcome).toBe('logged');
      expect(await allRows()).toHaveLength(2);
    });
  });

  describe('what is not the same payment', () => {
    it('keeps another shop with the same amount apart', async () => {
      mockNotificationParsing({
        answer: () => ({ kind: 'debit', amount: '29.41', currency: 'GEL', merchant: 'Glovo', cardLastDigits: '0000' }),
      });
      const { secret, noon } = await setUp();

      await sendSource({ secret, noon, source: 'wallet' });
      const res = await sendSource({ secret, noon, source: 'push' });

      expect(res.body.response.outcome).toBe('logged');
      expect(await allRows()).toHaveLength(2);
    });

    it('keeps a payment more than thirty minutes later apart', async () => {
      mockNotificationParsing({ answer: answerFor });
      const { secret, noon } = await setUp();

      await sendSource({ secret, noon, source: 'wallet' });
      const res = await ingestHelpers.postIngestEvent({
        secret,
        body: {
          kind: 'notification',
          app: woltOnlinePayment.bankPush.appName,
          title: woltOnlinePayment.bankPush.title,
          subtitle: '',
          body: woltOnlinePayment.bankPush.body,
          time: timeOf({ noon, seconds: 31 * 60 }),
          idempotencyKey: `push-${randomUUID()}`,
        },
      });

      expect(res.body.response.outcome).toBe('logged');
      expect(await allRows()).toHaveLength(2);
    });

    it('does not absorb a row the owner typed by hand', async () => {
      const { gel, secret, noon } = await setUp();
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: gel.id,
          amount: 29.41,
          time: timeOf({ noon, seconds: -60 }),
        }),
        raw: true,
      });

      const res = await sendSource({ secret, noon, source: 'wallet' });

      expect(res.body.response.outcome).toBe('logged');
      expect(await allRows()).toHaveLength(2);
    });
  });

  describe('a payment in a foreign currency', () => {
    it('takes the bank amount in the account currency, and the balance follows', async () => {
      mockNotificationParsing({
        answer: () => ({
          kind: 'debit',
          amount: '20.50',
          currency: 'GEL',
          originalAmount: '10.00',
          originalCurrency: 'USD',
          merchant: 'WOLT.COM LISBON',
          cardLastDigits: '0000',
          payee: WOLT_PAYEE,
        }),
      });
      const { gel, secret, noon } = await setUp({ holdsUsd: true });

      // The tap relays what the card was charged: 10 USD, converted at the day's rate (1 USD = 2 GEL).
      const tap = await ingestHelpers.postCardPayment({
        secret,
        body: {
          amount: 'USD 10.00',
          merchant: 'Wolt',
          card: CARD,
          source: 'apple-pay',
          time: timeOf({ noon, seconds: 0 }),
          idempotencyKey: `tap-${randomUUID()}`,
        },
      });
      expect(tap.status).toBe(200);
      expect((await allRows())[0]!.amount.toNumber()).toBe(20);

      const bank = await sendSource({
        secret,
        noon,
        source: 'bog',
        bogBody: 'Purchase 20.50 GEL (10.00 USD), WOLT.COM LISBON, card *0000',
      });
      expect(bank.body.response.outcome).toBe('attached');

      const rows = await allRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.amount.toNumber()).toBe(20.5);
      expect(rows[0]!.originalAmount!.toNumber()).toBe(10);
      expect(rows[0]!.originalCurrencyCode).toBe('USD');

      const account = await helpers.getAccount({ id: gel.id, raw: true });
      expect(account.currentBalance).toBe(1000 - 20.5);
    });
  });

  describe('enrichment', () => {
    it('fills the payee a row lacks from the source that resolved one', async () => {
      mockNotificationParsing({
        answer: () => ({
          kind: 'debit',
          amount: '29.41',
          currency: 'GEL',
          merchant: 'Wolt Georgia',
          cardLastDigits: '0000',
        }),
      });
      await helpers.addIgnoredName({ rawName: 'Wolt Georgia' });
      const { secret, noon } = await setUp();

      await sendSource({ secret, noon, source: 'bog' });
      expect((await allRows())[0]!.payeeId).toBeNull();

      const res = await sendSource({ secret, noon, source: 'wallet' });
      expect(res.body.response.outcome).toBe('attached');

      const [row] = await allRows();
      const payees = await helpers.listPayees({ raw: true });
      expect(payees.map((payee) => payee.name)).toEqual(['Wolt']);
      expect(row!.payeeId).toBe(payees[0]!.id);
    });
  });

  describe('settlement', () => {
    const bankText = ({ stage, merchant }: { stage: 'authorization' | 'settlement'; merchant: string }) => ({
      kind: 'debit' as const,
      stage,
      amount: '29.41',
      currency: 'GEL',
      merchant,
      cardLastDigits: '0000',
      payee: WOLT_PAYEE,
    });

    const sendBank = ({ secret, noon, seconds, body }: { secret: string; noon: Date; seconds: number; body: string }) =>
      ingestHelpers.postIngestEvent({
        secret,
        body: {
          kind: 'notification',
          app: 'Example Bank',
          title: 'Example',
          subtitle: '',
          body,
          time: timeOf({ noon, seconds }),
          idempotencyKey: `bank-${randomUUID()}`,
        },
      });

    it('attaches a settlement two days later to its own authorization', async () => {
      mockNotificationParsing({
        answer: ({ prompt }) =>
          bankText({ stage: prompt.includes('Settled') ? 'settlement' : 'authorization', merchant: 'Wolt' }),
      });
      const { secret, noon } = await setUp();

      await sendBank({ secret, noon, seconds: 0, body: 'Hold 29.41 GEL, Wolt, card *0000' });
      const settlement = await sendBank({
        secret,
        noon,
        seconds: 2 * 24 * 3600,
        body: 'Settled 29.41 GEL, Wolt, card *0000',
      });

      expect(settlement.body.response.outcome).toBe('attached');
      expect(settlement.body.response.summary).toMatch(/^Already logged 29\.41 GEL at Wolt/);

      const rows = await allRows();
      expect(rows).toHaveLength(1);
      expect(sourcesOf({ row: rows[0]! }).map((source) => source.slot)).toEqual([
        `bank:${Example_KEY}:authorization`,
        `bank:${Example_KEY}:settlement`,
      ]);
    });

    it('logs a settlement with a different merchant text as a new row', async () => {
      mockNotificationParsing({
        answer: ({ prompt }) =>
          prompt.includes('Settled')
            ? bankText({ stage: 'settlement', merchant: 'Bolt Food' })
            : bankText({ stage: 'authorization', merchant: 'Wolt' }),
      });
      const { secret, noon } = await setUp();

      await sendBank({ secret, noon, seconds: 0, body: 'Hold 29.41 GEL, Wolt, card *0000' });
      const settlement = await sendBank({
        secret,
        noon,
        seconds: 2 * 24 * 3600,
        body: 'Settled 29.41 GEL, Bolt Food, card *0000',
      });

      expect(settlement.body.response.outcome).toBe('logged');
      expect(await allRows()).toHaveLength(2);
    });
  });
});
