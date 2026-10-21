import { TRACKER_TYPES, TRANSACTION_TYPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import * as helpers from '@tests/helpers';

const setZone = async ({ timeZone }: { timeZone: string }) => {
  const res = await helpers.patchUserSettings({ patch: { timeZone, timeZoneSource: 'manual' } });
  expect(res.statusCode).toBe(200);
};

const expenseAt = async ({ time, amount = 50 }: { time: string; amount?: number }) => {
  const account = await helpers.createAccount({ raw: true });
  const category = await helpers.addCustomCategory({ name: 'Zoned', color: '#112233', raw: true });
  await helpers.createTransaction({
    payload: {
      ...helpers.buildTransactionPayload({
        accountId: account.id,
        amount,
        transactionType: TRANSACTION_TYPES.expense,
        categoryId: category.id,
      }),
      time,
    },
    raw: true,
  });
  return { account, category };
};

describe('Reports cut days in the viewing zone', () => {
  describe('a Tbilisi user (UTC+4)', () => {
    // 2026-10-20T21:30Z is 01:30 on 21 October in Tbilisi.
    const LATE_EVENING_UTC = '2026-10-20T21:30:00.000Z';

    it('counts the row on the local day in cash flow', async () => {
      await setZone({ timeZone: 'Asia/Tbilisi' });
      await expenseAt({ time: LATE_EVENING_UTC });

      const result = await helpers.getCashFlow({
        from: '2026-10-20',
        to: '2026-10-21',
        granularity: 'daily',
        raw: true,
      });

      expect(result.periods.map((period) => [period.periodStart, period.expenses])).toEqual([
        ['2026-10-20', 0],
        ['2026-10-21', 50],
      ]);
    });

    it('counts the row in a single-day spending-by-categories window', async () => {
      await setZone({ timeZone: 'Asia/Tbilisi' });
      const { category } = await expenseAt({ time: LATE_EVENING_UTC });

      const onTheLocalDay = (await helpers.getSpendingsByCategories({
        from: '2026-10-21',
        to: '2026-10-21',
        raw: true,
      })) as Record<string, { amount: number }>;
      const onThePreviousDay = (await helpers.getSpendingsByCategories({
        from: '2026-10-20',
        to: '2026-10-20',
        raw: true,
      })) as Record<string, { amount: number }>;

      expect(onTheLocalDay[category.id]?.amount).toBe(50);
      expect(onThePreviousDay[category.id]).toBeUndefined();
    });

    it('puts the row in the October column of a monthly pivot although UTC still says September', async () => {
      await setZone({ timeZone: 'Asia/Tbilisi' });
      await expenseAt({ time: '2026-09-30T21:30:00.000Z' });

      const result = await helpers.getPivotReport({
        from: '2026-09-01',
        to: '2026-10-31',
        granularity: 'monthly',
        rowDimension: 'category',
        measure: 'expense',
        raw: true,
      });

      expect(result.columns.map((column) => column.key)).toEqual(['2026-09', '2026-10']);
      expect(result.columnTotals['2026-09']).toBe(0);
      expect(result.columnTotals['2026-10']).toBe(50);
    });

    it('buckets a category tracker spending on the local day', async () => {
      await setZone({ timeZone: 'Asia/Tbilisi' });
      const { category } = await expenseAt({ time: LATE_EVENING_UTC });
      const tracker = await helpers.createTracker({
        name: 'Zoned tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        startDate: '2026-10-19T20:00:00.000Z',
        endDate: '2026-10-21T19:59:59.999Z',
        raw: true,
      });

      const spending = await helpers.getTrackerSpendingStats({ id: tracker.id, raw: true });

      expect(spending.spendingOverTime.periods.map((period) => [period.periodStart, period.expense])).toEqual([
        ['2026-10-20', 0],
        ['2026-10-21', 50],
      ]);
      expect(spending.biggestDay?.date).toBe('2026-10-21');
    });
  });

  describe('a New York user (UTC-4/-5)', () => {
    it('counts 2026-11-01T03:30Z on 31 October', async () => {
      await setZone({ timeZone: 'America/New_York' });
      await expenseAt({ time: '2026-11-01T03:30:00.000Z' });

      const result = await helpers.getCashFlow({
        from: '2026-10-31',
        to: '2026-11-01',
        granularity: 'daily',
        raw: true,
      });

      expect(result.periods.map((period) => [period.periodStart, period.expenses])).toEqual([
        ['2026-10-31', 50],
        ['2026-11-01', 0],
      ]);
    });

    it('keeps net-worth history on UTC days, whatever the zone', async () => {
      await expenseAt({ time: '2026-11-01T03:30:00.000Z' });
      const params = { from: '2026-10-01', to: '2026-11-30', granularity: 'monthly' as const, raw: true as const };
      const utcResult = await helpers.getNetWorthHistory(params);

      await setZone({ timeZone: 'America/New_York' });
      const zonedResult = await helpers.getNetWorthHistory(params);

      expect(zonedResult).toEqual(utcResult);
    });
  });

  it('leaves a user without a zone on UTC days', async () => {
    await expenseAt({ time: '2026-10-20T21:30:00.000Z' });

    const result = await helpers.getCashFlow({
      from: '2026-10-20',
      to: '2026-10-21',
      granularity: 'daily',
      raw: true,
    });

    expect(result.periods.map((period) => [period.periodStart, period.expenses])).toEqual([
      ['2026-10-20', 50],
      ['2026-10-21', 0],
    ]);
  });
});
