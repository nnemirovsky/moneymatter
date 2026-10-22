import { describe, expect, it } from '@jest/globals';

import { normalizeTimeArgs } from './normalize-time-args';

const tbilisi = { viewingZone: 'Asia/Tbilisi', storedZone: 'Asia/Tbilisi' };
const noSetting = { viewingZone: 'UTC', storedZone: null };

describe('normalizeTimeArgs', () => {
  it('turns a create wall clock into an instant plus the zone', () => {
    expect(
      normalizeTimeArgs({ toolName: 'create_transaction', args: { time: '2026-10-21T16:00', amount: 5 }, ...tbilisi }),
    ).toEqual({ time: '2026-10-21T12:00:00.000Z', timeZone: 'Asia/Tbilisi', amount: 5 });
  });

  it('keeps an explicit zone and reads the wall clock in it', () => {
    expect(
      normalizeTimeArgs({
        toolName: 'create_transaction',
        args: { time: '2026-10-21T16:00', timeZone: 'America/New_York' },
        ...tbilisi,
      }),
    ).toEqual({ time: '2026-10-21T20:00:00.000Z', timeZone: 'America/New_York' });
  });

  it('stores the offset ISO, with no zone, for an offset-only create', () => {
    const normalized = normalizeTimeArgs({
      toolName: 'create_transaction',
      args: { time: '2026-10-21T16:00:00+02:00' },
      ...tbilisi,
    });
    expect(normalized).toEqual({ time: '2026-10-21T16:00:00+02:00' });
    expect('timeZone' in normalized).toBe(false);
  });

  it('adds no timeZone key for a user with no setting', () => {
    const normalized = normalizeTimeArgs({
      toolName: 'create_transaction',
      args: { time: '2026-10-21T16:00' },
      ...noSetting,
    });
    expect(normalized).toEqual({ time: '2026-10-21T16:00:00.000Z' });
    expect('timeZone' in normalized).toBe(false);
  });

  it('leaves a create call without a time alone', () => {
    const args = { amount: 5 };
    expect(normalizeTimeArgs({ toolName: 'create_transaction', args, ...tbilisi })).toEqual(args);
  });

  it('writes an instant for an update and adds no zone the model did not pass', () => {
    const normalized = normalizeTimeArgs({
      toolName: 'update_transaction',
      args: { id: 'x', time: '2026-10-21T16:00' },
      ...tbilisi,
    });
    expect(normalized).toEqual({ id: 'x', time: '2026-10-21T12:00:00.000Z' });
    expect('timeZone' in normalized).toBe(false);
  });

  it('keeps a zone the model passed to an update', () => {
    expect(
      normalizeTimeArgs({
        toolName: 'confirm_planned_transaction',
        args: { time: '2026-10-21T16:00', timeZone: 'Asia/Tokyo' },
        ...tbilisi,
      }),
    ).toEqual({ time: '2026-10-21T07:00:00.000Z', timeZone: 'Asia/Tokyo' });
  });

  it('refuses an offset that contradicts the zone', () => {
    expect(() =>
      normalizeTimeArgs({
        toolName: 'create_transaction',
        args: { time: '2026-10-21T16:00:00+02:00', timeZone: 'Asia/Tbilisi' },
        ...tbilisi,
      }),
    ).toThrow(/wall time/);
  });

  it('rewrites only the time keys of the transaction tools', () => {
    const args = { time: '2026-10-21T16:00', note: '2026-10-21T16:00' };
    expect(normalizeTimeArgs({ toolName: 'update_account', args, ...tbilisi })).toEqual(args);
    expect(normalizeTimeArgs({ toolName: 'create_transaction', args, ...tbilisi }).note).toBe('2026-10-21T16:00');
  });
});
