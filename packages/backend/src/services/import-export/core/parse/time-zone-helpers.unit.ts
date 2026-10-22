import {
  formatOffset,
  isValidTimeZone,
  resolveRecordedZone,
  wallClockToInstant,
  zonedDayEnd,
  zonedDayStart,
  zoneOffsetMinutes,
} from '@bt/shared/time-zone';
import { describe, expect, it } from '@jest/globals';

const wall = ({ iso }: { iso: string }) => {
  const [date, time] = iso.split('T') as [string, string];
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return { year, month, day, hour, minute, second: 0, ms: 0 };
};

describe('isValidTimeZone', () => {
  it.each(['Asia/Tbilisi', 'Europe/Kiev', 'UTC'])('accepts %s', (zone) => {
    expect(isValidTimeZone({ zone })).toBe(true);
  });

  it.each(['+04:00', 'Mars/Base', ''])('refuses "%s"', (zone) => {
    expect(isValidTimeZone({ zone })).toBe(false);
  });
});

describe('zoneOffsetMinutes', () => {
  it('handles a 45-minute offset', () => {
    expect(zoneOffsetMinutes({ zone: 'Asia/Kathmandu', instant: new Date('2026-10-21T12:00:00Z') })).toBe(345);
  });

  it('follows New York across both 2026 DST switches', () => {
    const zone = 'America/New_York';
    expect(zoneOffsetMinutes({ zone, instant: new Date('2026-03-08T06:59:59Z') })).toBe(-300);
    expect(zoneOffsetMinutes({ zone, instant: new Date('2026-03-08T07:00:00Z') })).toBe(-240);
    expect(zoneOffsetMinutes({ zone, instant: new Date('2026-11-01T05:59:59Z') })).toBe(-240);
    expect(zoneOffsetMinutes({ zone, instant: new Date('2026-11-01T06:00:00Z') })).toBe(-300);
  });
});

describe('wallClockToInstant', () => {
  it('moves a New York gap time forward by the gap', () => {
    const instant = wallClockToInstant({ wall: wall({ iso: '2026-03-08T02:30' }), zone: 'America/New_York' });
    expect(instant.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('moves a Kyiv gap time forward by the gap', () => {
    // Kyiv springs forward at 03:00 on 2026-03-29 (00:00Z), 03:30 does not exist.
    const instant = wallClockToInstant({ wall: wall({ iso: '2026-03-29T03:30' }), zone: 'Europe/Kyiv' });
    expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('takes the earlier instant in a New York overlap', () => {
    const instant = wallClockToInstant({ wall: wall({ iso: '2026-11-01T01:30' }), zone: 'America/New_York' });
    expect(instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('takes the earlier instant in a Kyiv overlap', () => {
    const instant = wallClockToInstant({ wall: wall({ iso: '2026-10-25T03:30' }), zone: 'Europe/Kyiv' });
    expect(instant.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('reads an ordinary wall clock', () => {
    const instant = wallClockToInstant({ wall: wall({ iso: '2026-10-21T16:00' }), zone: 'Asia/Tbilisi' });
    expect(instant.toISOString()).toBe('2026-10-21T12:00:00.000Z');
  });

  it('handles Kiritimati (+14)', () => {
    const instant = wallClockToInstant({ wall: wall({ iso: '2026-10-21T16:00' }), zone: 'Pacific/Kiritimati' });
    expect(instant.toISOString()).toBe('2026-10-21T02:00:00.000Z');
  });
});

describe('zonedDayStart / zonedDayEnd', () => {
  it('bounds a Tbilisi day', () => {
    expect(zonedDayStart({ date: '2026-10-21', zone: 'Asia/Tbilisi' }).toISOString()).toBe('2026-10-20T20:00:00.000Z');
    expect(zonedDayEnd({ date: '2026-10-21', zone: 'Asia/Tbilisi' }).toISOString()).toBe('2026-10-21T19:59:59.999Z');
  });

  it('spans 23 hours on the New York spring-forward day', () => {
    const start = zonedDayStart({ date: '2026-03-08', zone: 'America/New_York' });
    const end = zonedDayEnd({ date: '2026-03-08', zone: 'America/New_York' });
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(end.getTime() - start.getTime() + 1).toBe(23 * 3_600_000);
  });

  it('spans 25 hours on the New York fall-back day', () => {
    const start = zonedDayStart({ date: '2026-11-01', zone: 'America/New_York' });
    const end = zonedDayEnd({ date: '2026-11-01', zone: 'America/New_York' });
    expect(start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(end.getTime() - start.getTime() + 1).toBe(25 * 3_600_000);
  });

  it('bounds Kiritimati and Pago Pago days', () => {
    expect(zonedDayStart({ date: '2026-10-21', zone: 'Pacific/Kiritimati' }).toISOString()).toBe(
      '2026-10-20T10:00:00.000Z',
    );
    expect(zonedDayEnd({ date: '2026-10-21', zone: 'Pacific/Pago_Pago' }).toISOString()).toBe(
      '2026-10-22T10:59:59.999Z',
    );
  });
});

describe('resolveRecordedZone', () => {
  const instant = new Date('2026-10-21T12:00:00Z');

  it('1: an explicit zone wins and derives the offset', () => {
    expect(
      resolveRecordedZone({
        instant,
        explicitZone: 'America/New_York',
        offsetMinutes: 120,
        candidateZone: 'Asia/Tbilisi',
      }),
    ).toEqual({ timeZone: 'America/New_York', utcOffsetMinutes: -240 });
  });

  it('2: an offset matching the candidate records the candidate', () => {
    expect(resolveRecordedZone({ instant, offsetMinutes: 240, candidateZone: 'Asia/Tbilisi' })).toEqual({
      timeZone: 'Asia/Tbilisi',
      utcOffsetMinutes: 240,
    });
  });

  it('3: an offset not matching the candidate records the offset only', () => {
    expect(resolveRecordedZone({ instant, offsetMinutes: 120, candidateZone: 'Asia/Tbilisi' })).toEqual({
      timeZone: null,
      utcOffsetMinutes: 120,
    });
  });

  it('treats an offset beyond +-14:00 as not stated', () => {
    expect(resolveRecordedZone({ instant, offsetMinutes: 900 })).toEqual({ timeZone: null, utcOffsetMinutes: null });
    expect(resolveRecordedZone({ instant, offsetMinutes: -1439, candidateZone: 'Asia/Tbilisi' })).toEqual({
      timeZone: 'Asia/Tbilisi',
      utcOffsetMinutes: 240,
    });
    expect(resolveRecordedZone({ instant, offsetMinutes: 840 })).toEqual({ timeZone: null, utcOffsetMinutes: 840 });
  });

  it('4: a candidate alone derives the offset', () => {
    expect(resolveRecordedZone({ instant, candidateZone: 'Asia/Tbilisi' })).toEqual({
      timeZone: 'Asia/Tbilisi',
      utcOffsetMinutes: 240,
    });
  });

  it('5: nothing records null, never offset 0', () => {
    expect(resolveRecordedZone({ instant })).toEqual({ timeZone: null, utcOffsetMinutes: null });
    expect(resolveRecordedZone({ instant, candidateZone: null, offsetMinutes: undefined })).toEqual({
      timeZone: null,
      utcOffsetMinutes: null,
    });
  });
});

describe('formatOffset', () => {
  it.each([
    [240, 'UTC+04:00'],
    [-300, 'UTC-05:00'],
    [0, 'UTC+00:00'],
    [345, 'UTC+05:45'],
    [-210, 'UTC-03:30'],
  ])('formats %d as %s', (minutes, expected) => {
    expect(formatOffset({ minutes })).toBe(expected);
  });
});
