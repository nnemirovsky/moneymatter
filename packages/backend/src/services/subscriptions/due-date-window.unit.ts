import { SUBSCRIPTION_FREQUENCIES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import { daysFromSchedule, isWithinDaysOfDueDate } from './due-date-window';

const at = (iso: string) => new Date(iso + 'T12:00:00Z');
const monthly = (dueDate: string) => ({
  dueDate,
  anchorDay: Number(dueDate.slice(8)),
  frequency: SUBSCRIPTION_FREQUENCIES.monthly,
});

describe('daysFromSchedule', () => {
  it('measures to the nearest monthly due date, before or after', () => {
    const args = { dueDate: '2025-01-30', frequency: SUBSCRIPTION_FREQUENCIES.monthly, anchorDay: 30 };
    expect(daysFromSchedule({ transactionTime: at('2025-05-30'), ...args })).toBe(0);
    expect(daysFromSchedule({ transactionTime: at('2025-05-27'), ...args })).toBe(3);
    expect(daysFromSchedule({ transactionTime: at('2025-06-02'), ...args })).toBe(3);
    expect(daysFromSchedule({ transactionTime: at('2025-05-15'), ...args })).toBe(15);
  });

  it('clamps a 30th anchor to the end of February, leap year included', () => {
    const args = { dueDate: '2025-01-30', frequency: SUBSCRIPTION_FREQUENCIES.monthly, anchorDay: 30 };
    expect(daysFromSchedule({ transactionTime: at('2025-02-28'), ...args })).toBe(0);
    expect(daysFromSchedule({ transactionTime: at('2025-03-01'), ...args })).toBe(1);
    expect(daysFromSchedule({ transactionTime: at('2028-02-29'), ...args })).toBe(0);
    expect(daysFromSchedule({ transactionTime: at('2025-03-30'), ...args })).toBe(0);
  });

  it('crosses year boundaries in both directions', () => {
    const args = { dueDate: '2025-06-30', frequency: SUBSCRIPTION_FREQUENCIES.monthly, anchorDay: 30 };
    expect(daysFromSchedule({ transactionTime: at('2026-01-02'), ...args })).toBe(3);
    expect(daysFromSchedule({ transactionTime: at('2024-12-31'), ...args })).toBe(1);
  });

  it('follows a quarterly and a weekly schedule', () => {
    expect(
      daysFromSchedule({
        transactionTime: at('2025-04-03'),
        dueDate: '2025-01-01',
        frequency: SUBSCRIPTION_FREQUENCIES.quarterly,
        anchorDay: 1,
      }),
    ).toBe(2);
    expect(
      daysFromSchedule({
        transactionTime: at('2025-02-15'),
        dueDate: '2025-01-01',
        frequency: SUBSCRIPTION_FREQUENCIES.quarterly,
        anchorDay: 1,
      }),
    ).toBeGreaterThan(30);
    expect(
      daysFromSchedule({
        transactionTime: at('2025-01-12'),
        dueDate: '2025-01-01',
        frequency: SUBSCRIPTION_FREQUENCIES.weekly,
        anchorDay: 1,
      }),
    ).toBe(3);
  });
});

describe('isWithinDaysOfDueDate', () => {
  it('is inclusive of the window edge and rejects outside it', () => {
    const subscription = monthly('2025-01-30');
    expect(isWithinDaysOfDueDate({ transactionTime: at('2025-05-27'), days: 3, subscription })).toBe(true);
    expect(isWithinDaysOfDueDate({ transactionTime: at('2025-05-26'), days: 3, subscription })).toBe(false);
  });

  it('never matches a subscription without a due date', () => {
    expect(
      isWithinDaysOfDueDate({
        transactionTime: at('2025-05-30'),
        days: 3,
        subscription: { dueDate: null, anchorDay: null, frequency: SUBSCRIPTION_FREQUENCIES.monthly },
      }),
    ).toBe(false);
  });
});
