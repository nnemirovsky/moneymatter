import { describe, expect, it } from '@jest/globals';
import { addMonths, startOfDay, startOfMonth, startOfWeek } from 'date-fns';

import { dayBoundEnd, dayBoundStart } from './day-bounds';
import { localDay, toInstant, tzOptions } from './tz-options';

const startOfMonthIn = ({ iso, zone }: { iso: string; zone: string }) =>
  toInstant({ date: startOfMonth(new Date(iso), tzOptions({ zone })) }).toISOString();

describe('tzOptions', () => {
  it('starts a Tbilisi month at local midnight', () => {
    expect(startOfMonthIn({ iso: '2026-10-15T12:00:00Z', zone: 'Asia/Tbilisi' })).toBe('2026-09-30T20:00:00.000Z');
  });

  it("spans New York's 25-hour November day between consecutive day starts", () => {
    const options = tzOptions({ zone: 'America/New_York' });
    const start = toInstant({ date: startOfDay(new Date('2026-11-01T12:00:00Z'), options) });
    const next = toInstant({ date: startOfDay(new Date('2026-11-02T12:00:00Z'), options) });
    expect((next.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });

  it('keeps a New York November bucket across the DST switch', () => {
    const options = tzOptions({ zone: 'America/New_York' });
    const november = toInstant({ date: startOfMonth(new Date('2026-11-10T12:00:00Z'), options) });
    const december = toInstant({ date: addMonths(november, 1, options) });
    expect(november.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(december.toISOString()).toBe('2026-12-01T05:00:00.000Z');
  });

  it('starts weeks on the zone-local Monday', () => {
    const monday = startOfWeek(new Date('2026-10-20T21:30:00Z'), {
      weekStartsOn: 1,
      ...tzOptions({ zone: 'Asia/Tbilisi' }),
    });
    expect(toInstant({ date: monday }).toISOString()).toBe('2026-10-18T20:00:00.000Z');
  });
});

describe('localDay', () => {
  it('names the calendar day of the zone, not of UTC', () => {
    const now = new Date('2026-10-31T21:30:00Z');
    expect(localDay({ zone: 'Asia/Tbilisi', now })).toBe('2026-11-01');
    expect(localDay({ zone: 'UTC', now })).toBe('2026-10-31');
    expect(localDay({ zone: 'America/New_York', now })).toBe('2026-10-31');
  });

  it('counts days back in the zone', () => {
    expect(localDay({ zone: 'Asia/Tbilisi', daysAgo: 30, now: new Date('2026-10-31T21:30:00Z') })).toBe('2026-10-02');
  });
});

describe('day bounds', () => {
  it('reads a yyyy-MM-dd bound in the zone and an ISO bound as an exact instant', () => {
    expect(dayBoundStart({ value: '2026-10-21', zone: 'Asia/Tbilisi' }).toISOString()).toBe('2026-10-20T20:00:00.000Z');
    expect(dayBoundEnd({ value: '2026-10-21', zone: 'Asia/Tbilisi' }).toISOString()).toBe('2026-10-21T19:59:59.999Z');
    expect(dayBoundStart({ value: '2026-10-21T05:00:00.000Z', zone: 'Asia/Tbilisi' }).toISOString()).toBe(
      '2026-10-21T05:00:00.000Z',
    );
  });
});
