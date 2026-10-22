import { SUBSCRIPTION_FREQUENCIES, SUBSCRIPTION_TYPES, TRANSACTION_TRANSFER_NATURE, asDecimal } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import SubscriptionPeriods from '@models/subscription-periods.model';
import Transactions from '@models/transactions.model';
import * as helpers from '@tests/helpers';
import { format } from 'date-fns';

import { processAutoRecordPeriods } from '../subscriptions/process-auto-record';

const SUMMER = '2026-07-15T12:00:00.000Z';
const WINTER = '2026-12-15T12:00:00.000Z';

const createWithZone = async ({ time = SUMMER, timeZone }: { time?: string; timeZone?: string | null }) => {
  const account = await helpers.createAccount({ raw: true });
  const [tx] = await helpers.createTransaction({
    payload: helpers.buildTransactionPayload({ accountId: account.id, time, timeZone }),
    raw: true,
  });
  return { account, tx: tx! };
};

describe('Transaction time zone', () => {
  describe('create', () => {
    it('stores the zone and the offset at the instant', async () => {
      const { tx } = await createWithZone({ timeZone: 'America/New_York' });

      expect(tx.timeZone).toBe('America/New_York');
      expect(tx.utcOffsetMinutes).toBe(-240);
    });

    it('stores null and null when no zone is sent', async () => {
      const { tx } = await createWithZone({});

      expect(tx.timeZone).toBeNull();
      expect(tx.utcOffsetMinutes).toBeNull();
    });

    it('rejects an invalid zone', async () => {
      const account = await helpers.createAccount({ raw: true });
      const res = await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({ accountId: account.id, timeZone: '+04:00' }),
      });

      expect(res.statusCode).toBe(ERROR_CODES.ValidationError);
    });

    it('gives both legs of a transfer the same pair', async () => {
      const [accountA, accountB] = await Promise.all([
        helpers.createAccount({ raw: true }),
        helpers.createAccount({ raw: true }),
      ]);

      const [base, opposite] = await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: accountA.id,
          destinationAccountId: accountB.id,
          destinationAmount: 1000,
          transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer,
          time: SUMMER,
          timeZone: 'Asia/Tbilisi',
        }),
        raw: true,
      });

      expect(base!.timeZone).toBe('Asia/Tbilisi');
      expect(base!.utcOffsetMinutes).toBe(240);
      expect(opposite!.timeZone).toBe('Asia/Tbilisi');
      expect(opposite!.utcOffsetMinutes).toBe(240);
    });
  });

  describe('read', () => {
    it('returns both fields from the list and the by-id routes', async () => {
      const { account, tx } = await createWithZone({ timeZone: 'Asia/Tbilisi' });

      const byId = await helpers.getTransactionById({ id: tx.id, raw: true });
      expect(byId).toMatchObject({ timeZone: 'Asia/Tbilisi', utcOffsetMinutes: 240 });

      const [listed] = await helpers.getTransactions({ accountIds: [account.id], raw: true });
      expect(listed).toMatchObject({ timeZone: 'Asia/Tbilisi', utcOffsetMinutes: 240 });
    });
  });

  describe('update', () => {
    it('recomputes the offset when time moves into winter', async () => {
      const { tx } = await createWithZone({ timeZone: 'America/New_York' });

      const [updated] = await helpers.updateTransaction({ id: tx.id, payload: { time: WINTER }, raw: true });

      expect(updated!.timeZone).toBe('America/New_York');
      expect(updated!.utcOffsetMinutes).toBe(-300);
    });

    it('keeps null and null when time moves on a row without a zone', async () => {
      const { tx } = await createWithZone({});

      const [updated] = await helpers.updateTransaction({ id: tx.id, payload: { time: WINTER }, raw: true });

      expect(updated!.timeZone).toBeNull();
      expect(updated!.utcOffsetMinutes).toBeNull();
    });

    it('clears both columns with timeZone null', async () => {
      const { tx } = await createWithZone({ timeZone: 'America/New_York' });

      const [updated] = await helpers.updateTransaction({ id: tx.id, payload: { timeZone: null }, raw: true });

      expect(updated!.timeZone).toBeNull();
      expect(updated!.utcOffsetMinutes).toBeNull();
    });

    it('changes the zone without moving the instant', async () => {
      const { tx } = await createWithZone({ timeZone: 'America/New_York' });

      const [updated] = await helpers.updateTransaction({
        id: tx.id,
        payload: { timeZone: 'Asia/Tbilisi' },
        raw: true,
      });

      expect(updated!.timeZone).toBe('Asia/Tbilisi');
      expect(updated!.utcOffsetMinutes).toBe(240);
      expect(new Date(updated!.time).toISOString()).toBe(SUMMER);
    });

    it('rejects an invalid zone', async () => {
      const { tx } = await createWithZone({});

      const res = await helpers.updateTransaction({ id: tx.id, payload: { timeZone: 'Mars/Base' } });

      expect(res.statusCode).toBe(ERROR_CODES.ValidationError);
    });

    it('moves both legs of a transfer when time changes', async () => {
      const [accountA, accountB] = await Promise.all([
        helpers.createAccount({ raw: true }),
        helpers.createAccount({ raw: true }),
      ]);
      const [base] = await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: accountA.id,
          destinationAccountId: accountB.id,
          destinationAmount: 1000,
          transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer,
          time: SUMMER,
          timeZone: 'America/New_York',
        }),
        raw: true,
      });

      const [updatedBase, updatedOpposite] = await helpers.updateTransaction({
        id: base!.id,
        payload: { time: WINTER },
        raw: true,
      });

      expect(updatedBase!.utcOffsetMinutes).toBe(-300);
      expect(updatedOpposite!.timeZone).toBe('America/New_York');
      expect(updatedOpposite!.utcOffsetMinutes).toBe(-300);
    });

    it('lets timeZone change on a bank-synced row while time stays locked', async () => {
      await helpers.monobank.pair();
      const { transactions } = await helpers.monobank.mockTransactions();
      const external = transactions[0]!;

      const [updated] = await helpers.updateTransaction({
        id: external.id,
        payload: { timeZone: 'Asia/Tbilisi' },
        raw: true,
      });
      expect(updated!.timeZone).toBe('Asia/Tbilisi');
      expect(new Date(updated!.time).toISOString()).toBe(new Date(external.time).toISOString());

      const res = await helpers.updateTransaction({ id: external.id, payload: { time: WINTER } });
      expect(res.statusCode).toBe(ERROR_CODES.ValidationError);
    });
  });

  describe('confirming a planned row', () => {
    const plan = async ({ timeZone }: { timeZone?: string | null } = {}) => {
      const account = await helpers.createAccount({ raw: true });
      const [planned] = await helpers.createPlannedTransaction({
        payload: { accountId: account.id, amount: 10, time: '2026-07-15T12:00:00.000Z', timeZone },
        raw: true,
      });
      return planned!;
    };

    it('records the stored zone of the user at confirmation', async () => {
      const planned = await plan();
      expect(planned.timeZone).toBeNull();

      await helpers.patchUserSettings({ raw: true, patch: { timeZone: 'Asia/Tbilisi' } });
      const [confirmed] = await helpers.updateTransaction({ id: planned.id, payload: { isPlanned: false }, raw: true });

      expect(confirmed!.isPlanned).toBe(false);
      expect(confirmed!.timeZone).toBe('Asia/Tbilisi');
      expect(confirmed!.utcOffsetMinutes).toBe(240);
    });

    it('replaces the zone the plan was made in with the one the user is in now', async () => {
      const planned = await plan({ timeZone: 'America/New_York' });

      await helpers.patchUserSettings({ raw: true, patch: { timeZone: 'Asia/Tbilisi' } });
      const [confirmed] = await helpers.updateTransaction({ id: planned.id, payload: { isPlanned: false }, raw: true });

      expect(confirmed!.timeZone).toBe('Asia/Tbilisi');
    });

    it('keeps a zone named in the confirmation request', async () => {
      const planned = await plan();

      await helpers.patchUserSettings({ raw: true, patch: { timeZone: 'Asia/Tbilisi' } });
      const [confirmed] = await helpers.updateTransaction({
        id: planned.id,
        payload: { isPlanned: false, timeZone: 'Europe/Istanbul' },
        raw: true,
      });

      expect(confirmed!.timeZone).toBe('Europe/Istanbul');
      expect(confirmed!.utcOffsetMinutes).toBe(180);
    });

    it('leaves the row as it is for a user without a stored zone', async () => {
      const planned = await plan();

      const [confirmed] = await helpers.updateTransaction({ id: planned.id, payload: { isPlanned: false }, raw: true });

      expect(confirmed!.timeZone).toBeNull();
      expect(confirmed!.utcOffsetMinutes).toBeNull();
    });

    it('does not re-zone a row that is edited while still planned', async () => {
      const planned = await plan();

      await helpers.patchUserSettings({ raw: true, patch: { timeZone: 'Asia/Tbilisi' } });
      const [edited] = await helpers.updateTransaction({ id: planned.id, payload: { note: 'edit' }, raw: true });

      expect(edited!.timeZone).toBeNull();
    });
  });

  describe('services that create a row', () => {
    it('records the zone of a balance adjustment', async () => {
      const account = await helpers.createAccount({ raw: true });

      const result = await helpers.balanceAdjustment({
        id: account.id,
        payload: { targetBalance: asDecimal(500), time: SUMMER, timeZone: 'America/New_York' },
        raw: true,
      });

      const row = await Transactions.findByPk(result.transaction!.id);
      expect(row!.timeZone).toBe('America/New_York');
      expect(row!.utcOffsetMinutes).toBe(-240);
    });

    it('records the zone of a subscription payment', async () => {
      const account = await helpers.createAccount({ raw: true });
      const today = format(new Date(), 'yyyy-MM-dd');
      const subscription = await helpers.createSubscription({
        name: 'Zoned',
        type: SUBSCRIPTION_TYPES.subscription,
        frequency: SUBSCRIPTION_FREQUENCIES.monthly,
        startDate: today,
        dueDate: today,
        accountId: account.id,
        expectedAmount: 10,
        expectedCurrencyCode: global.BASE_CURRENCY.code,
        raw: true,
      });
      const { periods } = await helpers.getSubscriptionPeriods({ id: subscription.id, raw: true });

      await helpers.markSubscriptionPeriodPaid({
        id: subscription.id,
        periodId: periods[0]!.id,
        createTransaction: true,
        time: SUMMER,
        timeZone: 'America/New_York',
        raw: true,
      });

      const [paid] = await helpers.getTransactions({ accountIds: [account.id], raw: true });
      expect(paid).toMatchObject({ timeZone: 'America/New_York', utcOffsetMinutes: -240 });
    });

    it('records the stored zone of an auto-recorded subscription payment, and null without a setting', async () => {
      const today = format(new Date(), 'yyyy-MM-dd');
      const book = async () => {
        const account = await helpers.createAccount({ raw: true });
        const subscription = await helpers.createSubscription({
          name: 'Auto zoned',
          type: SUBSCRIPTION_TYPES.subscription,
          frequency: SUBSCRIPTION_FREQUENCIES.monthly,
          startDate: today,
          dueDate: today,
          accountId: account.id,
          expectedAmount: 10,
          expectedCurrencyCode: global.BASE_CURRENCY.code,
          autoRecord: true,
          raw: true,
        });
        await SubscriptionPeriods.update({ dueDate: today }, { where: { subscriptionId: subscription.id } });
        await processAutoRecordPeriods();
        const [row] = await helpers.getTransactions({ accountIds: [account.id], raw: true });
        return row!;
      };

      const withoutSetting = await book();
      expect(withoutSetting.timeZone).toBeNull();
      expect(withoutSetting.utcOffsetMinutes).toBeNull();

      await helpers.patchUserSettings({ raw: true, patch: { timeZone: 'Asia/Tbilisi' } });
      const withSetting = await book();
      expect(withSetting.timeZone).toBe('Asia/Tbilisi');
      expect(withSetting.utcOffsetMinutes).toBe(240);
    });

    it('records the zone of an account to portfolio transfer', async () => {
      const [portfolio, account] = await Promise.all([
        helpers.createPortfolio({ payload: helpers.buildPortfolioPayload({ name: 'Zoned' }), raw: true }),
        helpers.createAccount({ raw: true }),
      ]);

      const transfer = await helpers.accountToPortfolioTransfer({
        portfolioId: portfolio.id,
        payload: { accountId: account.id, amount: '50', date: '2026-07-15', timeZone: 'America/New_York' },
        raw: true,
      });

      const row = await Transactions.findByPk(transfer.transactionId!);
      expect(row!.timeZone).toBe('America/New_York');
      expect(row!.utcOffsetMinutes).toBe(-240);
    });
  });
});
