import { describe, expect, it } from '@jest/globals';

import type { StoredPayment } from '../event/stored-parse';
import { isParkedTwin, isSameMerchant, type TwinProbe } from './parked-twin-rule';

const payment = (overrides: Partial<StoredPayment> = {}): StoredPayment => ({
  kind: 'debit',
  stage: 'payment',
  amount: '143.97',
  currencyCode: 'GEL',
  originalAmount: null,
  originalCurrencyCode: null,
  merchant: 'Temu',
  payee: null,
  cardName: 'TBC Bank',
  cardLastDigits: null,
  balanceAfter: null,
  occurredAt: null,
  ...overrides,
});

type ProbeOverrides = Omit<Partial<TwinProbe>, 'payment'> & { payment?: Partial<StoredPayment> };

const probe = (overrides: ProbeOverrides = {}): TwinProbe => ({
  payment: payment(overrides.payment),
  time: overrides.time ?? new Date('2026-10-22T16:16:26Z'),
  slot: overrides.slot ?? 'wallet-notification',
});

const WINDOW = 30 * 60_000;
const bank = (overrides: ProbeOverrides = {}) =>
  probe({ slot: 'bank:name:tbc bank:payment', time: new Date('2026-10-22T16:16:40Z'), ...overrides });

describe('isParkedTwin', () => {
  it('joins Wallet and the bank for one payment', () => {
    expect(
      isParkedTwin({
        left: probe(),
        right: bank({
          payment: { merchant: 'TEMU.COM', cardName: 'TBC Concept VISA Platinum', cardLastDigits: '1234' },
        }),
        windowMs: WINDOW,
      }),
    ).toBe(true);
  });

  it('keeps two payments of one source apart', () => {
    expect(
      isParkedTwin({ left: probe(), right: probe({ time: new Date('2026-10-22T16:20:00Z') }), windowMs: WINDOW }),
    ).toBe(false);
  });

  it('needs the same amount, direction and business', () => {
    expect(isParkedTwin({ left: probe(), right: bank({ payment: { amount: '143.98' } }), windowMs: WINDOW })).toBe(
      false,
    );
    expect(isParkedTwin({ left: probe(), right: bank({ payment: { kind: 'credit' } }), windowMs: WINDOW })).toBe(false);
    expect(isParkedTwin({ left: probe(), right: bank({ payment: { merchant: 'Wolt' } }), windowMs: WINDOW })).toBe(
      false,
    );
    expect(isParkedTwin({ left: probe(), right: bank({ payment: { merchant: null } }), windowMs: WINDOW })).toBe(false);
  });

  it('needs the same currency when both state one, and takes a missing one as a match', () => {
    expect(isParkedTwin({ left: probe(), right: bank({ payment: { currencyCode: 'USD' } }), windowMs: WINDOW })).toBe(
      false,
    );
    expect(isParkedTwin({ left: probe(), right: bank({ payment: { currencyCode: null } }), windowMs: WINDOW })).toBe(
      true,
    );
  });

  it('matches the charged amount of a bank that states both', () => {
    expect(
      isParkedTwin({
        left: probe({ payment: { amount: '53.20', currencyCode: 'USD' } }),
        right: bank({
          payment: { amount: '143.97', currencyCode: 'GEL', originalAmount: '53.20', originalCurrencyCode: 'USD' },
        }),
        windowMs: WINDOW,
      }),
    ).toBe(true);
  });

  it('stays inside the window', () => {
    expect(
      isParkedTwin({ left: probe(), right: bank({ time: new Date('2026-10-22T17:00:00Z') }), windowMs: WINDOW }),
    ).toBe(false);
  });
});

describe('isSameMerchant', () => {
  it('reads two spellings of one business as one', () => {
    expect(isSameMerchant({ left: 'Temu', right: 'TEMU.COM LU' })).toBe(true);
    expect(isSameMerchant({ left: 'Wolt', right: 'WOLT TBILISI' })).toBe(true);
  });

  it('does not join different businesses or a name too short to tell', () => {
    expect(isSameMerchant({ left: 'Temu', right: 'Teemo Cafe' })).toBe(false);
    expect(isSameMerchant({ left: 'A', right: 'A Market' })).toBe(false);
  });
});
