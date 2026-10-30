import { SUBSCRIPTION_FREQUENCIES } from '@bt/shared/types';

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_STEP: Partial<Record<SUBSCRIPTION_FREQUENCIES, number>> = {
  [SUBSCRIPTION_FREQUENCIES.monthly]: 1,
  [SUBSCRIPTION_FREQUENCIES.quarterly]: 3,
  [SUBSCRIPTION_FREQUENCIES.semiAnnual]: 6,
  [SUBSCRIPTION_FREQUENCIES.annual]: 12,
};

const DAY_STEP: Partial<Record<SUBSCRIPTION_FREQUENCIES, number>> = {
  [SUBSCRIPTION_FREQUENCIES.weekly]: 7,
  [SUBSCRIPTION_FREQUENCIES.biweekly]: 14,
};

const utcDayNumber = ({ date }: { date: Date }): number =>
  Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / DAY_MS);

const daysInMonth = ({ year, month }: { year: number; month: number }): number =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** The due date the month of the reference shifted, clamped to the month end the way the schedule is. */
const dueDayNumberInMonth = ({ year, month, anchorDay }: { year: number; month: number; anchorDay: number }): number =>
  Date.UTC(year, month, Math.min(anchorDay, daysInMonth({ year, month }))) / DAY_MS;

/**
 * How many days the transaction's day lies from the nearest due date of the schedule that starts at
 * `dueDate` and repeats by `frequency` (month-end clamped to `anchorDay`). Both sides count UTC days,
 * the way `period-match-window` does. The rule is checked against the schedule, not against stored
 * periods, so the historical suggester can evaluate it without reading periods.
 */
export const daysFromSchedule = ({
  transactionTime,
  dueDate,
  frequency,
  anchorDay,
}: {
  transactionTime: Date;
  dueDate: string;
  frequency: SUBSCRIPTION_FREQUENCIES;
  anchorDay: number;
}): number => {
  const txDay = utcDayNumber({ date: transactionTime });
  const reference = new Date(dueDate + 'T00:00:00Z');

  const dayStep = DAY_STEP[frequency];
  if (dayStep) {
    const offset = txDay - utcDayNumber({ date: reference });
    const remainder = ((offset % dayStep) + dayStep) % dayStep;
    return Math.min(remainder, dayStep - remainder);
  }

  const monthStep = MONTH_STEP[frequency];
  if (!monthStep) throw new Error(`Unknown frequency: ${frequency}`);

  const monthsFromReference =
    (transactionTime.getUTCFullYear() - reference.getUTCFullYear()) * 12 +
    (transactionTime.getUTCMonth() - reference.getUTCMonth());
  const nearestIndex = Math.floor(monthsFromReference / monthStep);

  let best = Infinity;
  for (let index = nearestIndex - 1; index <= nearestIndex + 2; index++) {
    const absoluteMonth = reference.getUTCMonth() + index * monthStep;
    const year = reference.getUTCFullYear() + Math.floor(absoluteMonth / 12);
    const month = ((absoluteMonth % 12) + 12) % 12;
    best = Math.min(best, Math.abs(dueDayNumberInMonth({ year, month, anchorDay }) - txDay));
  }
  return best;
};

/** Whether the transaction lands within `days` days (inclusive) of a due date of the subscription's schedule. */
export const isWithinDaysOfDueDate = ({
  transactionTime,
  days,
  subscription,
}: {
  transactionTime: Date;
  days: number;
  subscription: { dueDate: string | null; anchorDay: number | null; frequency: SUBSCRIPTION_FREQUENCIES };
}): boolean => {
  if (!subscription.dueDate) return false;
  const anchorDay = subscription.anchorDay ?? new Date(subscription.dueDate + 'T00:00:00Z').getUTCDate();
  return (
    daysFromSchedule({
      transactionTime,
      dueDate: subscription.dueDate,
      frequency: subscription.frequency,
      anchorDay,
    }) <= days
  );
};
