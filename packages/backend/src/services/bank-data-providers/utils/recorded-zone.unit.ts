import { describe, expect, it } from '@jest/globals';

import { BANK_SYNC_RECENT_ZONE_WINDOW_DAYS, bankSyncRecordedZone } from './recorded-zone';

const SYNCED_AT = new Date('2026-10-21T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const at = ({ offsetMs }: { offsetMs: number }) => new Date(SYNCED_AT.getTime() + offsetMs);

describe('bankSyncRecordedZone', () => {
  it('uses a three-day window', () => {
    expect(BANK_SYNC_RECENT_ZONE_WINDOW_DAYS).toBe(3);
  });

  it('stamps the user zone and the offset at the row time on a recent row', () => {
    expect(
      bankSyncRecordedZone({ time: at({ offsetMs: -DAY_MS }), syncedAt: SYNCED_AT, userZone: 'Asia/Tbilisi' }),
    ).toEqual({ timeZone: 'Asia/Tbilisi', utcOffsetMinutes: 240 });
  });

  it('stamps a row exactly three days old', () => {
    expect(
      bankSyncRecordedZone({ time: at({ offsetMs: -3 * DAY_MS }), syncedAt: SYNCED_AT, userZone: 'Asia/Tbilisi' }),
    ).toEqual({ timeZone: 'Asia/Tbilisi', utcOffsetMinutes: 240 });
  });

  it('leaves a row three days and a second old unstamped', () => {
    expect(
      bankSyncRecordedZone({
        time: at({ offsetMs: -3 * DAY_MS - 1000 }),
        syncedAt: SYNCED_AT,
        userZone: 'Asia/Tbilisi',
      }),
    ).toEqual({ timeZone: null, utcOffsetMinutes: null });
  });

  it('stamps a future-dated row inside the window', () => {
    expect(
      bankSyncRecordedZone({ time: at({ offsetMs: 2 * DAY_MS }), syncedAt: SYNCED_AT, userZone: 'Asia/Tbilisi' }),
    ).toEqual({ timeZone: 'Asia/Tbilisi', utcOffsetMinutes: 240 });
  });

  it('records nothing for a user with no stored zone, even on a recent row', () => {
    expect(bankSyncRecordedZone({ time: at({ offsetMs: -DAY_MS }), syncedAt: SYNCED_AT, userZone: null })).toEqual({
      timeZone: null,
      utcOffsetMinutes: null,
    });
  });

  it('takes the offset at the row time across a DST switch', () => {
    const syncedAt = new Date('2026-11-02T12:00:00.000Z');

    expect(
      bankSyncRecordedZone({ time: new Date('2026-10-31T12:00:00.000Z'), syncedAt, userZone: 'America/New_York' }),
    ).toEqual({ timeZone: 'America/New_York', utcOffsetMinutes: -240 });
    expect(
      bankSyncRecordedZone({ time: new Date('2026-11-02T11:00:00.000Z'), syncedAt, userZone: 'America/New_York' }),
    ).toEqual({ timeZone: 'America/New_York', utcOffsetMinutes: -300 });
  });
});
