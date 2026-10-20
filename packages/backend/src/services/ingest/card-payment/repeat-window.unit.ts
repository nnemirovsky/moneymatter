import { describe, expect, it } from '@jest/globals';

import { isRepeatOf } from './repeat-window';

const request = ({ time, timeSource, createdAt }: { time?: string; timeSource?: string; createdAt: string }) => ({
  payload: { ...(time && { time }), ...(timeSource && { timeSource }) },
  createdAt: new Date(createdAt),
});

const RECEIVED = '2026-10-20T14:38:00Z';

describe('isRepeatOf', () => {
  describe('run times (the shipped shortcut)', () => {
    const base = request({ time: '2026-10-20T18:38:00+04:00', createdAt: RECEIVED });

    it('folds a double fire: run times 8 seconds apart', () => {
      expect(
        isRepeatOf({ row: request({ time: '2026-10-20T18:38:08+04:00', createdAt: RECEIVED }), original: base }),
      ).toBe(true);
    });

    it('keeps two payments apart: run times 25 and 60 seconds apart', () => {
      expect(
        isRepeatOf({ row: request({ time: '2026-10-20T18:38:25+04:00', createdAt: RECEIVED }), original: base }),
      ).toBe(false);
      expect(
        isRepeatOf({ row: request({ time: '2026-10-20T18:39:00+04:00', createdAt: RECEIVED }), original: base }),
      ).toBe(false);
    });

    it('includes the 20 second edge', () => {
      expect(
        isRepeatOf({ row: request({ time: '2026-10-20T18:38:20+04:00', createdAt: RECEIVED }), original: base }),
      ).toBe(true);
    });

    it('measures the time the request sent, not when it was received', () => {
      const late = request({ time: '2026-10-20T18:38:05+04:00', createdAt: '2026-10-20T14:45:00Z' });

      expect(isRepeatOf({ row: late, original: base })).toBe(true);
    });
  });

  describe('transaction times', () => {
    const base = request({ time: '2026-10-20T18:38:00+04:00', timeSource: 'transaction', createdAt: RECEIVED });

    it('folds identical times and splits times 10 seconds apart', () => {
      const same = request({ time: '2026-10-20T18:38:00+04:00', timeSource: 'transaction', createdAt: RECEIVED });
      const apart = request({ time: '2026-10-20T18:38:10+04:00', timeSource: 'transaction', createdAt: RECEIVED });

      expect(isRepeatOf({ row: same, original: base })).toBe(true);
      expect(isRepeatOf({ row: apart, original: base })).toBe(false);
    });

    it('uses the run window when only one side says transaction', () => {
      const run = request({ time: '2026-10-20T18:38:10+04:00', createdAt: RECEIVED });

      expect(isRepeatOf({ row: run, original: base })).toBe(true);
    });
  });

  describe('no time', () => {
    it('falls back to the receipt window of 120 seconds', () => {
      const original = request({ createdAt: RECEIVED });

      expect(isRepeatOf({ row: request({ createdAt: '2026-10-20T14:39:59Z' }), original })).toBe(true);
      expect(isRepeatOf({ row: request({ createdAt: '2026-10-20T14:40:01Z' }), original })).toBe(false);
    });

    it('uses it when only one side sent a time', () => {
      const original = request({ time: '2026-10-20T18:38:00+04:00', createdAt: RECEIVED });

      expect(isRepeatOf({ row: request({ createdAt: '2026-10-20T14:39:30Z' }), original })).toBe(true);
    });

    it('treats a malformed time as none', () => {
      const original = request({ createdAt: RECEIVED });
      const bad = request({ time: 'yesterday', createdAt: '2026-10-20T14:38:30Z' });

      expect(isRepeatOf({ row: bad, original })).toBe(true);
    });
  });
});
