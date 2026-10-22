import { describe, expect, it } from '@jest/globals';

import { PeriodBucket, findBucketIndex, generatePeriodBuckets } from './index';

describe('findBucketIndex', () => {
  const buckets: PeriodBucket[] = [
    { periodStart: new Date('2025-01-01T00:00:00Z'), periodEnd: new Date('2025-01-31T23:59:59Z') },
    { periodStart: new Date('2025-02-01T00:00:00Z'), periodEnd: new Date('2025-02-28T23:59:59Z') },
    { periodStart: new Date('2025-03-01T00:00:00Z'), periodEnd: new Date('2025-03-31T23:59:59Z') },
  ];

  it('locates the bucket a time falls inside', () => {
    expect(findBucketIndex({ transactionTime: new Date('2025-01-15T12:00:00Z'), buckets })).toBe(0);
    expect(findBucketIndex({ transactionTime: new Date('2025-02-15T12:00:00Z'), buckets })).toBe(1);
    expect(findBucketIndex({ transactionTime: new Date('2025-03-20T12:00:00Z'), buckets })).toBe(2);
  });

  it('treats both bucket edges as inclusive', () => {
    // Exactly on a periodStart.
    expect(findBucketIndex({ transactionTime: new Date('2025-02-01T00:00:00Z'), buckets })).toBe(1);
    // Exactly on a periodEnd.
    expect(findBucketIndex({ transactionTime: new Date('2025-02-28T23:59:59Z'), buckets })).toBe(1);
  });

  it('returns -1 when the time is outside every bucket', () => {
    expect(findBucketIndex({ transactionTime: new Date('2024-12-31T23:59:59Z'), buckets })).toBe(-1);
    expect(findBucketIndex({ transactionTime: new Date('2025-04-01T00:00:00Z'), buckets })).toBe(-1);
  });
});

describe('generatePeriodBuckets in a zone', () => {
  const iso = (date: Date) => date.toISOString();

  it('starts Tbilisi month buckets at local midnight and clamps the edges to the range days', () => {
    const buckets = generatePeriodBuckets({
      from: '2026-09-15',
      to: '2026-10-21',
      granularity: 'monthly',
      zone: 'Asia/Tbilisi',
    });

    expect(buckets.map((bucket) => [iso(bucket.periodStart), iso(bucket.periodEnd)])).toEqual([
      ['2026-09-14T20:00:00.000Z', '2026-09-30T19:59:59.999Z'],
      ['2026-09-30T20:00:00.000Z', '2026-10-21T19:59:59.999Z'],
    ]);
  });

  it("lets New York's November bucket span the 25-hour day", () => {
    const [november] = generatePeriodBuckets({
      from: '2026-11-01',
      to: '2026-11-30',
      granularity: 'monthly',
      zone: 'America/New_York',
    });

    expect(iso(november!.periodStart)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(november!.periodEnd)).toBe('2026-12-01T04:59:59.999Z');
  });

  it('cuts 23- and 25-hour daily buckets on the DST switch days', () => {
    const buckets = generatePeriodBuckets({
      from: '2026-11-01',
      to: '2026-11-02',
      granularity: 'daily',
      zone: 'America/New_York',
    });

    expect(
      buckets.map((bucket) => (bucket.periodEnd.getTime() - bucket.periodStart.getTime() + 1) / 3_600_000),
    ).toEqual([25, 24]);
  });

  it('keeps UTC buckets identical to the plain UTC calendar', () => {
    const buckets = generatePeriodBuckets({
      from: '2026-01-31',
      to: '2026-03-02',
      granularity: 'monthly',
      zone: 'UTC',
    });

    expect(buckets.map((bucket) => iso(bucket.periodStart))).toEqual([
      '2026-01-31T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ]);
  });

  it('handles the extreme zones Pacific/Kiritimati and Pacific/Pago_Pago', () => {
    const [kiritimati] = generatePeriodBuckets({
      from: '2026-10-21',
      to: '2026-10-21',
      granularity: 'daily',
      zone: 'Pacific/Kiritimati',
    });
    const [pago] = generatePeriodBuckets({
      from: '2026-10-21',
      to: '2026-10-21',
      granularity: 'daily',
      zone: 'Pacific/Pago_Pago',
    });

    expect(iso(kiritimati!.periodStart)).toBe('2026-10-20T10:00:00.000Z');
    expect(iso(pago!.periodStart)).toBe('2026-10-21T11:00:00.000Z');
  });
});
