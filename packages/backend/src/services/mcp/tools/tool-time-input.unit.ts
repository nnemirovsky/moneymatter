import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { adjustAccountBalance } from '@services/accounts/balance-adjustment';
import { markPeriodPaid } from '@services/subscriptions/mark-period-paid';
import { createTracker } from '@services/trackers/create-tracker';
import { createTransaction } from '@services/transactions/create-transaction';
import { getTransactionById } from '@services/transactions/get-by-id';
import { getTransactions } from '@services/transactions/get-transactions';
import { updateTransaction } from '@services/transactions/update-transaction';
import { captureTools, makeExtra } from '@tests/helpers/mcp-tools';
import { z } from 'zod';

// Block the real services, whose import chains build queues at module scope and would open Redis
// connections in a unit test.
jest.mock('@services/transactions/create-transaction', () => ({ createTransaction: jest.fn() }));
jest.mock('@services/transactions/update-transaction', () => ({ updateTransaction: jest.fn() }));
jest.mock('@services/transactions/get-by-id', () => ({ getTransactionById: jest.fn() }));
jest.mock('@services/transactions/get-transactions', () => ({ getTransactions: jest.fn() }));
jest.mock('@services/accounts/balance-adjustment', () => ({ adjustAccountBalance: jest.fn() }));
jest.mock('@services/subscriptions/mark-period-paid', () => ({ markPeriodPaid: jest.fn() }));
jest.mock('@services/trackers/create-tracker', () => ({ createTracker: jest.fn() }));
jest.mock('@services/payees/get-payee-names', () => ({ getPayeeNames: jest.fn(async () => new Map()) }));
jest.mock('@services/currencies/base-currency-lock', () => ({
  isBaseCurrencyChangeLocked: jest.fn(async () => false),
}));
jest.mock('@root/serializers/transactions.serializer', () => ({
  ...jest.requireActual<object>('@root/serializers/transactions.serializer'),
  serializeTransactionTuple: () => [],
  serializeTransactions: () => [],
}));
jest.mock('@root/serializers/trackers.serializer', () => ({ serializeTracker: (tracker: unknown) => tracker }));
// A Tbilisi user who chose that zone.
jest.mock('@services/user-settings/get-user-time-zone', () => ({
  getStoredUserTimeZone: async () => 'Asia/Tbilisi',
  getUserTimeZone: async () => 'Asia/Tbilisi',
  getUserTimeZones: async () => ({ viewingZone: 'Asia/Tbilisi', storedZone: 'Asia/Tbilisi' }),
}));

import { registerAdjustAccountBalance } from './adjust-account-balance';
import { registerConfirmPlannedTransaction } from './confirm-planned-transaction';
import { registerCreateTracker } from './create-tracker';
import { registerCreateTransaction } from './create-transaction';
import { registerPaySubscriptionPeriod } from './pay-subscription-period';
import { registerSearchTransactions } from './search-transactions';
import { registerUpdateTransaction } from './update-transaction';

const WRITE = makeExtra({ scopes: ['finance:read', 'finance:write'] });
const ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const PERIOD_ID = '33333333-3333-4333-8333-333333333333';

const WALL = '2026-10-21T16:00';
const NOON_Z = new Date('2026-10-21T12:00:00.000Z');

const create = jest.mocked(createTransaction);
const update = jest.mocked(updateTransaction);
const byId = jest.mocked(getTransactionById);
const search = jest.mocked(getTransactions);
const adjust = jest.mocked(adjustAccountBalance);
const pay = jest.mocked(markPeriodPaid);
const addTracker = jest.mocked(createTracker);

beforeEach(() => {
  create.mockReset().mockResolvedValue([] as never);
  update.mockReset().mockResolvedValue([] as never);
  byId.mockReset();
  search.mockReset().mockResolvedValue([] as never);
  adjust.mockReset().mockResolvedValue({ previousBalance: 0, newBalance: 5, transaction: null } as never);
  pay.mockReset().mockResolvedValue({ id: PERIOD_ID } as never);
  addTracker.mockReset().mockResolvedValue({} as never);
});

describe('create_transaction time', () => {
  const tool = captureTools({ register: registerCreateTransaction })[0]!;
  const base = {
    accountId: ACCOUNT_ID,
    amount: 10,
    transactionType: 'expense',
    paymentType: 'cash',
    transferNature: 'not_transfer',
  };

  it('reads a wall clock in the user zone and records the zone', async () => {
    await tool.handler({ ...base, time: WALL }, WRITE);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ time: NOON_Z, timeZone: 'Asia/Tbilisi', utcOffsetMinutes: 240 }),
    );
  });

  it('reads it in the zone given', async () => {
    await tool.handler({ ...base, time: WALL, timeZone: 'America/New_York' }, WRITE);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        time: new Date('2026-10-21T20:00:00.000Z'),
        timeZone: 'America/New_York',
        utcOffsetMinutes: -240,
      }),
    );
  });

  it('refuses an offset that contradicts the zone given, and a bad zone', async () => {
    await expect(
      tool.handler({ ...base, time: '2026-10-21T16:00:00+02:00', timeZone: 'Asia/Tbilisi' }, WRITE),
    ).rejects.toThrow(/contradicts/);
    expect(z.object(tool.config.inputSchema!).safeParse({ ...base, timeZone: '+04:00' }).success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('update_transaction time', () => {
  const tool = captureTools({ register: registerUpdateTransaction })[0]!;

  it('reads a wall clock in the viewing zone and leaves the recorded zone out of the update', async () => {
    await tool.handler({ id: ID, time: WALL }, WRITE);
    const payload = update.mock.calls[0]![0];
    expect(payload.time).toEqual(NOON_Z);
    expect('timeZone' in payload).toBe(false);
  });

  it('passes the zone only when the caller gives one, null included', async () => {
    await tool.handler({ id: ID, time: WALL, timeZone: 'America/New_York' }, WRITE);
    expect(update.mock.calls[0]![0]).toMatchObject({
      time: new Date('2026-10-21T20:00:00.000Z'),
      timeZone: 'America/New_York',
    });

    await tool.handler({ id: ID, timeZone: null }, WRITE);
    expect(update.mock.calls[1]![0]).toMatchObject({ timeZone: null });
  });
});

describe('adjust_account_balance, confirm_planned_transaction and pay_subscription_period time', () => {
  it('adjust_account_balance reads a wall clock', async () => {
    const tool = captureTools({ register: registerAdjustAccountBalance })[0]!;
    await tool.handler({ accountId: ACCOUNT_ID, newBalance: 5, time: WALL }, WRITE);
    expect(adjust).toHaveBeenCalledWith(
      expect.objectContaining({ time: NOON_Z, timeZone: 'Asia/Tbilisi', utcOffsetMinutes: 240 }),
    );
  });

  it('confirm_planned_transaction reads a wall clock, not only Z', async () => {
    const tool = captureTools({ register: registerConfirmPlannedTransaction })[0]!;
    byId.mockResolvedValue({ tx: { id: ID, isPlanned: true, time: new Date('2026-01-01T00:00:00Z') } } as never);
    await tool.handler({ transactionId: ID, time: WALL }, WRITE);
    const payload = update.mock.calls[0]![0];
    expect(payload).toMatchObject({ id: ID, isPlanned: false, time: NOON_Z });
    expect('timeZone' in payload).toBe(false);
  });

  it('pay_subscription_period reads a wall clock for the transaction it books', async () => {
    const tool = captureTools({ register: registerPaySubscriptionPeriod })[0]!;
    await tool.handler({ subscriptionId: ID, periodId: PERIOD_ID, createTransaction: true, time: WALL }, WRITE);
    expect(pay).toHaveBeenCalledWith(expect.objectContaining({ time: NOON_Z, timeZone: 'Asia/Tbilisi' }));
  });

  it('pay_subscription_period keeps an offset-only stated offset', async () => {
    const tool = captureTools({ register: registerPaySubscriptionPeriod })[0]!;
    await tool.handler(
      { subscriptionId: ID, periodId: PERIOD_ID, createTransaction: true, time: '2026-10-21T16:00:00+02:00' },
      WRITE,
    );
    expect(pay).toHaveBeenCalledWith(expect.objectContaining({ timeZone: null, utcOffsetMinutes: 120 }));
  });
});

describe('range bounds', () => {
  it('search_transactions cuts date bounds in the user zone', async () => {
    const tool = captureTools({ register: registerSearchTransactions })[0]!;
    await tool.handler({ startDate: '2026-10-21', endDate: '2026-10-21' }, WRITE);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2026-10-20T20:00:00.000Z', endDate: '2026-10-21T19:59:59.999Z' }),
    );
  });

  it('create_tracker cuts date bounds in the user zone and still refuses an end before the start', async () => {
    const tool = captureTools({ register: registerCreateTracker })[0]!;
    await tool.handler({ name: 'Trip', startDate: '2026-10-01', endDate: '2026-10-05' }, WRITE);
    expect(addTracker).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: new Date('2026-09-30T20:00:00.000Z'),
        endDate: new Date('2026-10-05T19:59:59.999Z'),
      }),
    );

    await expect(
      tool.handler({ name: 'Trip', startDate: '2026-10-05', endDate: '2026-10-01' }, WRITE),
    ).rejects.toThrow();
  });
});
