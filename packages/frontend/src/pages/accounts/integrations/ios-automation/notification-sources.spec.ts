import { describe, expect, it } from 'vitest';

import { getSourceName } from './notification-sources';

describe('getSourceName', () => {
  it('prefers the app name', () => {
    expect(getSourceName({ source: { appName: 'TBC Bank', bundleId: 'ge.tbconline' }, fallback: '?' })).toBe(
      'TBC Bank',
    );
  });

  it('falls back to the bundle id', () => {
    expect(getSourceName({ source: { appName: null, bundleId: 'ge.tbconline' }, fallback: '?' })).toBe('ge.tbconline');
  });

  it('uses the fallback when the source names neither', () => {
    expect(getSourceName({ source: { appName: '', bundleId: null }, fallback: 'Unknown app' })).toBe('Unknown app');
  });
});
