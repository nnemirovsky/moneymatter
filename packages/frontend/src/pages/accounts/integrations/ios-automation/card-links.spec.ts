import type { AccountModel, CardMappingDto, RecordId } from '@bt/shared/types';
import { describe, expect, it } from 'vitest';

import { getFreeLinkTargets, groupCardMappings, hasDefaultLink } from './card-links';

const row = (overrides: Partial<CardMappingDto>): CardMappingDto => ({
  id: 'row' as RecordId,
  cardLabel: 'TBC Visa',
  lastDigits: null,
  currencyCode: null,
  accountId: 'account' as RecordId,
  createdAt: '2026-10-10T09:00:00.000Z',
  ...overrides,
});

const account = (currencyCode: string) => ({ currencyCode }) as AccountModel;

describe('groupCardMappings', () => {
  it('puts the rows of one card together in the order they came', () => {
    const groups = groupCardMappings({
      mappings: [
        row({ id: 'a' as RecordId }),
        row({ id: 'b' as RecordId, currencyCode: 'GEL' }),
        row({ id: 'c' as RecordId, cardLabel: 'Revolut' }),
        row({ id: 'd' as RecordId, currencyCode: 'USD' }),
      ],
    });

    expect(groups.map((group) => [group.cardLabel, group.mappings.map((mapping) => mapping.id)])).toEqual([
      ['TBC Visa', ['a', 'b', 'd']],
      ['Revolut', ['c']],
    ]);
  });

  it('takes the last digits from whichever row of the card has them', () => {
    const [group] = groupCardMappings({ mappings: [row({}), row({ currencyCode: 'GEL', lastDigits: '1234' })] });

    expect(group!.lastDigits).toBe('1234');
  });

  it('is empty for no rows', () => {
    expect(groupCardMappings({ mappings: [] })).toEqual([]);
  });
});

describe('hasDefaultLink', () => {
  it('tells a card with a default row from one with only currencies', () => {
    const [withDefault] = groupCardMappings({ mappings: [row({}), row({ currencyCode: 'GEL' })] });
    const [withoutDefault] = groupCardMappings({ mappings: [row({ currencyCode: 'GEL' })] });

    expect(hasDefaultLink({ group: withDefault! })).toBe(true);
    expect(hasDefaultLink({ group: withoutDefault! })).toBe(false);
  });
});

describe('getFreeLinkTargets', () => {
  const accounts = [account('USD'), account('GEL'), account('GEL'), account('EUR')];

  it('offers every currency of the accounts once, sorted, and the default, for a new card', () => {
    expect(getFreeLinkTargets({ accounts, siblings: [] })).toEqual({
      currencies: ['EUR', 'GEL', 'USD'],
      defaultAvailable: true,
    });
  });

  it('leaves out what the card already has', () => {
    expect(getFreeLinkTargets({ accounts, siblings: [row({}), row({ currencyCode: 'GEL' })] })).toEqual({
      currencies: ['EUR', 'USD'],
      defaultAvailable: false,
    });
  });

  it('still offers the default when the card has only currency rows', () => {
    expect(getFreeLinkTargets({ accounts, siblings: [row({ currencyCode: 'USD' })] })).toEqual({
      currencies: ['EUR', 'GEL'],
      defaultAvailable: true,
    });
  });
});
