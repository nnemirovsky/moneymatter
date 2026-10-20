import type { RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';

import { applyRanking, isBalanceShort, rankByCoverage, type ShortBalanceCandidate } from './short-balance-rule';

const candidate = (
  overrides: Partial<Omit<ShortBalanceCandidate, 'accountId'>> & { accountId: string },
): ShortBalanceCandidate => ({
  currencyCode: 'USD',
  balance: Money.fromDecimal(500),
  estimatedAmount: Money.fromDecimal(10.9),
  isDefault: false,
  ...overrides,
  accountId: overrides.accountId as RecordId,
});

describe('isBalanceShort', () => {
  it('is short only when the balance is below the payment', () => {
    expect(isBalanceShort({ balanceBefore: Money.fromDecimal(10), amount: Money.fromDecimal(29.41) })).toBe(true);
    expect(isBalanceShort({ balanceBefore: Money.fromDecimal(29.41), amount: Money.fromDecimal(29.41) })).toBe(false);
    expect(isBalanceShort({ balanceBefore: Money.fromDecimal(-5), amount: Money.fromDecimal(1) })).toBe(true);
  });
});

describe('rankByCoverage', () => {
  it('keeps only the accounts whose balance covers the converted amount in full', () => {
    const covers = candidate({ accountId: 'usd', balance: Money.fromDecimal(10.9) });
    const short = candidate({ accountId: 'eur', currencyCode: 'EUR', balance: Money.fromDecimal(10.89) });

    expect(rankByCoverage({ candidates: [short, covers] }).map((entry) => entry.accountId)).toEqual(['usd']);
  });

  it('puts the default account first, then the fullest balance', () => {
    const usd = candidate({ accountId: 'usd', balance: Money.fromDecimal(500) });
    const eur = candidate({ accountId: 'eur', currencyCode: 'EUR', balance: Money.fromDecimal(900) });
    const fallback = candidate({
      accountId: 'gel',
      currencyCode: 'GEL',
      balance: Money.fromDecimal(50),
      isDefault: true,
    });

    expect(rankByCoverage({ candidates: [usd, eur, fallback] }).map((entry) => entry.accountId)).toEqual([
      'gel',
      'eur',
      'usd',
    ]);
  });

  it('breaks a tie by currency code, whatever order the rows came in', () => {
    const a = candidate({ accountId: 'a', currencyCode: 'EUR' });
    const b = candidate({ accountId: 'b', currencyCode: 'USD' });

    expect(rankByCoverage({ candidates: [b, a] }).map((entry) => entry.accountId)).toEqual(['a', 'b']);
    expect(rankByCoverage({ candidates: [a, b] }).map((entry) => entry.accountId)).toEqual(['a', 'b']);
  });

  it('returns nothing when no account covers the payment', () => {
    expect(rankByCoverage({ candidates: [candidate({ accountId: 'usd', balance: Money.fromDecimal(1) })] })).toEqual(
      [],
    );
  });
});

const ids = (entries: ShortBalanceCandidate[]) => entries.map((entry) => entry.accountId);

describe('applyRanking', () => {
  const covering = [
    candidate({ accountId: 'gel', isDefault: true }),
    candidate({ accountId: 'usd' }),
    candidate({ accountId: 'eur' }),
  ];

  it('follows the model order', () => {
    expect(ids(applyRanking({ covering, ranking: ['eur' as RecordId, 'usd' as RecordId] }))).toEqual([
      'eur',
      'usd',
      'gel',
    ]);
  });

  it('drops accounts it was not shown and repeated ones, and keeps what it left out', () => {
    expect(
      ids(applyRanking({ covering, ranking: ['made-up' as RecordId, 'usd' as RecordId, 'usd' as RecordId] })),
    ).toEqual(['usd', 'gel', 'eur']);
  });

  it('keeps the deterministic order for an empty answer', () => {
    expect(ids(applyRanking({ covering, ranking: [] }))).toEqual(['gel', 'usd', 'eur']);
  });
});
