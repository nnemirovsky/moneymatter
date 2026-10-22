import { describe, expect, it } from 'vitest';

import { buildTimeZoneOptions, filterTimeZoneOptions, listSupportedTimeZones } from './time-zone-options';

const NOW = new Date('2026-10-21T12:00:00.000Z');

describe('time-zone-options', () => {
  it('labels each zone with its offset at the given instant', () => {
    const options = buildTimeZoneOptions({ zones: ['Asia/Tbilisi', 'America/New_York'], now: NOW });
    expect(options.map((o) => o.label)).toStrictEqual(['GMT-4 · America/New_York', 'GMT+4 · Asia/Tbilisi']);
  });

  it('orders west to east and then by name', () => {
    const options = buildTimeZoneOptions({
      zones: ['Asia/Tbilisi', 'Asia/Dubai', 'Pacific/Pago_Pago', 'UTC'],
      now: NOW,
    });
    expect(options.map((o) => o.value)).toStrictEqual(['Pacific/Pago_Pago', 'UTC', 'Asia/Dubai', 'Asia/Tbilisi']);
  });

  it('lists UTC and Tbilisi among the supported zones', () => {
    const zones = listSupportedTimeZones();
    expect(zones).toContain('UTC');
    expect(zones).toContain('Asia/Tbilisi');
  });

  it('filters by zone name or offset, ignoring case and spaces', () => {
    const options = buildTimeZoneOptions({ zones: ['Asia/Tbilisi', 'America/New_York', 'Europe/Kyiv'], now: NOW });
    expect(filterTimeZoneOptions({ options, searchTerm: 'new york' }).map((o) => o.value)).toStrictEqual([
      'America/New_York',
    ]);
    expect(filterTimeZoneOptions({ options, searchTerm: 'GMT+4' }).map((o) => o.value)).toStrictEqual(['Asia/Tbilisi']);
    expect(filterTimeZoneOptions({ options, searchTerm: '  ' })).toHaveLength(3);
  });
});
