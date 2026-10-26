import {
  AMOUNT_GATE_MATCH_MAX_LENGTH,
  AMOUNT_GATE_PATTERNS,
  AMOUNT_GATE_SAMPLES,
  GATE_STRICTNESS_LEVELS,
  type GateStrictness,
  buildAmountGateRegex,
  matchAmountGate,
} from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

const matchesAt = ({ minLevel, strictness }: { minLevel: GateStrictness | null; strictness: GateStrictness }) =>
  minLevel !== null && GATE_STRICTNESS_LEVELS.indexOf(strictness) >= GATE_STRICTNESS_LEVELS.indexOf(minLevel);

describe('amount gate', () => {
  describe.each(GATE_STRICTNESS_LEVELS)('level %s', (strictness) => {
    it.each(AMOUNT_GATE_SAMPLES.map((sample) => [sample.text, sample] as const))('%j', (_text, sample) => {
      const expected = matchesAt({ minLevel: sample.minLevel, strictness });

      expect(matchAmountGate({ text: sample.text, strictness }) !== null).toBe(expected);
    });
  });

  it('is monotonic: a looser level matches everything a stricter one does', () => {
    for (const sample of AMOUNT_GATE_SAMPLES) {
      const [strict, standard, loose] = GATE_STRICTNESS_LEVELS.map(
        (strictness) => matchAmountGate({ text: sample.text, strictness }) !== null,
      );

      if (strict) expect(standard).toBe(true);
      if (standard) expect(loose).toBe(true);
    }
  });

  it.each([
    ['plain codes', 'Your code is 123456, do not share it'],
    ['an uppercase word before a number', 'PIN 1234 SMS 5678 ATM 100'],
    ['a phone number', 'Call +995 555 12 34 56'],
    ['a date', '20.10.2026'],
    ['a time', 'at 14:30 sharp'],
    ['chat text without a currency', 'See you at 7, bring 3 friends'],
  ])('does not match %s at any level', (_name, text) => {
    for (const strictness of GATE_STRICTNESS_LEVELS) {
      expect(matchAmountGate({ text, strictness })).toBeNull();
    }
  });

  it('treats a code inside a longer word as no currency', () => {
    expect(matchAmountGate({ text: 'EURO2024 tickets 50', strictness: 'strict' })).toBeNull();
    expect(matchAmountGate({ text: 'XUSD 50', strictness: 'strict' })).toBeNull();
  });

  it('returns the matched amount text only', () => {
    expect(matchAmountGate({ text: 'Example Bank\nWolt\nGEL 43.60', strictness: 'strict' })).toBe('GEL 43.60');
    expect(matchAmountGate({ text: 'Purchase 43.60 GEL at Wolt', strictness: 'strict' })).toBe('43.60 GEL');
  });

  it('cuts a long match to the display limit', () => {
    const text = `USD ${'1 234 '.repeat(40)}000`;
    const matched = matchAmountGate({ text, strictness: 'strict' });

    expect(matched).not.toBeNull();
    expect(matched!.length).toBeLessThanOrEqual(AMOUNT_GATE_MATCH_MAX_LENGTH);
  });

  it('accepts a small fraction of digits next to a symbol', () => {
    expect(matchAmountGate({ text: '€0,99', strictness: 'strict' })).toBe('€0,99');
  });

  it('uses only syntax that ICU reads like JavaScript', () => {
    for (const strictness of GATE_STRICTNESS_LEVELS) {
      const pattern = AMOUNT_GATE_PATTERNS[strictness];

      // Named groups, backreferences, the `v` flag's set syntax and inline global flags differ between engines.
      expect(pattern).not.toMatch(/\(\?<[A-Za-z]/);
      expect(pattern).not.toMatch(/\\[1-9]/);
      expect(pattern).not.toMatch(/\(\?[a-z]+\)/);
      expect(() => buildAmountGateRegex({ strictness })).not.toThrow();
    }
  });
});
