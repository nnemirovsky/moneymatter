import { TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import Transactions from '@models/transactions.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { addMinutes, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from '../event/constants';
import { woltOnlinePayment } from '../event/fixtures/notifications';

const CARD = woltOnlinePayment.tap.card;
const DEFAULT_TIMINGS = { ...notificationTimings };
const SEEDED_DATES: Date[] = [];

/** A day with pinned rates (1 USD = 2 GEL = 1 EUR = 4 AED), so every converted amount is exact. */
const seedRateDay = async () => {
  const day = subDays(startOfDay(new Date()), 6);
  SEEDED_DATES.push(day);
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { AED: 4, GEL: 2, EUR: 1 } });

  return addMinutes(day, 14 * 60 + 38);
};

interface SetUpOptions {
  gelBalance?: number;
  usdBalance?: number;
  /** An extra EUR account on the card. */
  eurBalance?: number;
  /** A card with its GEL account as the default and nothing else. */
  onlyDefault?: boolean;
}

const account = ({
  name,
  currencyCode,
  initialBalance,
}: {
  name: string;
  currencyCode: string;
  initialBalance: number;
}) =>
  helpers.createAccount({
    payload: helpers.buildAccountPayload({ name, currencyCode, initialBalance }),
    raw: true,
  });

/** The owner's multi-currency card: GEL is the default account, USD (and EUR) have rows of their own. */
const setUp = async ({ gelBalance = 10, usdBalance = 500, eurBalance, onlyDefault = false }: SetUpOptions = {}) => {
  await helpers.addUserCurrencies({ currencyCodes: ['GEL', 'USD', 'EUR'] });
  const noon = await seedRateDay();
  const gel = await account({ name: 'Example GEL', currencyCode: 'GEL', initialBalance: gelBalance });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: gel.id }, raw: true });

  const usd = await account({ name: 'Example USD', currencyCode: 'USD', initialBalance: usdBalance });
  const eur =
    eurBalance === undefined
      ? null
      : await account({ name: 'Example EUR', currencyCode: 'EUR', initialBalance: eurBalance });
  if (!onlyDefault) {
    await helpers.createCardMapping({
      payload: { cardLabel: CARD, accountId: usd.id, currencyCode: 'USD' },
      raw: true,
    });
    if (eur) {
      await helpers.createCardMapping({
        payload: { cardLabel: CARD, accountId: eur.id, currencyCode: 'EUR' },
        raw: true,
      });
    }
  }

  return { gel, usd, eur, noon, secret: (await ingestHelpers.createTestIngestToken()).secret };
};

const walletPayment = ({ secret, noon, amount }: { secret: string; noon: Date; amount: string }) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'Wallet',
      title: CARD,
      subtitle: 'Wolt',
      body: amount,
      time: noon.toISOString(),
      idempotencyKey: `wallet-${randomUUID()}`,
    },
  });

const correctionOf = async ({ transactionId }: { transactionId: string }) =>
  (await helpers.listUnconfirmedCardPayments({ raw: true })).find((entry) => entry.transactionId === transactionId)
    ?.correction ?? null;

const balanceOf = async ({ id }: { id: string }) => (await helpers.getAccount({ id, raw: true })).currentBalance;

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

describe('short-balance correction', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    notificationTimings.categorizeWaitMs = 50;
    await resetLimits();
  });

  afterEach(async () => {
    Object.assign(notificationTimings, DEFAULT_TIMINGS);
    await helpers.clearExchangeRatesForDates({ dates: SEEDED_DATES.splice(0) });
    await resetLimits();
  });

  describe('when a transfer into the account lands around the payment', () => {
    const topUp = ({ usdId, gelId, at }: { usdId: RecordId; gelId: RecordId; at: Date }) =>
      helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: usdId,
          amount: 100,
          time: at.toISOString(),
          transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer,
          destinationAmount: 200,
          destinationAccountId: gelId,
        }),
        raw: true,
      });

    it('withdraws the suggestion once the conversion that covers the payment is booked a minute later', async () => {
      const { gel, usd, noon, secret } = await setUp();
      const res = await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });
      expect(res.body.response.outcome).toBe('logged');
      const tx = (await Transactions.findOne({
        where: { accountId: gel.id, transactionType: TRANSACTION_TYPES.expense },
      }))!;
      expect(await correctionOf({ transactionId: tx.id })).toMatchObject({ status: 'open' });

      await topUp({ usdId: usd.id, gelId: gel.id, at: addMinutes(noon, 1) });

      await until(async () => (await correctionOf({ transactionId: tx.id }))?.status === 'dismissed', {
        timeout: 15_000,
        interval: 200,
      });
    });

    it('places an exchange told after the payment just before it, and withdraws the suggestion it covers', async () => {
      enableServerModel();
      mockNotificationParsing({ answer: () => ({}) });
      const { gel, noon, secret } = await setUp();
      await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });
      const tx = (await Transactions.findOne({
        where: { accountId: gel.id, transactionType: TRANSACTION_TYPES.expense },
      }))!;
      expect(await correctionOf({ transactionId: tx.id })).toMatchObject({ status: 'open' });

      // The exchange notice carries no time and arrives two minutes after the payment's.
      await ingestHelpers.postIngestEvent({
        secret,
        body: {
          kind: 'notification',
          app: 'Example Bank',
          title: 'Example Bank',
          subtitle: '',
          body: 'Conversion:\n20.00 USD\n40.00 GEL\nRate: 2\n15/01/2026',
          time: addMinutes(noon, 2).toISOString(),
          idempotencyKey: `push-${randomUUID()}`,
        },
      });
      const threads = (await helpers.listChatThreads({ raw: true })).threads.filter(
        (thread) => thread.kind === 'automationInbox',
      );
      let card: { id: string; revision: number } | undefined;
      await until(
        async () => {
          for (const thread of threads.length ? threads : (await helpers.listChatThreads({ raw: true })).threads) {
            const found = Object.values(
              (await helpers.getChatThread({ threadId: thread.id, limit: 100, raw: true })).cards,
            ).find((entry) => entry.toolName === 'log_ingest_request' && entry.status === 'pending');
            if (found) card = found;
          }

          return Boolean(card);
        },
        { timeout: 30_000, interval: 200 },
      );
      const fresh = await helpers.refreshChatProposal({ proposalId: card!.id, raw: true });
      const approved = await helpers.approveChatProposal({
        proposalId: fresh.id,
        payload: { revision: fresh.revision },
      });
      expect(approved.statusCode).toBe(200);

      await until(async () => (await correctionOf({ transactionId: tx.id }))?.status === 'dismissed', {
        timeout: 30_000,
        interval: 200,
      });
      const exchange = await Transactions.findAll({
        where: { transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer },
      });
      expect(exchange).toHaveLength(2);
      for (const leg of exchange) expect(leg.time.toISOString()).toBe(addMinutes(tx.time, -1).toISOString());
    });

    it('keeps the suggestion when the transfer is too small to cover the payment', async () => {
      const { gel, usd, noon, secret } = await setUp();
      await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });
      const tx = (await Transactions.findOne({
        where: { accountId: gel.id, transactionType: TRANSACTION_TYPES.expense },
      }))!;

      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: usd.id,
          amount: 1,
          time: addMinutes(noon, 1).toISOString(),
          transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer,
          destinationAmount: 2,
          destinationAccountId: gel.id,
        }),
        raw: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(await correctionOf({ transactionId: tx.id })).toMatchObject({ status: 'open' });
    });

    it('makes no suggestion when the conversion was booked first', async () => {
      const { gel, usd, noon, secret } = await setUp();
      await topUp({ usdId: usd.id, gelId: gel.id, at: addMinutes(noon, -1) });

      await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });

      const tx = (await Transactions.findOne({
        where: { accountId: gel.id, transactionType: TRANSACTION_TYPES.expense },
      }))!;
      expect(await correctionOf({ transactionId: tx.id })).toBeNull();
    });
  });

  describe('without a model', () => {
    it('suggests the account that covers the payment, with an estimate and no reason', async () => {
      const { gel, usd, noon, secret } = await setUp();

      const res = await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });
      expect(res.body.response.outcome).toBe('logged');

      const tx = (await Transactions.findOne({ where: { accountId: gel.id } }))!;
      expect(await correctionOf({ transactionId: tx.id })).toEqual({
        kind: 'shortBalance',
        status: 'open',
        balanceBefore: { amount: 10, currencyCode: 'GEL' },
        suggestedAccountId: usd.id,
        estimatedAmount: { amount: 14.7, currencyCode: 'USD', estimate: true },
        candidates: [{ accountId: usd.id, currencyCode: 'USD', balance: 500, estimatedAmount: 14.7, isDefault: false }],
        reason: null,
        composedBy: 'rules',
        createdAt: expect.any(String),
      });

      // Nothing moved: the payment is on the account it was logged to.
      expect(await balanceOf({ id: gel.id })).toBe(10 - 29.41);
      expect(await balanceOf({ id: usd.id })).toBe(500);
    });

    it('offers the card default first when the short account is a currency one', async () => {
      const { gel, usd, noon, secret } = await setUp({ gelBalance: 1000, usdBalance: 5 });

      await walletPayment({ secret, noon, amount: 'USD 10.00' });

      const tx = (await Transactions.findOne({ where: { accountId: usd.id } }))!;
      const correction = await correctionOf({ transactionId: tx.id });
      expect(correction).toMatchObject({
        suggestedAccountId: gel.id,
        estimatedAmount: { amount: 20, currencyCode: 'GEL', estimate: true },
        candidates: [{ accountId: gel.id, isDefault: true }],
      });
    });

    it('ranks the covering accounts by default, then by the fullest balance', async () => {
      const { gel, usd, eur, noon, secret } = await setUp({ eurBalance: 900 });

      const res = await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });
      expect(res.body.response.outcome).toBe('logged');

      const tx = (await Transactions.findOne({ where: { accountId: gel.id } }))!;
      const correction = await correctionOf({ transactionId: tx.id });
      expect(correction!.candidates.map((candidate) => candidate.accountId)).toEqual([eur!.id, usd.id]);
      expect(correction!.suggestedAccountId).toBe(eur!.id);
    });

    it('suggests nothing when the balance covered the payment', async () => {
      const { gel, noon, secret } = await setUp({ gelBalance: 100 });

      await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });

      const tx = (await Transactions.findOne({ where: { accountId: gel.id } }))!;
      expect(await correctionOf({ transactionId: tx.id })).toBeNull();
    });

    it('suggests nothing when no other account covers the converted amount', async () => {
      const { gel, noon, secret } = await setUp({ usdBalance: 1 });

      await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });

      const tx = (await Transactions.findOne({ where: { accountId: gel.id } }))!;
      expect(await correctionOf({ transactionId: tx.id })).toBeNull();
    });

    it('suggests nothing for a card that has no other account', async () => {
      const { gel, noon, secret } = await setUp({ onlyDefault: true });

      await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });

      const tx = (await Transactions.findOne({ where: { accountId: gel.id } }))!;
      expect(await correctionOf({ transactionId: tx.id })).toBeNull();
    });

    it('also suggests for a tap', async () => {
      const { gel, usd, noon, secret } = await setUp();

      const res = await ingestHelpers.postCardPayment({
        secret,
        body: {
          ...woltOnlinePayment.tap,
          source: 'apple-pay',
          time: noon.toISOString(),
          idempotencyKey: `tap-${randomUUID()}`,
        },
      });
      expect(res.status).toBe(200);

      const tx = (await Transactions.findOne({ where: { accountId: gel.id } }))!;
      expect(await correctionOf({ transactionId: tx.id })).toMatchObject({ suggestedAccountId: usd.id });
    });
  });

  describe('with a model', () => {
    beforeEach(() => {
      enableServerModel();
    });

    it('takes the ranking and the one-line reason the model composed', async () => {
      const correctionPrompts: string[] = [];
      mockNotificationParsing({
        answer: () => ({}),
        correctionPrompts,
        // The covering accounts are shown fullest first: a1 is EUR, a2 is USD.
        correction: () => ({ ranking: ['a2', 'a1'], reason: 'The USD balance covers it and is the one used before.' }),
      });
      const { gel, usd, eur, noon, secret } = await setUp({ eurBalance: 900 });

      await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });

      const tx = (await Transactions.findOne({ where: { accountId: gel.id } }))!;
      const correction = await correctionOf({ transactionId: tx.id });
      expect(correction).toMatchObject({
        composedBy: 'ai',
        reason: 'The USD balance covers it and is the one used before.',
        suggestedAccountId: usd.id,
      });
      expect(correction!.candidates.map((candidate) => candidate.accountId)).toEqual([usd.id, eur!.id]);

      expect(correctionPrompts).toHaveLength(1);
      expect(correctionPrompts[0]).toContain('Payment: 29.41 GEL');
      expect(correctionPrompts[0]).toContain('a1 | Example EUR | EUR | 900 |');
      expect(correctionPrompts[0]).not.toContain(usd.id);
    });

    it('drops accounts the model invented and keeps the covering ones it left out', async () => {
      mockNotificationParsing({
        answer: () => ({}),
        correction: () => ({ ranking: ['a9', 'a2', 'a2'], reason: null }),
      });
      const { gel, usd, eur, noon, secret } = await setUp({ eurBalance: 900 });

      await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });

      const tx = (await Transactions.findOne({ where: { accountId: gel.id } }))!;
      const correction = await correctionOf({ transactionId: tx.id });
      expect(correction!.candidates.map((candidate) => candidate.accountId)).toEqual([usd.id, eur!.id]);
      expect(correction).toMatchObject({ composedBy: 'ai', reason: null });
    });

    it('falls back to the deterministic suggestion when the model fails', async () => {
      mockNotificationParsing({ answer: () => ({}), correction: () => 'fail' });
      const { gel, usd, noon, secret } = await setUp();

      await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });

      const tx = (await Transactions.findOne({ where: { accountId: gel.id } }))!;
      expect(await correctionOf({ transactionId: tx.id })).toMatchObject({
        composedBy: 'rules',
        reason: null,
        suggestedAccountId: usd.id,
      });
    });

    it('falls back when the daily AI limit is spent', async () => {
      process.env.INGEST_AI_DAILY_LIMIT = '0';
      const correctionPrompts: string[] = [];
      mockNotificationParsing({
        answer: () => ({}),
        correctionPrompts,
        correction: () => ({ ranking: ['a1'], reason: 'x' }),
      });
      const { gel, noon, secret } = await setUp();

      try {
        await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });
      } finally {
        delete process.env.INGEST_AI_DAILY_LIMIT;
      }

      const tx = (await Transactions.findOne({ where: { accountId: gel.id } }))!;
      expect(await correctionOf({ transactionId: tx.id })).toMatchObject({ composedBy: 'rules' });
      expect(correctionPrompts).toEqual([]);
    });
  });

  describe('approving', () => {
    const logShort = async () => {
      const context = await setUp();
      await walletPayment({ secret: context.secret, noon: context.noon, amount: woltOnlinePayment.wallet.body });
      const tx = (await Transactions.findOne({ where: { accountId: context.gel.id } }))!;

      return { ...context, tx };
    };

    it('moves the payment to the suggested account, keeps the charged amount and lets the balances follow', async () => {
      const { gel, usd, tx } = await logShort();

      const res = await helpers.approveIngestCorrection({ transactionId: tx.id, raw: true });
      expect(res).toEqual({ transactionId: tx.id, accountId: usd.id });

      const moved = (await Transactions.findOne({ where: { id: tx.id } }))!;
      expect(moved).toMatchObject({ accountId: usd.id, currencyCode: 'USD', originalCurrencyCode: 'GEL' });
      expect(moved.amount.toNumber()).toBe(14.7);
      expect(moved.originalAmount!.toNumber()).toBe(29.41);

      expect(await balanceOf({ id: gel.id })).toBe(10);
      expect(await balanceOf({ id: usd.id })).toBe(500 - 14.7);

      const unconfirmed = (await helpers.listUnconfirmedCardPayments({ raw: true })).find(
        (entry) => entry.transactionId === tx.id,
      );
      expect(unconfirmed!.correction).toMatchObject({ status: 'applied', appliedAccountId: usd.id });
    });

    it('keeps the zone the device reported when the payment moves to a system account', async () => {
      const { tx } = await logShort();
      // A payment logged on a bank-linked account waits as planned until the bank reports it.
      await helpers.patchUserSettings({ raw: true, patch: { timeZone: 'Asia/Dubai' } });
      await tx.update({ isPlanned: true, timeZone: 'Europe/Istanbul', utcOffsetMinutes: 180 });

      await helpers.approveIngestCorrection({ transactionId: tx.id, raw: true });

      const moved = (await Transactions.findOne({ where: { id: tx.id } }))!;
      expect(moved.isPlanned).toBe(false);
      expect(moved).toMatchObject({ timeZone: 'Europe/Istanbul', utcOffsetMinutes: 180 });
    });

    it('takes the bank amount when the owner enters it', async () => {
      const { usd, tx } = await logShort();

      await helpers.approveIngestCorrection({ transactionId: tx.id, payload: { amount: 14.5 }, raw: true });

      expect(await balanceOf({ id: usd.id })).toBe(500 - 14.5);
      expect((await Transactions.findOne({ where: { id: tx.id } }))!.amount.toNumber()).toBe(14.5);
    });

    it('refuses an account the suggestion did not offer', async () => {
      const { gel, tx } = await logShort();

      const res = await helpers.approveIngestCorrection({
        transactionId: tx.id,
        payload: { accountId: gel.id },
        raw: false,
      });

      expect(res.status).toBe(ERROR_CODES.ValidationError);
      expect((await Transactions.findOne({ where: { id: tx.id } }))!.accountId).toBe(gel.id);
    });

    it('refuses a second approval and an unknown transaction', async () => {
      const { tx } = await logShort();

      await helpers.approveIngestCorrection({ transactionId: tx.id, raw: true });
      const again = await helpers.approveIngestCorrection({ transactionId: tx.id, raw: false });
      const unknown = await helpers.approveIngestCorrection({ transactionId: randomUUID(), raw: false });

      expect(again.status).toBe(ERROR_CODES.ConflictError);
      expect(unknown.status).toBe(ERROR_CODES.NotFoundError);
    });

    it('refuses a payment without a suggestion', async () => {
      const { gel, noon, secret } = await setUp({ gelBalance: 100 });
      await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });
      const tx = (await Transactions.findOne({ where: { accountId: gel.id } }))!;

      const res = await helpers.approveIngestCorrection({ transactionId: tx.id, raw: false });

      expect(res.status).toBe(ERROR_CODES.ConflictError);
    });
  });

  describe('dismissing', () => {
    it('leaves the payment where it was logged and closes the suggestion', async () => {
      const { gel, noon, secret } = await setUp();
      await walletPayment({ secret, noon, amount: woltOnlinePayment.wallet.body });
      const tx = (await Transactions.findOne({ where: { accountId: gel.id } }))!;

      await helpers.dismissIngestCorrection({ transactionId: tx.id, raw: true });

      expect(await correctionOf({ transactionId: tx.id })).toMatchObject({ status: 'dismissed' });
      expect((await Transactions.findOne({ where: { id: tx.id } }))!.accountId).toBe(gel.id);

      const approve = await helpers.approveIngestCorrection({ transactionId: tx.id, raw: false });
      expect(approve.status).toBe(ERROR_CODES.ConflictError);
    });
  });
});
