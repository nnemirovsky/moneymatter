import { describe, expect, it } from '@jest/globals';

import { MAX_STOREFRONTS_PER_LOOKUP, storefrontsFor } from './storefronts';

describe('storefrontsFor', () => {
  it('starts with the countries the account currencies suggest, the most used currency first', () => {
    expect(storefrontsFor({ currencyCodes: ['EUR', 'GBP', 'GBP'] }).slice(0, 2)).toEqual(['gb', 'de']);
  });

  it('follows with common storefronts, without repeating one the accounts already suggested', () => {
    const storefronts = storefrontsFor({ currencyCodes: ['USD'] });

    expect(storefronts[0]).toBe('us');
    expect(new Set(storefronts).size).toBe(storefronts.length);
    expect(storefronts).toEqual(expect.arrayContaining(['gb', 'de']));
  });

  it('knows nothing for a currency it has no storefront for, and still offers the common ones', () => {
    expect(storefrontsFor({ currencyCodes: ['XTS'] })).toEqual(['us', 'gb', 'de', 'fr', 'ca', 'au']);
    expect(storefrontsFor({ currencyCodes: [] })[0]).toBe('us');
  });

  it('reads a currency code in any case, and is capped so a miss costs a bounded number of requests', () => {
    expect(storefrontsFor({ currencyCodes: ['jpy'] })[0]).toBe('jp');
    const many = storefrontsFor({ currencyCodes: ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK'] });
    expect(many).toHaveLength(MAX_STOREFRONTS_PER_LOOKUP);
  });
});
