import { describe, expect, it } from '@jest/globals';

import { clipRange, rangesIntersect, subtractRanges, tomorrowIn, utcInstant, zonedInstant } from './date-ranges';

describe('rangesIntersect', () => {
  it('treats the end as exclusive', () => {
    expect(
      rangesIntersect({ a: { from: '2026-01-01', until: '2026-02-01' }, b: { from: '2026-02-01', until: null } }),
    ).toBe(false);
    expect(
      rangesIntersect({ a: { from: '2026-01-01', until: '2026-03-01' }, b: { from: '2026-02-01', until: null } }),
    ).toBe(true);
  });

  it('is symmetric and handles two open ends', () => {
    const a = { from: '2026-01-01', until: null };
    const b = { from: '2026-05-01', until: null };

    expect(rangesIntersect({ a, b })).toBe(true);
    expect(rangesIntersect({ a: b, b: a })).toBe(true);
  });

  it('separates two closed ranges that only touch', () => {
    expect(
      rangesIntersect({
        a: { from: '2026-01-01', until: '2026-02-01' },
        b: { from: '2026-02-01', until: '2026-03-01' },
      }),
    ).toBe(false);
  });
});

describe('clipRange', () => {
  it('narrows both ends to the bounds', () => {
    expect(
      clipRange({
        range: { from: '2026-01-01', until: null },
        bounds: { from: '2026-02-01', until: '2026-04-01' },
      }),
    ).toEqual({ from: '2026-02-01', until: '2026-04-01' });
  });

  it('keeps the earlier of two closed ends', () => {
    expect(
      clipRange({
        range: { from: '2026-01-01', until: '2026-03-01' },
        bounds: { from: '2026-02-01', until: '2026-06-01' },
      }),
    ).toEqual({ from: '2026-02-01', until: '2026-03-01' });
  });

  it('keeps an open end when the bounds are open too', () => {
    expect(
      clipRange({ range: { from: '2026-03-01', until: null }, bounds: { from: '2026-01-01', until: null } }),
    ).toEqual({ from: '2026-03-01', until: null });
  });

  it('returns null when the bounds leave nothing', () => {
    expect(
      clipRange({ range: { from: '2026-05-01', until: null }, bounds: { from: '2026-01-01', until: '2026-05-01' } }),
    ).toBeNull();
    expect(
      clipRange({ range: { from: '2026-01-01', until: '2026-02-01' }, bounds: { from: '2026-03-01', until: null } }),
    ).toBeNull();
  });

  it('returns null for empty bounds', () => {
    expect(
      clipRange({ range: { from: '2026-01-01', until: null }, bounds: { from: '2026-03-01', until: '2026-03-01' } }),
    ).toBeNull();
  });
});

describe('subtractRanges', () => {
  it('leaves two parts when a cut sits in the middle', () => {
    expect(
      subtractRanges({
        range: { from: '2026-01-01', until: null },
        cuts: [{ from: '2026-03-01', until: '2026-05-01' }],
      }),
    ).toEqual([
      { from: '2026-01-01', until: '2026-03-01' },
      { from: '2026-05-01', until: null },
    ]);
  });

  it('leaves nothing when the cuts cover the whole range', () => {
    expect(
      subtractRanges({
        range: { from: '2026-01-01', until: '2026-06-01' },
        cuts: [
          { from: '2026-03-01', until: null },
          { from: '2025-12-01', until: '2026-03-01' },
        ],
      }),
    ).toEqual([]);
  });

  it('keeps the range when no cut overlaps it', () => {
    const range = { from: '2026-01-01', until: '2026-03-01' };

    expect(
      subtractRanges({
        range,
        cuts: [
          { from: '2025-06-01', until: '2026-01-01' },
          { from: '2026-03-01', until: null },
        ],
      }),
    ).toEqual([range]);
  });
});

describe('zonedInstant', () => {
  it('is local midnight of the plan day in the zone', () => {
    expect(zonedInstant({ date: '2026-10-01', zone: 'Asia/Tbilisi' }).toISOString()).toBe('2026-09-30T20:00:00.000Z');
    expect(zonedInstant({ date: '2026-11-01', zone: 'America/New_York' }).toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
  });

  it('equals utcInstant for UTC', () => {
    expect(zonedInstant({ date: '2026-10-01', zone: 'UTC' }).getTime()).toBe(
      utcInstant({ date: '2026-10-01' }).getTime(),
    );
  });
});

describe('tomorrowIn', () => {
  it('is the day after the local date, not after the UTC date', () => {
    // 23:00Z on the 22nd is 08:00 on the 23rd in Tokyo.
    const now = new Date('2026-10-22T23:00:00Z');
    expect(tomorrowIn({ zone: 'Asia/Tokyo', now })).toBe('2026-10-24');
    expect(tomorrowIn({ zone: 'UTC', now })).toBe('2026-10-23');
    expect(tomorrowIn({ zone: 'America/New_York', now })).toBe('2026-10-23');
  });

  it('starts after every transaction up to now', () => {
    const now = new Date('2026-10-22T23:00:00Z');
    for (const zone of ['Asia/Tokyo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
      expect(zonedInstant({ date: tomorrowIn({ zone, now }), zone }).getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

describe('zonedInstant on an ambiguous local midnight', () => {
  it('takes the earlier instant when a fall-back repeats the hour after midnight', () => {
    // Havana turns its clocks back from 01:00 to 00:00 on 2026-11-01, so 00:00-00:59 happens twice.
    expect(zonedInstant({ date: '2026-11-01', zone: 'America/Havana' }).toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });
});
