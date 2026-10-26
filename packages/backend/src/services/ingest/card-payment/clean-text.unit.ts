import { describe, expect, it } from '@jest/globals';

import { cleanText } from './clean-text';

describe('cleanText', () => {
  it.each([
    ['trims', '  Cafe  ', 'Cafe'],
    ['collapses inner whitespace and line breaks', 'Cafe \n\t Heart', 'Cafe Heart'],
    ['collapses non-breaking and narrow no-break spaces', 'Cafe\u00A0Heart\u202FLisbon', 'Cafe Heart Lisbon'],
    ['drops zero-width and bidirectional marks', 'Ca​fe‎', 'Cafe'],
    ['drops NUL and other control characters', 'Ca\u0000fe\u0007', 'Cafe'],
    ['keeps letters, digits and punctuation', "McDonald's #12 — Тбілісі", "McDonald's #12 — Тбілісі"],
    ['returns an empty string for whitespace only', '   \n', ''],
  ])('%s', (_name, value, expected) => {
    expect(cleanText({ value })).toBe(expected);
  });
});
