import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';
import type Transactions from '@models/transactions.model';

import { isCoveredByTopUps } from './top-up-covers';

const topUp = ({ amount }: { amount: number }) => ({ amount: Money.fromDecimal(String(amount)) }) as Transactions;

describe('isCoveredByTopUps', () => {
  const balanceBefore = Money.fromDecimal('234.58');
  const amount = Money.fromDecimal('305');

  it('is covered when the balance and the top-ups together reach the payment', () => {
    expect(isCoveredByTopUps({ balanceBefore, amount, topUps: [topUp({ amount: 100 })] })).toBe(true);
    expect(isCoveredByTopUps({ balanceBefore, amount, topUps: [topUp({ amount: 40 }), topUp({ amount: 40 })] })).toBe(
      true,
    );
  });

  it('is not covered by a top-up that falls short, or by none', () => {
    expect(isCoveredByTopUps({ balanceBefore, amount, topUps: [topUp({ amount: 50 })] })).toBe(false);
    expect(isCoveredByTopUps({ balanceBefore, amount, topUps: [] })).toBe(false);
  });
});
