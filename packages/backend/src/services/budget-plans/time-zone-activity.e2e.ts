import { type RecordId, TRANSACTION_TYPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import * as helpers from '@tests/helpers';

type Period = { id: string; startDate: string; endDate: string };

const instantAround = ({ day, offsetMinutes }: { day: string; offsetMinutes: number }) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + offsetMinutes * 60_000).toISOString();

const setup = async ({ timeZone }: { timeZone: string | null }) => {
  if (timeZone) {
    const res = await helpers.patchUserSettings({ patch: { timeZone, timeZoneSource: 'manual' } });
    expect(res.statusCode).toBe(200);
  }
  const account = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ initialBalance: 1000 }),
    raw: true,
  });
  const food = await helpers.addCustomCategory({ name: 'Food', color: '#111111', raw: true });
  const { plan } = await helpers.createBudgetPlan({
    payload: { accountIds: [account.id], epochDate: helpers.budgetPeriodStart({ monthsAgo: 2 }), poolEnabled: true },
    raw: true,
  });
  const periods: Period[] = await helpers.listBudgetPlanPeriods({ planId: plan.id, raw: true });
  await helpers.createBudgetPlanLine({
    planId: plan.id,
    payload: { name: 'Food', categoryIds: [food.id], activeFrom: periods[0]!.startDate },
    raw: true,
  });

  return { account, food, planId: plan.id, periods };
};

const spend = ({ accountId, categoryId, time }: { accountId: RecordId; categoryId: RecordId; time: string }) =>
  helpers.createTransaction({
    payload: {
      ...helpers.buildTransactionPayload({
        accountId,
        categoryId,
        amount: 100,
        transactionType: TRANSACTION_TYPES.expense,
      }),
      time,
    },
    raw: true,
  });

const view = ({ planId, period }: { planId: string; period: Period }) =>
  helpers.getBudgetPlanPeriodView({ planId, periodId: period.id, raw: true });

describe('Budget plan periods in the viewing zone', () => {
  it('counts 01:30 local on the first day of a period in that period for a Tbilisi user, activity and cash', async () => {
    const { account, food, planId, periods } = await setup({ timeZone: 'Asia/Tbilisi' });
    // 21:30Z on the last day before the period is 01:30 on its first day in Tbilisi.
    await spend({
      accountId: account.id,
      categoryId: food.id,
      time: instantAround({ day: periods[1]!.startDate, offsetMinutes: -150 }),
    });

    const first = await view({ planId, period: periods[0]! });
    const second = await view({ planId, period: periods[1]! });

    expect(first.lines[0]!.activity).toBe(0);
    expect(second.lines[0]!.activity).toBe(-100);
    // The first period closes at local midnight, before the spend, so it still held the full 1000.
    expect(first.pool?.balance.cash).toBe(1000);
  });

  it("counts 03:30Z on a period's first UTC day in the previous period for a New York user", async () => {
    const { account, food, planId, periods } = await setup({ timeZone: 'America/New_York' });
    await spend({
      accountId: account.id,
      categoryId: food.id,
      time: instantAround({ day: periods[1]!.startDate, offsetMinutes: 210 }),
    });

    const first = await view({ planId, period: periods[0]! });
    const second = await view({ planId, period: periods[1]! });

    expect(first.lines[0]!.activity).toBe(-100);
    expect(second.lines[0]!.activity).toBe(0);
  });

  it('keeps a user without a zone on UTC periods', async () => {
    const { account, food, planId, periods } = await setup({ timeZone: null });
    await spend({
      accountId: account.id,
      categoryId: food.id,
      time: instantAround({ day: periods[1]!.startDate, offsetMinutes: 210 }),
    });

    const second = await view({ planId, period: periods[1]! });

    expect(second.lines[0]!.activity).toBe(-100);
  });
});
