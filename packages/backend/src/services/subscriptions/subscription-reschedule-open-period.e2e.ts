import { SUBSCRIPTION_FREQUENCIES, SUBSCRIPTION_PERIOD_STATUSES, SUBSCRIPTION_TYPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import * as helpers from '@tests/helpers';
import { addDays, addMonths, format, parseISO, subMonths } from 'date-fns';

const OPEN: string[] = [SUBSCRIPTION_PERIOD_STATUSES.upcoming, SUBSCRIPTION_PERIOD_STATUSES.overdue];

const toIso = ({ date }: { date: Date }) => format(date, 'yyyy-MM-dd');

/** The 2nd of the month N months from today, so month arithmetic never clamps. */
const secondOfMonth = ({ monthsAhead }: { monthsAhead: number }) => {
  const date = addMonths(new Date(), monthsAhead);
  date.setDate(2);
  return toIso({ date });
};

const plusMonths = ({ dueDate, months }: { dueDate: string; months: number }) =>
  toIso({ date: addMonths(parseISO(dueDate), months) });

const plusDays = ({ dueDate, days }: { dueDate: string; days: number }) =>
  toIso({ date: addDays(parseISO(dueDate), days) });

async function createMonthlySubscription({ dueDate }: { dueDate: string }) {
  const account = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ initialBalance: 1000 }),
    raw: true,
  });
  return helpers.createSubscription({
    name: 'Internet',
    frequency: SUBSCRIPTION_FREQUENCIES.monthly,
    startDate: dueDate,
    dueDate,
    accountId: account.id,
    categoryId: global.DEFAULT_CATEGORY_ID,
    expectedAmount: 20,
    expectedCurrencyCode: global.BASE_CURRENCY.code,
    raw: true,
  });
}

async function getPeriods({ id }: { id: string }) {
  const { periods } = await helpers.getSubscriptionById({ id, raw: true });
  return {
    periods,
    open: periods.filter((period) => OPEN.includes(period.status)),
    settled: periods.filter((period) => !OPEN.includes(period.status)),
  };
}

async function settleOpenPeriod({ id, action }: { id: string; action: 'pay' | 'skip' }) {
  const { open } = await getPeriods({ id });
  const periodId = open[0]!.id;
  if (action === 'pay') {
    await helpers.markSubscriptionPeriodPaid({ id, periodId, createTransaction: true, raw: true });
  } else {
    await helpers.skipSubscriptionPeriod({ id, periodId, raw: true });
  }
}

/**
 * The shape of a schedule that has moved on from its anchor: the anchor's own date is
 * settled and the open period sits on another day of the following weeks.
 */
async function createScheduleWithSettledAnchor({ action }: { action: 'pay' | 'skip' }) {
  const anchor = secondOfMonth({ monthsAhead: 1 });
  const { id } = await createMonthlySubscription({ dueDate: anchor });
  await settleOpenPeriod({ id, action });

  const { open } = await getPeriods({ id });
  const movedOpen = plusDays({ dueDate: anchor, days: 13 });
  await helpers.updateSubscription({ id, dueDate: movedOpen, rescheduleOpenPeriod: true, raw: true });

  return { id, anchor, movedOpen, openPeriodId: open[0]!.id };
}

describe('Rescheduling the open period from the schedule dialog', () => {
  describe('without rescheduleOpenPeriod', () => {
    it('re-sending the stored anchor leaves the open period where the schedule moved it', async () => {
      const anchor = secondOfMonth({ monthsAhead: 1 });
      const { id } = await createMonthlySubscription({ dueDate: anchor });
      await settleOpenPeriod({ id, action: 'pay' });
      const before = await getPeriods({ id });

      await helpers.updateSubscription({ id, dueDate: anchor, raw: true });

      const after = await getPeriods({ id });
      expect(after.open).toHaveLength(1);
      expect(after.open[0]!.id).toBe(before.open[0]!.id);
      expect(after.open[0]!.dueDate).toBe(plusMonths({ dueDate: anchor, months: 1 }));
      expect(after.periods).toHaveLength(before.periods.length);
    });
  });

  describe('with rescheduleOpenPeriod', () => {
    it('moves the open period to a date equal to the stored anchor when nothing is settled there', async () => {
      // Re-anchoring a finished plan and raising its cap in one edit reopens it from the
      // last paid period, which leaves the anchor ahead of the open period on a free date.
      const paidDate = secondOfMonth({ monthsAhead: 1 });
      const anchor = plusDays({ dueDate: paidDate, days: 70 });
      const account = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ initialBalance: 1000 }),
        raw: true,
      });
      const { id } = await helpers.createSubscription({
        name: 'Plan',
        type: SUBSCRIPTION_TYPES.installment,
        frequency: SUBSCRIPTION_FREQUENCIES.monthly,
        startDate: paidDate,
        dueDate: paidDate,
        accountId: account.id,
        categoryId: global.DEFAULT_CATEGORY_ID,
        expectedAmount: 10,
        expectedCurrencyCode: global.BASE_CURRENCY.code,
        maxOccurrences: 1,
        raw: true,
      });
      await settleOpenPeriod({ id, action: 'pay' });
      await helpers.updateSubscription({ id, dueDate: anchor, maxOccurrences: 3, raw: true });

      const before = await getPeriods({ id });
      expect(before.open).toHaveLength(1);
      expect(before.open[0]!.dueDate).not.toBe(anchor);

      const updated = await helpers.updateSubscription({ id, dueDate: anchor, rescheduleOpenPeriod: true, raw: true });

      const after = await getPeriods({ id });
      expect(after.open).toHaveLength(1);
      expect(after.open[0]!.id).toBe(before.open[0]!.id);
      expect(after.open[0]!.dueDate).toBe(anchor);
      expect(after.open[0]!.status).toBe(SUBSCRIPTION_PERIOD_STATUSES.upcoming);
      expect(updated.dueDate).toBe(anchor);
      expect(after.settled.map((period) => period.dueDate)).toEqual([paidDate]);
    });

    it('rolls a date with a paid period forward to the next occurrence, and the schedule follows', async () => {
      const { id, anchor, openPeriodId } = await createScheduleWithSettledAnchor({ action: 'pay' });
      const nextOccurrence = plusMonths({ dueDate: anchor, months: 1 });

      const updated = await helpers.updateSubscription({
        id,
        dueDate: anchor,
        rescheduleOpenPeriod: true,
        raw: true,
      });

      const after = await getPeriods({ id });
      expect(after.open).toHaveLength(1);
      expect(after.open[0]!.id).toBe(openPeriodId);
      expect(after.open[0]!.dueDate).toBe(nextOccurrence);
      expect(after.settled.map((period) => period.dueDate)).toEqual([anchor]);
      expect(updated.anchorDay).toBe(2);

      const detail = await helpers.getSubscriptionById({ id, raw: true });
      expect(detail.nextExpectedDate).toBe(nextOccurrence);

      await settleOpenPeriod({ id, action: 'pay' });

      const generated = await getPeriods({ id });
      expect(generated.open.map((period) => period.dueDate)).toEqual([plusMonths({ dueDate: anchor, months: 2 })]);
    });

    it('rolls a date with a skipped period forward to the next occurrence', async () => {
      const { id, anchor, openPeriodId } = await createScheduleWithSettledAnchor({ action: 'skip' });

      await helpers.updateSubscription({ id, dueDate: anchor, rescheduleOpenPeriod: true, raw: true });

      const after = await getPeriods({ id });
      expect(after.open).toHaveLength(1);
      expect(after.open[0]!.id).toBe(openPeriodId);
      expect(after.open[0]!.dueDate).toBe(plusMonths({ dueDate: anchor, months: 1 }));
      expect(after.settled.map((period) => period.status)).toEqual([SUBSCRIPTION_PERIOD_STATUSES.skipped]);
    });

    it('keeps rolling past consecutive settled cycles', async () => {
      const anchor = secondOfMonth({ monthsAhead: 1 });
      const { id } = await createMonthlySubscription({ dueDate: anchor });
      await settleOpenPeriod({ id, action: 'pay' });
      await settleOpenPeriod({ id, action: 'skip' });

      await helpers.updateSubscription({
        id,
        dueDate: plusDays({ dueDate: anchor, days: 80 }),
        rescheduleOpenPeriod: true,
        raw: true,
      });
      await helpers.updateSubscription({ id, dueDate: anchor, rescheduleOpenPeriod: true, raw: true });

      const after = await getPeriods({ id });
      expect(after.open.map((period) => period.dueDate)).toEqual([plusMonths({ dueDate: anchor, months: 2 })]);
      expect(after.settled).toHaveLength(2);
    });

    it('marks an open period rolled onto a past date overdue', async () => {
      const paidDate = toIso({ date: subMonths(parseISO(secondOfMonth({ monthsAhead: 0 })), 3) });
      const { id } = await createMonthlySubscription({ dueDate: paidDate });
      await settleOpenPeriod({ id, action: 'pay' });

      await helpers.updateSubscription({
        id,
        dueDate: plusDays({ dueDate: secondOfMonth({ monthsAhead: 1 }), days: 3 }),
        rescheduleOpenPeriod: true,
        raw: true,
      });
      const upcoming = await getPeriods({ id });
      expect(upcoming.open[0]!.status).toBe(SUBSCRIPTION_PERIOD_STATUSES.upcoming);

      await helpers.updateSubscription({ id, dueDate: paidDate, rescheduleOpenPeriod: true, raw: true });

      const after = await getPeriods({ id });
      expect(after.open.map((period) => period.dueDate)).toEqual([plusMonths({ dueDate: paidDate, months: 1 })]);
      expect(after.open[0]!.status).toBe(SUBSCRIPTION_PERIOD_STATUSES.overdue);
    });

    it('seeds the first open period for a subscription that has never had one', async () => {
      const dueDate = secondOfMonth({ monthsAhead: 1 });
      const { id } = await helpers.createSubscription({
        name: 'Detection only',
        frequency: SUBSCRIPTION_FREQUENCIES.monthly,
        startDate: dueDate,
        expectedAmount: 10,
        expectedCurrencyCode: global.BASE_CURRENCY.code,
        matchingRules: { rules: [{ field: 'note', operator: 'contains_any', value: ['Detection only'] }] },
        raw: true,
      });
      expect((await getPeriods({ id })).periods).toHaveLength(0);

      await helpers.updateSubscription({ id, dueDate, rescheduleOpenPeriod: true, raw: true });

      const after = await getPeriods({ id });
      expect(after.open.map((period) => period.dueDate)).toEqual([dueDate]);
    });

    it('does not reopen a finished installment that has no open period', async () => {
      const paidDate = secondOfMonth({ monthsAhead: 1 });
      const newDate = plusDays({ dueDate: paidDate, days: 40 });
      const account = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ initialBalance: 1000 }),
        raw: true,
      });
      const { id } = await helpers.createSubscription({
        name: 'Finished plan',
        type: SUBSCRIPTION_TYPES.installment,
        frequency: SUBSCRIPTION_FREQUENCIES.monthly,
        startDate: paidDate,
        dueDate: paidDate,
        accountId: account.id,
        categoryId: global.DEFAULT_CATEGORY_ID,
        expectedAmount: 10,
        expectedCurrencyCode: global.BASE_CURRENCY.code,
        maxOccurrences: 1,
        raw: true,
      });
      await settleOpenPeriod({ id, action: 'pay' });

      const updated = await helpers.updateSubscription({ id, dueDate: newDate, rescheduleOpenPeriod: true, raw: true });

      const after = await getPeriods({ id });
      expect(after.open).toHaveLength(0);
      expect(after.settled.map((period) => period.dueDate)).toEqual([paidDate]);
      expect(updated.dueDate).toBe(newDate);
    });

    it('moves only the open period of a running installment and stays under its cap', async () => {
      const paidDate = secondOfMonth({ monthsAhead: 1 });
      const account = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ initialBalance: 1000 }),
        raw: true,
      });
      const { id } = await helpers.createSubscription({
        name: 'Running plan',
        type: SUBSCRIPTION_TYPES.installment,
        frequency: SUBSCRIPTION_FREQUENCIES.monthly,
        startDate: paidDate,
        dueDate: paidDate,
        accountId: account.id,
        categoryId: global.DEFAULT_CATEGORY_ID,
        expectedAmount: 10,
        expectedCurrencyCode: global.BASE_CURRENCY.code,
        maxOccurrences: 2,
        raw: true,
      });
      await settleOpenPeriod({ id, action: 'pay' });

      await helpers.updateSubscription({ id, dueDate: paidDate, rescheduleOpenPeriod: true, raw: true });

      const after = await getPeriods({ id });
      expect(after.open.map((period) => period.dueDate)).toEqual([plusMonths({ dueDate: paidDate, months: 1 })]);
      expect(after.settled.map((period) => period.dueDate)).toEqual([paidDate]);

      await settleOpenPeriod({ id, action: 'pay' });

      const finished = await getPeriods({ id });
      expect(finished.open).toHaveLength(0);
      expect(finished.settled).toHaveLength(2);
    });

    it('clearing the schedule still drops the open period and keeps the settled ones', async () => {
      const { id, anchor } = await createScheduleWithSettledAnchor({ action: 'pay' });

      const updated = await helpers.updateSubscription({ id, dueDate: null, raw: true });

      const after = await getPeriods({ id });
      expect(after.open).toHaveLength(0);
      expect(after.settled.map((period) => period.dueDate)).toEqual([anchor]);
      expect(updated.anchorDay).toBeNull();
    });

    it('changes nothing when the flag arrives without a due date', async () => {
      const { id, movedOpen } = await createScheduleWithSettledAnchor({ action: 'pay' });

      await helpers.updateSubscription({ id, name: 'Renamed', rescheduleOpenPeriod: true, raw: true });

      const after = await getPeriods({ id });
      expect(after.open.map((period) => period.dueDate)).toEqual([movedOpen]);
    });
  });
});
