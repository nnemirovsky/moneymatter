import { describe, expect, it } from '@jest/globals';

import { allowedEdits, editDistance, matchMerchantCore, merchantCoreName } from './merchant-core';

const payee = ({ id, name, aliases = [] }: { id: string; name: string; aliases?: string[] }) => ({
  id,
  name,
  names: [name, ...aliases],
});

describe('merchantCoreName', () => {
  it('drops case, punctuation and the legal forms at the end', () => {
    expect(merchantCoreName({ raw: 'NORD COFEE COMPANY LTD' })).toBe('nord cofee');
    expect(merchantCoreName({ raw: 'Nord Coffee Co.' })).toBe('nord coffee');
    expect(merchantCoreName({ raw: 'Wolt Georgia, LLC' })).toBe('wolt georgia');
  });

  it('drops the legal forms written before the name', () => {
    expect(merchantCoreName({ raw: 'შპს ნორდი' })).toBe('ნორდი');
    expect(merchantCoreName({ raw: 'ი/მ გიორგი' })).toBe('გიორგი');
    expect(merchantCoreName({ raw: 'ООО "Ромашка"' })).toBe('ромашка');
    expect(merchantCoreName({ raw: 'LLC Nord' })).toBe('nord');
  });

  it('keeps a short legal-looking word that starts a name', () => {
    expect(merchantCoreName({ raw: 'Co Working Space' })).toBe('co working space');
  });

  it('keeps the last word of a name made only of legal forms', () => {
    expect(merchantCoreName({ raw: 'Company Ltd' })).toBe('ltd');
  });
});

describe('editDistance', () => {
  it('counts inserts, deletes, substitutions and swapped neighbours as one edit each', () => {
    expect(editDistance({ a: 'nord cofee', b: 'nord coffee' })).toBe(1);
    expect(editDistance({ a: 'wolt', b: 'wlot' })).toBe(1);
    expect(editDistance({ a: 'spar', b: 'spa' })).toBe(1);
    expect(editDistance({ a: 'cafe', b: 'coffee' })).toBe(3);
    expect(editDistance({ a: 'same', b: 'same' })).toBe(0);
  });
});

describe('allowedEdits', () => {
  it('allows no typo in a short name, one in an ordinary name and two in a long one', () => {
    expect(allowedEdits({ length: 4 })).toBe(0);
    expect(allowedEdits({ length: 10 })).toBe(1);
    expect(allowedEdits({ length: 14 })).toBe(2);
  });
});

describe('matchMerchantCore', () => {
  const nordCoffee = payee({ id: 'nord', name: 'Nord Coffee', aliases: ['Nord'] });
  const wolt = payee({ id: 'wolt', name: 'Wolt' });

  it('matches a typo and a legal suffix to the one payee they belong to', () => {
    expect(matchMerchantCore({ rawMerchant: 'NORD COFEE COMPANY LTD', payees: [nordCoffee, wolt] })).toEqual({
      kind: 'unique',
      payeeId: 'nord',
      distance: 1,
    });
  });

  it('matches through an alias', () => {
    const lab = payee({ id: 'lab', name: 'Coffee Lab', aliases: ['Lokal Roasters'] });

    expect(matchMerchantCore({ rawMerchant: 'LOKAL ROASTERS LLC', payees: [lab] })).toMatchObject({
      kind: 'unique',
      payeeId: 'lab',
      distance: 0,
    });
  });

  it('matches nothing for another business, a short name one letter off, or a different word count', () => {
    const spa = payee({ id: 'spa', name: 'Spa' });

    expect(matchMerchantCore({ rawMerchant: 'SPAR', payees: [spa] })).toEqual({ kind: 'none' });
    expect(matchMerchantCore({ rawMerchant: 'Nord Coffee Batumi', payees: [nordCoffee] })).toEqual({ kind: 'none' });
    expect(matchMerchantCore({ rawMerchant: 'Coffee Lab', payees: [nordCoffee, wolt] })).toEqual({ kind: 'none' });
  });

  it('prefers the payee whose name is equal over one a typo away', () => {
    const nordCofe = payee({ id: 'nord-cofe', name: 'Nord Cofe' });

    expect(matchMerchantCore({ rawMerchant: 'Nord Cofe Ltd', payees: [nordCoffee, nordCofe] })).toEqual({
      kind: 'unique',
      payeeId: 'nord-cofe',
      distance: 0,
    });
  });

  it('reports every close payee when several are as close, in name order', () => {
    const nordCoffea = payee({ id: 'nord-coffea', name: 'Nord Coffea' });

    expect(matchMerchantCore({ rawMerchant: 'NORD COFFEX LTD', payees: [nordCoffee, nordCoffea] })).toEqual({
      kind: 'ambiguous',
      candidates: [
        { payeeId: 'nord-coffea', name: 'Nord Coffea', distance: 1 },
        { payeeId: 'nord', name: 'Nord Coffee', distance: 1 },
      ],
    });
  });
});
