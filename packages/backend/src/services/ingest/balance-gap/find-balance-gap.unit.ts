import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';

import { findBalanceGap } from './find-balance-gap';

const gap = ({ stated, held }: { stated: string; held: string }) =>
  findBalanceGap({ stated: Money.fromDecimal(stated), held: Money.fromDecimal(held) })?.toNumber() ?? null;

describe('findBalanceGap', () => {
  it('is the money that arrived and is not logged', () => {
    expect(gap({ stated: '5320.40', held: '320.40' })).toBe(5000);
  });

  it('is negative for money that left and is not logged', () => {
    expect(gap({ stated: '70', held: '250.19' })).toBe(-180.19);
  });

  it('is null when the balances agree within rounding', () => {
    expect(gap({ stated: '250.31', held: '250.19' })).toBeNull();
    expect(gap({ stated: '250.31', held: '250.31' })).toBeNull();
  });

  it('scales the tolerance with the balance', () => {
    expect(gap({ stated: '100000', held: '99500' })).toBeNull();
    expect(gap({ stated: '100000', held: '98000' })).toBe(2000);
  });
});
