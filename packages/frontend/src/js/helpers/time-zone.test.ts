import { format } from 'date-fns';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatDateTime,
  deviceTimeZone,
  formatRecordedZoneLine,
  getTransactionTimeTooltip,
  hasDistinctRecordedZone,
  formatInViewingZone,
  formatTime,
  formatZoneLabel,
  hourCyclePreference,
  resolveViewingTimeZone,
  viewingDayBoundIso,
  viewingNow,
  viewingTimeZone,
} from './time-zone';

// 2026-10-21 12:00 UTC is 16:00 in Tbilisi (GMT+4).
const INSTANT = new Date('2026-10-21T12:00:00.000Z');

describe('js/helpers/time-zone', () => {
  afterEach(() => {
    hourCyclePreference.value = null;
    viewingTimeZone.value = 'UTC';
  });

  describe('formatTime', () => {
    it('gives 24-hour time under h23', () => {
      hourCyclePreference.value = 'h23';
      expect(formatTime({ date: INSTANT, zone: 'Asia/Tbilisi' })).toBe('16:00');
    });

    it('gives 12-hour time under h12', () => {
      hourCyclePreference.value = 'h12';
      expect(formatTime({ date: INSTANT, zone: 'Asia/Tbilisi' })).toBe('4:00 PM');
    });

    it('reads the viewing zone when no zone is passed', () => {
      hourCyclePreference.value = 'h23';
      viewingTimeZone.value = 'America/New_York';
      expect(formatTime({ date: INSTANT })).toBe('08:00');
    });
  });

  describe('formatZoneLabel', () => {
    it('gives a short GMT offset', () => {
      expect(formatZoneLabel({ date: INSTANT, zone: 'Asia/Tbilisi' })).toBe('GMT+4');
      expect(formatZoneLabel({ date: INSTANT, zone: 'America/New_York' })).toBe('GMT-4');
      expect(formatZoneLabel({ date: INSTANT, zone: 'Asia/Kathmandu' })).toBe('GMT+5:45');
    });
  });

  describe('formatDateTime', () => {
    it('formats in a zone other than the runner zone, with the zone label', () => {
      hourCyclePreference.value = 'h23';
      expect(formatDateTime({ date: INSTANT, zone: 'Asia/Tbilisi' })).toBe('21 Oct 2026, 16:00 GMT+4');
    });

    it('rolls the date over in the zone', () => {
      hourCyclePreference.value = 'h23';
      expect(formatDateTime({ date: new Date('2026-10-21T21:30:00.000Z'), zone: 'Asia/Tbilisi' })).toBe(
        '22 Oct 2026, 01:30 GMT+4',
      );
    });
  });

  describe('formatInViewingZone', () => {
    it('applies the pattern in the viewing zone', () => {
      viewingTimeZone.value = 'Asia/Tbilisi';
      expect(formatInViewingZone({ date: INSTANT, pattern: 'yyyy-MM-dd HH:mm' })).toBe('2026-10-21 16:00');
    });
  });

  describe('resolveViewingTimeZone', () => {
    it('picks the manual zone over the device', () => {
      expect(
        resolveViewingTimeZone({
          settings: { timeZone: 'Asia/Tbilisi', timeZoneSource: 'manual' },
          deviceZone: 'Europe/Kyiv',
        }),
      ).toBe('Asia/Tbilisi');
    });

    it('picks the device zone when the source is device or unset', () => {
      expect(
        resolveViewingTimeZone({
          settings: { timeZone: 'Asia/Tbilisi', timeZoneSource: 'device' },
          deviceZone: 'Europe/Kyiv',
        }),
      ).toBe('Europe/Kyiv');
      expect(resolveViewingTimeZone({ settings: { timeZone: 'Asia/Tbilisi' }, deviceZone: 'Europe/Kyiv' })).toBe(
        'Europe/Kyiv',
      );
      expect(resolveViewingTimeZone({ settings: undefined, deviceZone: 'Europe/Kyiv' })).toBe('Europe/Kyiv');
    });

    it('falls back to the device zone for a manual source without a zone', () => {
      expect(resolveViewingTimeZone({ settings: { timeZoneSource: 'manual' }, deviceZone: 'Europe/Kyiv' })).toBe(
        'Europe/Kyiv',
      );
    });
  });

  describe('hasDistinctRecordedZone', () => {
    const base = { viewingZone: 'Asia/Tbilisi', instant: INSTANT };

    it('is false for an unknown zone', () => {
      expect(hasDistinctRecordedZone({ ...base, timeZone: null, utcOffsetMinutes: null })).toBe(false);
    });

    it('is false when the recorded offset equals the viewing offset at that instant', () => {
      expect(hasDistinctRecordedZone({ ...base, timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 })).toBe(false);
    });

    it('is true for a zone with another offset', () => {
      expect(hasDistinctRecordedZone({ ...base, timeZone: 'America/New_York', utcOffsetMinutes: -240 })).toBe(true);
    });

    it('is true for an offset-only row that differs, false when it matches', () => {
      expect(hasDistinctRecordedZone({ ...base, timeZone: null, utcOffsetMinutes: 120 })).toBe(true);
      expect(hasDistinctRecordedZone({ ...base, timeZone: null, utcOffsetMinutes: 240 })).toBe(false);
    });
  });

  describe('formatRecordedZoneLine', () => {
    afterEach(() => {
      hourCyclePreference.value = null;
    });

    it('names the zone with the time and offset label there', () => {
      hourCyclePreference.value = 'h23';
      expect(formatRecordedZoneLine({ timeZone: 'America/New_York', utcOffsetMinutes: -240, instant: INSTANT })).toBe(
        'America/New_York: 08:00 GMT-4',
      );
    });

    it('shows an offset-only row as its UTC offset', () => {
      hourCyclePreference.value = 'h23';
      expect(formatRecordedZoneLine({ timeZone: null, utcOffsetMinutes: 120, instant: INSTANT })).toBe(
        'UTC+02:00: 14:00',
      );
    });
  });

  describe('getTransactionTimeTooltip', () => {
    afterEach(() => {
      hourCyclePreference.value = null;
    });

    it('has a single line for an unknown zone', () => {
      viewingTimeZone.value = 'Asia/Tbilisi';
      hourCyclePreference.value = 'h23';
      expect(getTransactionTimeTooltip({ time: INSTANT, timeZone: null, utcOffsetMinutes: null })).toEqual({
        primary: '21 Oct 2026, 16:00 GMT+4',
        recordedLine: null,
      });
    });

    it('adds the recorded zone line only when it differs', () => {
      viewingTimeZone.value = 'Asia/Tbilisi';
      hourCyclePreference.value = 'h23';
      expect(
        getTransactionTimeTooltip({ time: INSTANT, timeZone: 'America/New_York', utcOffsetMinutes: -240 }).recordedLine,
      ).toBe('America/New_York: 08:00 GMT-4');
      expect(
        getTransactionTimeTooltip({ time: INSTANT, timeZone: 'Asia/Tbilisi', utcOffsetMinutes: 240 }).recordedLine,
      ).toBeNull();
    });
  });

  describe('a row with no recorded zone', () => {
    it('shows its date as plain date-fns formatting in the device zone does', () => {
      viewingTimeZone.value = deviceTimeZone();
      expect(formatInViewingZone({ date: INSTANT, pattern: 'd MMM y' })).toBe(format(INSTANT, 'd MMM y'));
    });
  });

  describe('viewing-zone days', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reads "now" in the viewing zone, a day ahead of UTC for a Tbilisi viewer', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-20T21:30:00.000Z'));
      viewingTimeZone.value = 'Asia/Tbilisi';

      const now = viewingNow();

      expect(format(now, 'yyyy-MM-dd HH:mm')).toBe('2026-10-21 01:30');
    });

    it('bounds a calendar day by the viewing zone, not the device zone', () => {
      viewingTimeZone.value = 'Asia/Tbilisi';
      const day = new Date(2026, 9, 21);

      expect(viewingDayBoundIso({ date: day, edge: 'start' })).toBe('2026-10-20T20:00:00.000Z');
      expect(viewingDayBoundIso({ date: day, edge: 'end' })).toBe('2026-10-21T19:59:59.999Z');
    });

    it('covers the 25-hour day when clocks go back', () => {
      viewingTimeZone.value = 'America/New_York';
      const day = new Date(2026, 10, 1);

      expect(viewingDayBoundIso({ date: day, edge: 'start' })).toBe('2026-11-01T04:00:00.000Z');
      expect(viewingDayBoundIso({ date: day, edge: 'end' })).toBe('2026-11-02T04:59:59.999Z');
    });
  });
});
