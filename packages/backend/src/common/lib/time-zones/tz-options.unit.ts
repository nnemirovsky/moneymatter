import { describe, expect, it } from '@jest/globals';
import { addMonths, startOfDay, startOfMonth, startOfWeek } from 'date-fns';

import { toInstant, tzOptions } from './tz-options';

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
