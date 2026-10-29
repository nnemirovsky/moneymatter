import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';

import {
  BEFORE_PAYMENT_MS,
  PAYMENT_LOOKBACK_MS,
  placeConversionTime,
  type PaymentOnAccount,
} from './conversion-timing';

const RECEIVED = new Date('2026-01-15T10:32:00Z');
const minutesBefore = ({ minutes }: { minutes: number }) => new Date(RECEIVED.getTime() - minutes * 60_000);

const payment = (overrides: Partial<PaymentOnAccount> = {}): PaymentOnAccount => ({
  time: minutesBefore({ minutes: 1 }),
  amount: Money.fromDecimal('30'),
  balanceBefore: Money.fromDecimal('10'),
  ...overrides,
});

const place = ({ payments, received = '40' }: { payments: PaymentOnAccount[]; received?: string }) =>
  placeConversionTime({ receivedAt: RECEIVED, received: Money.fromDecimal(received), payments });

describe('placeConversionTime', () => {
  it('places the exchange a minute before the short payment it covers', () => {
    const paid = payment();

    expect(place({ payments: [paid] }).getTime()).toBe(paid.time.getTime() - BEFORE_PAYMENT_MS);
  });

  it('keeps the arrival time when the exchange does not cover the shortfall', () => {
    expect(place({ payments: [payment()], received: '5' })).toEqual(RECEIVED);
  });

  it('keeps the arrival time when the payment was not short', () => {
    expect(place({ payments: [payment({ balanceBefore: Money.fromDecimal('100') })] })).toEqual(RECEIVED);
  });

  it('keeps the arrival time when the payment recorded no balance', () => {
    expect(place({ payments: [payment({ balanceBefore: null })] })).toEqual(RECEIVED);
  });

  it('keeps the arrival time when the payment came before the lookback window', () => {
    const old = payment({ time: new Date(RECEIVED.getTime() - PAYMENT_LOOKBACK_MS - 1000) });

    expect(place({ payments: [old] })).toEqual(RECEIVED);
  });

  it('keeps the arrival time when the payment came after the notice', () => {
    expect(place({ payments: [payment({ time: new Date(RECEIVED.getTime() + 1000) })] })).toEqual(RECEIVED);
  });

  it('is placed before the earliest of several payments it covers', () => {
    const first = payment({ time: minutesBefore({ minutes: 3 }), amount: Money.fromDecimal('20') });
    const second = payment({ time: minutesBefore({ minutes: 1 }), amount: Money.fromDecimal('25') });

    expect(place({ payments: [second, first] }).getTime()).toBe(first.time.getTime() - BEFORE_PAYMENT_MS);
  });

  it('keeps the arrival time with no payment at all', () => {
    expect(place({ payments: [] })).toEqual(RECEIVED);
  });
});
