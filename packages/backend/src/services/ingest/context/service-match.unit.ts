import { describe, expect, it } from '@jest/globals';

import { matchesService } from './service-match';

const wolt = { hints: ['wolt'], excludes: [] as string[] };
const amazon = { hints: ['amazon'], excludes: ['prime', 'kindle', 'audible', 'music'] };

describe('matchesService', () => {
  it('matches the payee and the merchant as a bank prints it', () => {
    expect(matchesService({ texts: ['Wolt'], ...wolt })).toBe(true);
    expect(matchesService({ texts: [null, 'WOLT.COM TBILISI'], ...wolt })).toBe(true);
  });

  it('does not match another business or part of a word', () => {
    expect(matchesService({ texts: ['Carrefour'], ...wolt })).toBe(false);
    expect(matchesService({ texts: ['Woltmann GmbH'], ...wolt })).toBe(false);
  });

  it("keeps the same brand's other products out", () => {
    expect(matchesService({ texts: ['AMZN Amazon Prime'], ...amazon })).toBe(false);
    expect(matchesService({ texts: ['Amazon EU'], ...amazon })).toBe(true);
  });

  it('matches a hint with punctuation', () => {
    expect(matchesService({ texts: ['BOLT.EU/F/Tbilisi'], hints: ['bolt food', 'bolt.eu/f'], excludes: [] })).toBe(
      true,
    );
    expect(matchesService({ texts: ['BOLT.EU/R/Tbilisi'], hints: ['bolt food', 'bolt.eu/f'], excludes: [] })).toBe(
      false,
    );
  });
});
