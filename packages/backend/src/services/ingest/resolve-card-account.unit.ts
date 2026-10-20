import { describe, expect, it } from '@jest/globals';
import type CardAccountMappings from '@models/card-account-mappings.model';

import { pickCardMapping } from './resolve-card-account';

const row = ({ id, currencyCode }: { id: string; currencyCode: string | null }) =>
  ({ id, currencyCode }) as unknown as CardAccountMappings;

const GEL = row({ id: 'gel', currencyCode: 'GEL' });
const USD = row({ id: 'usd', currencyCode: 'USD' });
const DEFAULT = row({ id: 'default', currencyCode: null });

describe('pickCardMapping', () => {
  it('takes the row of the payment currency', () => {
    expect(pickCardMapping({ rows: [DEFAULT, GEL, USD], currencyCode: 'USD' })).toEqual({
      mapping: USD,
      matchedBy: 'currency',
    });
  });

  it('prefers the currency row over the default whatever their order', () => {
    expect(pickCardMapping({ rows: [GEL, DEFAULT], currencyCode: 'GEL' })?.mapping).toBe(GEL);
    expect(pickCardMapping({ rows: [DEFAULT, GEL], currencyCode: 'GEL' })?.mapping).toBe(GEL);
  });

  it('falls back to the default when the card has no row for the currency', () => {
    expect(pickCardMapping({ rows: [GEL, USD, DEFAULT], currencyCode: 'EUR' })).toEqual({
      mapping: DEFAULT,
      matchedBy: 'default',
    });
  });

  it('uses the default for a payment whose currency is not known yet', () => {
    expect(pickCardMapping({ rows: [GEL, DEFAULT], currencyCode: null })).toEqual({
      mapping: DEFAULT,
      matchedBy: 'default',
    });
  });

  it('is an unknown card when neither a currency row nor a default fits', () => {
    expect(pickCardMapping({ rows: [GEL, USD], currencyCode: 'EUR' })).toBeNull();
    expect(pickCardMapping({ rows: [GEL, USD], currencyCode: null })).toBeNull();
    expect(pickCardMapping({ rows: [], currencyCode: 'GEL' })).toBeNull();
  });
});
