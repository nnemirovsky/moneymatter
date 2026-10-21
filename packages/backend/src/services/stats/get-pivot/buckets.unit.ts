import { describe, expect, it } from '@jest/globals';
import { format } from 'date-fns';

import { generatePivotBuckets, getBucketKey, getBucketLabel } from './buckets';

const fmt = (date: Date): string => format(date, 'yyyy-MM-dd');

describe('generatePivotBuckets', () => {
  it('yearly: one bucket per calendar year, edges clamped to range', () => {
    const buckets = generatePivotBuckets({ from: '2023-03-15', to: '2025-08-10', granularity: 'yearly', zone: 'UTC' });

    expect(buckets).toHaveLength(3);
    // First bucket starts at `from`, not at start of year.
    expect(fmt(buckets[0]!.periodStart)).toBe('2023-03-15');
    expect(fmt(buckets[0]!.periodEnd)).toBe('2023-12-31');
    expect(fmt(buckets[1]!.periodStart)).toBe('2024-01-01');
    expect(fmt(buckets[1]!.periodEnd)).toBe('2024-12-31');
    expect(fmt(buckets[2]!.periodStart)).toBe('2025-01-01');
    // Last bucket ends at `to`, not at end of year.
    expect(fmt(buckets[2]!.periodEnd)).toBe('2025-08-10');
  });

  it('quarterly: one bucket per quarter across a year boundary', () => {
    const buckets = generatePivotBuckets({
      from: '2024-11-01',
      to: '2025-05-31',
      granularity: 'quarterly',
      zone: 'UTC',
    });

    // Q4 2024, Q1 2025, Q2 2025
    expect(buckets).toHaveLength(3);
    expect(fmt(buckets[0]!.periodStart)).toBe('2024-11-01');
    expect(fmt(buckets[0]!.periodEnd)).toBe('2024-12-31');
    expect(fmt(buckets[1]!.periodStart)).toBe('2025-01-01');
    expect(fmt(buckets[1]!.periodEnd)).toBe('2025-03-31');
    expect(fmt(buckets[2]!.periodStart)).toBe('2025-04-01');
    expect(fmt(buckets[2]!.periodEnd)).toBe('2025-05-31');
  });

  it('monthly: one bucket per month, edges clamped', () => {
    const buckets = generatePivotBuckets({ from: '2025-01-10', to: '2025-03-05', granularity: 'monthly', zone: 'UTC' });

    expect(buckets).toHaveLength(3);
    expect(fmt(buckets[0]!.periodStart)).toBe('2025-01-10');
    expect(fmt(buckets[0]!.periodEnd)).toBe('2025-01-31');
    expect(fmt(buckets[1]!.periodStart)).toBe('2025-02-01');
    expect(fmt(buckets[1]!.periodEnd)).toBe('2025-02-28');
    expect(fmt(buckets[2]!.periodStart)).toBe('2025-03-01');
    expect(fmt(buckets[2]!.periodEnd)).toBe('2025-03-05');
  });

  it('weekly: Monday-based buckets', () => {
    // 2025-01-06 is a Monday.
    const buckets = generatePivotBuckets({ from: '2025-01-06', to: '2025-01-19', granularity: 'weekly', zone: 'UTC' });

    expect(buckets).toHaveLength(2);
    expect(fmt(buckets[0]!.periodStart)).toBe('2025-01-06');
    expect(fmt(buckets[0]!.periodEnd)).toBe('2025-01-12');
    expect(fmt(buckets[1]!.periodStart)).toBe('2025-01-13');
    expect(fmt(buckets[1]!.periodEnd)).toBe('2025-01-19');
  });

  it('weekly: clamps the first bucket start to a mid-week `from`', () => {
    // 2025-01-08 is a Wednesday; its week starts on Monday 2025-01-06. The first bucket must
    // start at `from` (clamped forward), not at the week's Monday — exercising the edge clamp the
    // Monday-aligned test above never triggers.
    const buckets = generatePivotBuckets({ from: '2025-01-08', to: '2025-01-19', granularity: 'weekly', zone: 'UTC' });

    expect(buckets).toHaveLength(2);
    expect(fmt(buckets[0]!.periodStart)).toBe('2025-01-08'); // clamped to `from`, not 2025-01-06
    expect(fmt(buckets[0]!.periodEnd)).toBe('2025-01-12'); // Sunday, end of the containing week
    expect(fmt(buckets[1]!.periodStart)).toBe('2025-01-13');
    expect(fmt(buckets[1]!.periodEnd)).toBe('2025-01-19');
  });

  it('single-day range yields exactly one bucket', () => {
    const buckets = generatePivotBuckets({ from: '2025-06-15', to: '2025-06-15', granularity: 'monthly', zone: 'UTC' });
    expect(buckets).toHaveLength(1);
  });
});

describe('getBucketKey', () => {
  it('produces stable, year-scoped keys', () => {
    const d = new Date('2025-03-03T00:00:00Z');
    expect(getBucketKey({ periodStart: d, granularity: 'yearly', zone: 'UTC' })).toBe('2025');
    expect(getBucketKey({ periodStart: d, granularity: 'quarterly', zone: 'UTC' })).toBe('2025-Q1');
    expect(getBucketKey({ periodStart: d, granularity: 'monthly', zone: 'UTC' })).toBe('2025-03');
    // 2025-03-03 is a Monday, so the week key is that same date.
    expect(getBucketKey({ periodStart: d, granularity: 'weekly', zone: 'UTC' })).toBe('2025-03-03');
  });

  it('weekly key normalizes to the containing week Monday', () => {
    // 2025-03-05 is a Wednesday -> the week Monday is 2025-03-03.
    expect(getBucketKey({ periodStart: new Date('2025-03-05T00:00:00Z'), granularity: 'weekly', zone: 'UTC' })).toBe(
      '2025-03-03',
    );
  });

  it('quarter keys differ across years', () => {
    expect(getBucketKey({ periodStart: new Date('2024-02-01T00:00:00Z'), granularity: 'quarterly', zone: 'UTC' })).toBe(
      '2024-Q1',
    );
    expect(getBucketKey({ periodStart: new Date('2025-02-01T00:00:00Z'), granularity: 'quarterly', zone: 'UTC' })).toBe(
      '2025-Q1',
    );
  });
});

describe('getBucketLabel', () => {
  it('produces human-readable labels', () => {
    const d = new Date('2025-03-03T00:00:00Z');
    expect(getBucketLabel({ periodStart: d, granularity: 'yearly', zone: 'UTC' })).toBe('2025');
    expect(getBucketLabel({ periodStart: d, granularity: 'quarterly', zone: 'UTC' })).toBe('Q1 2025');
    expect(getBucketLabel({ periodStart: d, granularity: 'monthly', zone: 'UTC' })).toBe('Mar 2025');
    expect(getBucketLabel({ periodStart: d, granularity: 'weekly', zone: 'UTC' })).toBe('Wk of 2025-03-03');
  });
});

describe('pivot buckets in a zone', () => {
  it('keys a Tbilisi October bucket as 2026-10 although its start is still September in UTC', () => {
    const [bucket] = generatePivotBuckets({
      from: '2026-10-01',
      to: '2026-10-31',
      granularity: 'monthly',
      zone: 'Asia/Tbilisi',
    });

    expect(bucket!.periodStart.toISOString()).toBe('2026-09-30T20:00:00.000Z');
    expect(getBucketKey({ periodStart: bucket!.periodStart, granularity: 'monthly', zone: 'Asia/Tbilisi' })).toBe(
      '2026-10',
    );
    expect(getBucketLabel({ periodStart: bucket!.periodStart, granularity: 'monthly', zone: 'Asia/Tbilisi' })).toBe(
      'Oct 2026',
    );
  });
});
