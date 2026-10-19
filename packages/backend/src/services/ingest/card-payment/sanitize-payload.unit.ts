import { describe, expect, it } from '@jest/globals';

import { sanitizeForJsonb } from './sanitize-payload';

describe('sanitizeForJsonb', () => {
  it('strips NUL from string values and keys, at any depth', () => {
    const result = sanitizeForJsonb({ value: { 'a\u0000b': ['x\u0000y', { c: 'd\u0000' }] } });

    expect(result).toEqual({ ab: ['xy', { c: 'd' }] });
  });

  it('replaces an unpaired surrogate and keeps a valid pair', () => {
    expect(sanitizeForJsonb({ value: 'a\ud800b' })).toBe('a�b');
    expect(sanitizeForJsonb({ value: 'cafe \u{1F600}' })).toBe('cafe \u{1F600}');
  });

  it('leaves numbers, booleans and null alone', () => {
    expect(sanitizeForJsonb({ value: { n: 1.5, b: true, z: null } })).toEqual({ n: 1.5, b: true, z: null });
  });
});
