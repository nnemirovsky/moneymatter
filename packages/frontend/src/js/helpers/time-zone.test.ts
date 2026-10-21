import { afterEach, describe, expect, it } from 'vitest';

import {
  formatDateTime,
  formatInViewingZone,
  formatTime,
  formatZoneLabel,
  hourCyclePreference,
  resolveViewingTimeZone,
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
});
