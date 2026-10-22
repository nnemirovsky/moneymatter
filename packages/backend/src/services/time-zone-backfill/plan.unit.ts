import { describe, expect, it } from '@jest/globals';

import { DEFAULT_GROUPS } from './groups';
import { assertGroupsPartitionTimeline, changesDayIn, findGroup, planMove, shiftToZoneWallClock } from './plan';

const group = (key: string) => DEFAULT_GROUPS.find((candidate) => candidate.key === key)!;

describe('time zone backfill plan', () => {
  describe('shiftToZoneWallClock', () => {
    it.each([
      ['Asia/Bangkok', '2026-01-10T06:20:00.000Z', '2026-01-10T02:20:00.000Z'],
      ['Asia/Ho_Chi_Minh', '2026-02-10T06:20:00.000Z', '2026-02-10T02:20:00.000Z'],
      ['Asia/Makassar', '2026-05-10T06:20:00.000Z', '2026-05-10T01:20:00.000Z'],
      ['Asia/Kuala_Lumpur', '2026-06-25T06:20:00.000Z', '2026-06-25T01:20:00.000Z'],
      ['Asia/Tbilisi', '2026-10-10T06:20:00.000Z', '2026-10-10T05:20:00.000Z'],
      ['Europe/Moscow', '2026-08-10T06:20:00.000Z', '2026-08-10T06:20:00.000Z'],
      ['Europe/Istanbul', '2026-09-05T06:20:00.000Z', '2026-09-05T06:20:00.000Z'],
    ])('reads the sheet wall clock in %s', (zone, before, after) => {
      expect(shiftToZoneWallClock({ instant: new Date(before), zone })).toEqual(new Date(after));
    });

    it('moves a row across midnight when the wall clock is early in the morning', () => {
      // 01:30 sheet wall clock is 22:30Z the day before; in Bangkok it is 01:30 local, 18:30Z the day before.
      const shifted = shiftToZoneWallClock({ instant: new Date('2026-01-10T22:30:00.000Z'), zone: 'Asia/Bangkok' });

      expect(shifted).toEqual(new Date('2026-01-10T18:30:00.000Z'));
    });

    it('keeps the wall clock read in the zone equal to the wall clock the sheet showed', () => {
      const instant = new Date('2026-03-15T09:41:07.000Z');
      const shifted = shiftToZoneWallClock({ instant, zone: 'Asia/Makassar' });
      const readInZone = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Makassar',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(shifted);
      const sheetShowed = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Istanbul',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(instant);

      expect(readInZone).toBe(sheetShowed);
    });
  });

  describe('planMove', () => {
    it('derives the offset at the corrected instant', () => {
      const move = planMove({ time: new Date('2026-01-10T06:20:00.000Z'), group: group('thailand') });

      expect(move).toEqual({
        newTime: new Date('2026-01-10T02:20:00.000Z'),
        zone: 'Asia/Bangkok',
        utcOffsetMinutes: 420,
      });
    });
  });

  describe('findGroup', () => {
    it.each([
      ['2025-10-29T08:43:00.000Z', 'thailand'],
      ['2026-02-01T07:59:59.999Z', 'thailand'],
      ['2026-02-01T08:00:00.000Z', 'vietnam'],
      ['2026-03-01T08:00:00.000Z', 'bali'],
      ['2026-04-24T23:59:59.999Z', 'bali'],
      ['2026-04-25T00:00:00.000Z', 'malaysia-april'],
      ['2026-04-26T18:00:00.000Z', 'bali'],
      ['2026-06-24T19:30:00.000Z', 'malaysia-june'],
      ['2026-06-27T16:00:00.000Z', 'bali'],
      ['2026-08-03T12:00:00.000Z', 'russia'],
      ['2026-08-30T05:00:00.000Z', 'turkey'],
      ['2026-09-12T11:00:00.000Z', 'georgia'],
      ['2026-11-10T12:00:00.000Z', 'georgia'],
    ])('places %s in %s', (instant, key) => {
      expect(findGroup({ instant: new Date(instant), groups: DEFAULT_GROUPS })?.key).toBe(key);
    });
  });

  describe('assertGroupsPartitionTimeline', () => {
    it('accepts the approved groups', () => {
      expect(() => assertGroupsPartitionTimeline({ groups: DEFAULT_GROUPS })).not.toThrow();
    });

    it('refuses a gap', () => {
      const groups = DEFAULT_GROUPS.filter((candidate) => candidate.key !== 'russia');

      expect(() => assertGroupsPartitionTimeline({ groups })).toThrow('Gap');
    });

    it('refuses an overlap', () => {
      const overlapping = {
        ...group('turkey'),
        key: 'again',
        windows: [{ from: new Date('2026-08-31T00:00:00Z'), to: null }],
      };

      expect(() => assertGroupsPartitionTimeline({ groups: [...DEFAULT_GROUPS, overlapping] })).toThrow();
    });
  });

  describe('changesDayIn', () => {
    it('compares the calendar day in the given zone', () => {
      const before = new Date('2026-01-10T22:30:00.000Z');
      const after = new Date('2026-01-10T18:30:00.000Z');

      expect(changesDayIn({ before, after, zone: 'Asia/Tbilisi' })).toBe(true);
      expect(changesDayIn({ before, after, zone: 'UTC' })).toBe(false);
      expect(
        changesDayIn({
          before: new Date('2026-01-11T00:30:00.000Z'),
          after: new Date('2026-01-10T20:30:00.000Z'),
          zone: 'UTC',
        }),
      ).toBe(true);
    });
  });
});
