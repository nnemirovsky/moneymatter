import { type RecordId, SUBSCRIPTION_FREQUENCIES, TRANSACTION_TYPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import * as helpers from '@tests/helpers';
import { addDays, format, setDate, subMonths } from 'date-fns';

const subscriptionWithWindow = ({ dueDate, days }: { dueDate: string; days: number }) =>
  helpers.createSubscription({
    name: 'Streamly+',
    expectedAmount: 8.99,
    expectedCurrencyCode: global.BASE_CURRENCY_CODE,
    frequency: SUBSCRIPTION_FREQUENCIES.monthly,
    startDate: dueDate,
    dueDate,
    matchingRules: {
      rules: [
        { field: 'amount', operator: 'between', value: { min: 8.99, max: 8.99 } },
        { field: 'dueDate', operator: 'within_days', value: days },
      ],
    },
    raw: true,
  });

const expenseOn = ({ accountId, time }: { accountId: RecordId; time: string }) =>
  helpers.createTransaction({
    payload: helpers.buildTransactionPayload({
      accountId,
      amount: 8.99,
      transactionType: TRANSACTION_TYPES.expense,
      time,
    }),
    raw: true,
  });

describe('Subscription due-date rule', () => {
  it('auto-matches only inside the window around the due date, with a 30th anchor clamped in February', async () => {
    const account = await helpers.createAccount({ raw: true });
    const sub = await subscriptionWithWindow({ dueDate: '2025-01-30', days: 3 });

    await expenseOn({ accountId: account.id, time: '2025-04-15T12:00:00Z' });
    await expenseOn({ accountId: account.id, time: '2025-04-26T12:00:00Z' });
    expect((await helpers.getSubscriptionById({ id: sub.id, raw: true })).transactions).toHaveLength(0);

    // 3 days before April 30 (edge, inclusive) and the clamped Feb 28 renewal itself.
    const [beforeRenewal] = await expenseOn({ accountId: account.id, time: '2025-04-27T12:00:00Z' });
    const [february] = await expenseOn({ accountId: account.id, time: '2025-02-28T12:00:00Z' });

    const ids = (await helpers.getSubscriptionById({ id: sub.id, raw: true })).transactions.map(
      (t: { id: string }) => t.id,
    );
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining([beforeRenewal.id, february.id]));
  }, 60_000);

  it('suggests historical transactions only inside the window', async () => {
    const account = await helpers.createAccount({ raw: true });
    const occurrence = setDate(subMonths(new Date(), 3), 15);
    const dueDate = format(setDate(subMonths(new Date(), 5), 15), 'yyyy-MM-dd');

    const [near] = await expenseOn({ accountId: account.id, time: addDays(occurrence, 2).toISOString() });
    const [far] = await expenseOn({ accountId: account.id, time: addDays(occurrence, 9).toISOString() });

    const sub = await subscriptionWithWindow({ dueDate, days: 3 });
    const ids = (await helpers.getSuggestedMatches({ id: sub.id, raw: true })).map((s: { id: string }) => s.id);

    expect(ids).toContain(near.id);
    expect(ids).not.toContain(far.id);
  });

  it('rejects a dueDate rule on a subscription without a dueDate, and out-of-range windows', async () => {
    const base = {
      name: 'No schedule',
      expectedAmount: 5,
      expectedCurrencyCode: global.BASE_CURRENCY_CODE,
      frequency: SUBSCRIPTION_FREQUENCIES.monthly,
      startDate: '2025-01-01',
    };
    const noSchedule = await helpers.createSubscription({
      ...base,
      matchingRules: { rules: [{ field: 'dueDate', operator: 'within_days', value: 3 }] },
    });
    expect(noSchedule.statusCode).toBe(422);

    const tooWide = await helpers.createSubscription({
      ...base,
      dueDate: '2025-01-15',
      matchingRules: { rules: [{ field: 'dueDate', operator: 'within_days', value: 90 }] },
    });
    expect(tooWide.statusCode).toBe(422);
  });
});
