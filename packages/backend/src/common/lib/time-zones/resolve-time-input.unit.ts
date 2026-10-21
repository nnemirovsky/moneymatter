import { describe, expect, it } from '@jest/globals';

import { isTimeInput, resolveRangeBound, resolveTimeInput } from './resolve-time-input';

const tbilisiUser = { viewingZone: 'Asia/Tbilisi', storedZone: 'Asia/Tbilisi' };
const noSettingUser = { viewingZone: 'UTC', storedZone: null };

interface Call {
  value?: string;
  timeZone?: string | null;
  viewingZone?: string;
  storedZone?: string | null;
}

describe('resolveTimeInput (create)', () => {
  const create = (params: Call) => resolveTimeInput({ mode: 'create', ...tbilisiUser, ...params });

  it('reads a wall clock in the user zone', () => {
    expect(create({ value: '2026-10-21T16:00' })).toEqual({
      time: new Date('2026-10-21T12:00:00.000Z'),
      timeZone: 'Asia/Tbilisi',
      utcOffsetMinutes: 240,
    });
  });

  it('reads a wall clock in an explicit zone and records it', () => {
    expect(create({ value: '2026-10-21T16:00', timeZone: 'America/New_York' })).toEqual({
      time: new Date('2026-10-21T20:00:00.000Z'),
      timeZone: 'America/New_York',
      utcOffsetMinutes: -240,
    });
  });

  it('keeps an offset that matches the stored zone as that zone', () => {
    expect(create({ value: '2026-10-21T16:00:00+04:00' })).toEqual({
      time: new Date('2026-10-21T12:00:00.000Z'),
      timeZone: 'Asia/Tbilisi',
      utcOffsetMinutes: 240,
    });
  });

  it('records only the offset when it matches no known zone', () => {
    expect(create({ value: '2026-10-21T16:00:00+02:00' })).toEqual({
      time: new Date('2026-10-21T14:00:00.000Z'),
      timeZone: null,
      utcOffsetMinutes: 120,
    });
  });

  it('refuses a non-zero offset that contradicts the explicit zone', () => {
    expect(() => create({ value: '2026-10-21T16:00:00+02:00', timeZone: 'Asia/Tbilisi' })).toThrow(/local wall time/);
  });

  it('reads a date as local noon', () => {
    expect(create({ value: '2026-10-21' }).time).toEqual(new Date('2026-10-21T08:00:00.000Z'));
  });

  it('refuses garbage and impossible dates', () => {
    expect(() => create({ value: 'yesterday' })).toThrow();
    expect(() => create({ value: '2026-02-30T10:00' })).toThrow();
  });

  it('accepts a Z instant with an explicit zone', () => {
    expect(create({ value: '2026-10-21T12:00:00Z', timeZone: 'Asia/Tbilisi' })).toEqual({
      time: new Date('2026-10-21T12:00:00.000Z'),
      timeZone: 'Asia/Tbilisi',
      utcOffsetMinutes: 240,
    });
  });

  it('records the stored zone for a Z instant, never offset 0', () => {
    expect(create({ value: '2026-10-21T12:00:00Z' })).toMatchObject({
      timeZone: 'Asia/Tbilisi',
      utcOffsetMinutes: 240,
    });
    expect(create({ value: '2026-10-21T12:00:00Z', ...noSettingUser })).toEqual({
      time: new Date('2026-10-21T12:00:00.000Z'),
      timeZone: null,
      utcOffsetMinutes: null,
    });
  });

  it('records nothing for a user with no setting and a wall clock read as UTC', () => {
    expect(create({ value: '2026-10-21T16:00', ...noSettingUser })).toEqual({
      time: new Date('2026-10-21T16:00:00.000Z'),
      timeZone: null,
      utcOffsetMinutes: null,
    });
  });

  it('records the stored zone when no time is given', () => {
    expect(create({})).toEqual({ time: undefined, timeZone: 'Asia/Tbilisi', utcOffsetMinutes: undefined });
    expect(create({ timeZone: 'Asia/Tokyo' }).timeZone).toBe('Asia/Tokyo');
  });
});

describe('resolveTimeInput (update)', () => {
  const update = (params: Call) => resolveTimeInput({ mode: 'update', ...tbilisiUser, ...params });

  it('reads a wall clock in the viewing zone and leaves the stored zone alone', () => {
    expect(update({ value: '2026-10-21T16:00' })).toEqual({ time: new Date('2026-10-21T12:00:00.000Z') });
  });

  it('records the zone only when one is passed', () => {
    expect(update({ value: '2026-10-21T16:00', timeZone: 'America/New_York' })).toEqual({
      time: new Date('2026-10-21T20:00:00.000Z'),
      timeZone: 'America/New_York',
    });
  });

  it('reads a wall clock in the viewing zone when the zone is cleared', () => {
    expect(update({ value: '2026-10-21T16:00', timeZone: null })).toEqual({
      time: new Date('2026-10-21T12:00:00.000Z'),
      timeZone: null,
    });
  });

  it('changes only the zone when no time is given', () => {
    expect(update({ timeZone: 'Asia/Tokyo' })).toEqual({ time: undefined, timeZone: 'Asia/Tokyo' });
  });
});

describe('resolveRangeBound', () => {
  it('cuts a date at the zone day edges', () => {
    expect(resolveRangeBound({ value: '2026-10-21', edge: 'start', zone: 'Asia/Tbilisi' })).toEqual(
      new Date('2026-10-20T20:00:00.000Z'),
    );
    expect(resolveRangeBound({ value: '2026-10-21', edge: 'end', zone: 'Asia/Tbilisi' })).toEqual(
      new Date('2026-10-21T19:59:59.999Z'),
    );
  });

  it('reads a wall clock in the zone and passes an instant through', () => {
    expect(resolveRangeBound({ value: '2026-10-21T16:00', edge: 'start', zone: 'Asia/Tbilisi' })).toEqual(
      new Date('2026-10-21T12:00:00.000Z'),
    );
    expect(resolveRangeBound({ value: '2026-10-21T16:00:00Z', edge: 'end', zone: 'Asia/Tbilisi' })).toEqual(
      new Date('2026-10-21T16:00:00.000Z'),
    );
    expect(resolveRangeBound({ value: '2026-10-21T16:00:00+02:00', edge: 'end', zone: 'Asia/Tbilisi' })).toEqual(
      new Date('2026-10-21T14:00:00.000Z'),
    );
  });

  it('refuses garbage', () => {
    expect(() => resolveRangeBound({ value: 'soon', edge: 'start', zone: 'UTC' })).toThrow();
  });
});

describe('isTimeInput', () => {
  it('accepts the three shapes and refuses the rest', () => {
    expect(isTimeInput({ value: '2026-10-21' })).toBe(true);
    expect(isTimeInput({ value: '2026-10-21T16:00' })).toBe(true);
    expect(isTimeInput({ value: '2026-10-21T16:00:00.500+0400' })).toBe(true);
    expect(isTimeInput({ value: '21 Oct 2026' })).toBe(false);
  });
});
