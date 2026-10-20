import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';

import { listNonZeroCurrencies, resolveBalanceAuthority } from './balance-authority';
import type { ParsedBalanceAfter } from './classify-notification';

const balance = (overrides: Partial<ParsedBalanceAfter> = {}): ParsedBalanceAfter => ({
  amount: '1204.30',
  currencyCode: 'GEL',
  scopeHint: 'account',
  ...overrides,
});

const sibling = ({ currencyCode, amount }: { currencyCode: string; amount: number }) => ({
  currencyCode,
  balance: Money.fromDecimal(amount),
});

describe('resolveBalanceAuthority', () => {
  it('is authoritative when the bank holds one currency', () => {
    expect(resolveBalanceAuthority({ balance: balance(), accountCurrencyCode: 'GEL', siblings: [] })).toEqual({
      amount: '1204.30',
      currency: 'GEL',
      authoritative: true,
      scopeHint: 'account',
    });
  });

  it('is authoritative when every other currency is empty', () => {
    const result = resolveBalanceAuthority({
      balance: balance(),
      accountCurrencyCode: 'GEL',
      siblings: [sibling({ currencyCode: 'USD', amount: 0 }), sibling({ currencyCode: 'EUR', amount: 0 })],
    });

    expect(result.authoritative).toBe(true);
  });

  it('is informational when another currency holds money', () => {
    const result = resolveBalanceAuthority({
      balance: balance(),
      accountCurrencyCode: 'GEL',
      siblings: [sibling({ currencyCode: 'USD', amount: 120.5 })],
    });

    expect(result).toMatchObject({ authoritative: false, currency: 'GEL' });
  });

  it('is informational when the text calls the balance a total', () => {
    expect(
      resolveBalanceAuthority({ balance: balance({ scopeHint: 'total' }), accountCurrencyCode: 'GEL', siblings: [] })
        .authoritative,
    ).toBe(false);
  });

  it('is informational when the balance is in another currency than the account', () => {
    expect(
      resolveBalanceAuthority({
        balance: balance({ currencyCode: 'GEL' }),
        accountCurrencyCode: 'USD',
        siblings: [],
      }).authoritative,
    ).toBe(false);
  });

  it('ignores a sibling in the account currency', () => {
    const result = resolveBalanceAuthority({
      balance: balance(),
      accountCurrencyCode: 'GEL',
      siblings: [sibling({ currencyCode: 'GEL', amount: 50 })],
    });

    expect(result.authoritative).toBe(true);
  });

  it('keeps an unknown scope authoritative when nothing contradicts it', () => {
    expect(
      resolveBalanceAuthority({ balance: balance({ scopeHint: 'unknown' }), accountCurrencyCode: 'GEL', siblings: [] })
        .authoritative,
    ).toBe(true);
  });
});

describe('listNonZeroCurrencies', () => {
  it('lists each currency that holds money once', () => {
    expect(
      listNonZeroCurrencies({
        siblings: [
          sibling({ currencyCode: 'GEL', amount: 10 }),
          sibling({ currencyCode: 'GEL', amount: 5 }),
          sibling({ currencyCode: 'USD', amount: 0 }),
          sibling({ currencyCode: 'EUR', amount: -3 }),
        ],
      }),
    ).toEqual(['GEL', 'EUR']);
  });

  it('is empty when nothing is known', () => {
    expect(listNonZeroCurrencies({ siblings: [] })).toEqual([]);
  });
});
