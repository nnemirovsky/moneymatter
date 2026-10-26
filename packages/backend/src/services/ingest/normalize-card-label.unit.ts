import { normalizeCardLabel } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

describe('normalizeCardLabel', () => {
  it.each([
    ['trims', '  Example Visa  ', 'example visa'],
    ['collapses inner whitespace', 'Example   \t Visa', 'example visa'],
    ['collapses a non-breaking space', 'Example Visa', 'example visa'],
    ['case-folds', 'ExAmple ViSa', 'example visa'],
    ['case-folds non-Latin letters', 'ТБС Карта', 'тбс карта'],
    ['strips a trailing masked number', 'Example Visa •••• 1234', 'example visa'],
    ['strips a masked number without spaces', 'Example Visa ••••1234', 'example visa'],
    ['strips a masked number written with asterisks', 'Example Visa **** 1234', 'example visa'],
    ['strips a parenthesized masked number', 'Example Visa (•••• 1234)', 'example visa'],
    ['keeps digits that are not behind a mask', 'Card 1234', 'card 1234'],
    ['keeps a single asterisk before digits', 'Card *1234', 'card *1234'],
    ['keeps a masked number that is not at the end', '•••• 1234 Visa', '•••• 1234 visa'],
    ['keeps a label that is only a masked number', '•••• 1234', '•••• 1234'],
  ])('%s', (_name, label, expected) => {
    expect(normalizeCardLabel({ label })).toBe(expected);
  });

  it('composes to NFC so a decomposed and a precomposed spelling match', () => {
    const decomposed = 'Café Card';
    const precomposed = 'Café Card';

    expect(normalizeCardLabel({ label: decomposed })).toBe(normalizeCardLabel({ label: precomposed }));
    expect(normalizeCardLabel({ label: decomposed })).toBe('café card');
  });

  it('is idempotent', () => {
    const once = normalizeCardLabel({ label: '  Example   Visa •••• 1234 ' });

    expect(normalizeCardLabel({ label: once })).toBe(once);
  });

  it('returns an empty string for a blank label', () => {
    expect(normalizeCardLabel({ label: '   ' })).toBe('');
  });
});
