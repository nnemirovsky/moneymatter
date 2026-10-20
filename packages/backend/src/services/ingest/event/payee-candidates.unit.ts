import type { RecordId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import { normalizePayeeName } from '../../payees/normalize-name';
import {
  PAYEE_CANDIDATES_LIMIT,
  extractMerchantTokens,
  findFuzzyMatches,
  findTokenMatches,
  mergePayeeCandidates,
} from './payee-candidates';

const payee = ({ id, name, aliases = [] }: { id: string; name: string; aliases?: string[] }) => ({
  id: id as RecordId,
  name,
  normalizedName: normalizePayeeName({ raw: name }),
  aliases: aliases.map((rawName) => ({ rawName, normalizedName: normalizePayeeName({ raw: rawName }) })),
});

const wolt = payee({ id: 'wolt', name: 'Wolt', aliases: ['WOLT.COM TBILISI'] });
const coffeeLab = payee({ id: 'coffee-lab', name: 'Coffee Lab', aliases: ['SP *COFFEE LAB'] });
const spar = payee({ id: 'spar', name: 'Spar', aliases: ['SPAR BATUMI'] });
const cardShop = payee({ id: 'card-shop', name: 'Card Shop' });

describe('extractMerchantTokens', () => {
  it('keeps the words that can name a merchant, in order', () => {
    expect(extractMerchantTokens({ text: 'Purchase 7.50 GEL, SP *LOKAL ROASTERS, card *4321' })).toEqual([
      'lokal',
      'roasters',
    ]);
  });

  it('skips a word that names a kind of business, not a business', () => {
    expect(extractMerchantTokens({ text: 'SP *COFFEE LAB' })).toEqual(['lab']);
  });

  it('skips numbers, short words, codes with digits and duplicates', () => {
    expect(extractMerchantTokens({ text: '12345 of at T4567 wolt WOLT Wolt' })).toEqual(['wolt']);
  });

  it('skips filler words in every language', () => {
    expect(
      extractMerchantTokens({
        text: 'Purchase payment balance card Покупка Баланс Карта Залишок შეძენა ბალანსი ბარათით Magnit',
      }),
    ).toEqual(['magnit']);
  });

  it('skips processor prefixes, domain endings and generic place words', () => {
    expect(extractMerchantTokens({ text: 'PAYPAL *SPOTIFY www.netflix.com TBILISI cafe' })).toEqual([
      'spotify',
      'netflix',
    ]);
  });

  it('skips the words of the bank itself', () => {
    expect(extractMerchantTokens({ text: 'TBC Bank Wolt', ignoredWords: ['TBC Bank'] })).toEqual(['wolt']);
  });

  it('caps the number of tokens', () => {
    const text = Array.from({ length: 20 }, (_, index) => `shop${String.fromCharCode(97 + index)}`).join(' ');

    expect(extractMerchantTokens({ text })).toHaveLength(8);
  });
});

describe('findTokenMatches', () => {
  const payees = [wolt, coffeeLab, spar, cardShop];

  it('finds payees whose name or alias contains a token', () => {
    expect(findTokenMatches({ payees, tokens: ['wolt'] }).map((entry) => entry.id)).toEqual(['wolt']);
    expect(findTokenMatches({ payees, tokens: ['batumi'] }).map((entry) => entry.id)).toEqual(['spar']);
  });

  it('puts the payee that matches the most tokens first', () => {
    const lab = payee({ id: 'lab', name: 'Lab Supplies' });

    expect(findTokenMatches({ payees: [lab, coffeeLab], tokens: ['coffee', 'lab'] }).map((entry) => entry.id)).toEqual([
      'coffee-lab',
      'lab',
    ]);
  });

  it('finds nothing without tokens or a match', () => {
    expect(findTokenMatches({ payees, tokens: [] })).toEqual([]);
    expect(findTokenMatches({ payees, tokens: ['zzzz'] })).toEqual([]);
  });
});

describe('findFuzzyMatches', () => {
  it('finds a payee whose spelling is close to a token', () => {
    const matches = findFuzzyMatches({ payees: [wolt, coffeeLab, spar], tokens: ['volt'] });

    expect(matches[0]?.id).toBe('wolt');
  });

  it('returns one entry per payee, best first', () => {
    const ids = findFuzzyMatches({ payees: [wolt, coffeeLab], tokens: ['wolt', 'woltcom'] }).map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('wolt');
  });

  it('finds nothing without tokens or payees', () => {
    expect(findFuzzyMatches({ payees: [wolt], tokens: [] })).toEqual([]);
    expect(findFuzzyMatches({ payees: [], tokens: ['wolt'] })).toEqual([]);
  });
});

describe('mergePayeeCandidates', () => {
  const many = Array.from({ length: 30 }, (_, index) => payee({ id: `p${index}`, name: `Shop ${index}` }));

  it('orders by trust: token matches, fuzzy matches, recent payees', () => {
    const result = mergePayeeCandidates({ tokenMatches: [wolt], fuzzyMatches: [coffeeLab], recent: [spar] });

    expect(result.map((candidate) => candidate.payeeId)).toEqual(['wolt', 'coffee-lab', 'spar']);
  });

  it('drops a payee that appears in several groups', () => {
    const result = mergePayeeCandidates({ tokenMatches: [wolt], fuzzyMatches: [wolt, spar], recent: [wolt, spar] });

    expect(result.map((candidate) => candidate.payeeId)).toEqual(['wolt', 'spar']);
  });

  it('caps the list at 15 and gives every group room', () => {
    const result = mergePayeeCandidates({
      tokenMatches: many.slice(0, 20),
      fuzzyMatches: many.slice(20, 30),
      recent: [spar, coffeeLab, wolt, cardShop, payee({ id: 'extra', name: 'Extra' })],
    });

    expect(PAYEE_CANDIDATES_LIMIT).toBe(15);
    expect(result).toHaveLength(15);
    expect(result.map((candidate) => candidate.payeeId)).toContain('p20');
    expect(result.map((candidate) => candidate.payeeId)).not.toContain('p8');
  });

  it('carries the payee name and its spellings', () => {
    expect(mergePayeeCandidates({ tokenMatches: [wolt], fuzzyMatches: [], recent: [] })).toEqual([
      { payeeId: 'wolt', name: 'Wolt', aliases: ['WOLT.COM TBILISI'] },
    ]);
  });

  it('is empty when nothing matched', () => {
    expect(mergePayeeCandidates({ tokenMatches: [], fuzzyMatches: [], recent: [] })).toEqual([]);
  });
});
