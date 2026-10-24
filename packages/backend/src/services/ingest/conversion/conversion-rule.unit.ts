import type { RecordId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import type { StoredPayment } from '../event/stored-parse';
import { hasNoMerchant, impliedRate, isConversionPair, sidesOf, type ConversionLeg } from './conversion-rule';

const payment = (overrides: Partial<StoredPayment> = {}): StoredPayment => ({
  kind: 'debit',
  stage: 'payment',
  amount: '400.00',
  currencyCode: 'USD',
  originalAmount: null,
  originalCurrencyCode: null,
  merchant: null,
  payee: null,
  cardName: null,
  cardLastDigits: null,
  balanceAfter: null,
  occurredAt: null,
  ...overrides,
});

type LegOverrides = Omit<Partial<ConversionLeg>, 'payment'> & { payment?: Partial<StoredPayment> };

const SOURCE = 'source-1' as RecordId;
const OTHER_SOURCE = 'source-2' as RecordId;

const debit = (overrides: LegOverrides = {}): ConversionLeg => ({
  payment: payment(overrides.payment),
  time: overrides.time ?? new Date('2026-01-15T07:25:42Z'),
  sourceId: overrides.sourceId === undefined ? SOURCE : overrides.sourceId,
});

const credit = (overrides: LegOverrides = {}): ConversionLeg =>
  debit({
    time: new Date('2026-01-15T07:27:31Z'),
    ...overrides,
    payment: { kind: 'credit', amount: '360.00', currencyCode: 'EUR', ...overrides.payment },
  });

describe('hasNoMerchant', () => {
  it.each([
    [null, null],
    ['', null],
    ['Money Transfer', null],
    ['  deposit   MONEY ', null],
    ['Currency Exchange', null],
    ['Conversion', null],
    ['EXAMPLE CARD', null],
    ['Example Concept', 'Example Concept'],
    ['Visa Gold Card', null],
  ])('reads %p as no merchant', (merchant, cardName) => {
    expect(hasNoMerchant({ merchant, cardName })).toBe(true);
  });

  it.each(['Wolt', 'Temu.com', 'Carding Supplies Ltd', 'Money Transfer Bar'])('keeps %p as a merchant', (merchant) => {
    expect(hasNoMerchant({ merchant, cardName: null })).toBe(false);
  });
});

describe('isConversionPair', () => {
  it('pairs money out in one currency with money in another, in either order', () => {
    expect(isConversionPair({ left: debit(), right: credit() })).toBe(true);
    expect(isConversionPair({ left: credit(), right: debit() })).toBe(true);
  });

  it('pairs a notice that printed the bank generic word and one that printed nothing', () => {
    expect(
      isConversionPair({
        left: debit({ payment: { merchant: 'EXAMPLE CARD' } }),
        right: credit({ payment: { merchant: null, cardName: 'EXAMPLE CARD' } }),
      }),
    ).toBe(true);
  });

  it('does not pair notices of different sources, or of a source that is unknown', () => {
    expect(isConversionPair({ left: debit(), right: credit({ sourceId: OTHER_SOURCE }) })).toBe(false);
    expect(isConversionPair({ left: debit({ sourceId: null }), right: credit({ sourceId: null }) })).toBe(false);
  });

  it('does not pair two payments in one direction or one currency', () => {
    expect(isConversionPair({ left: debit(), right: debit({ payment: { currencyCode: 'EUR' } }) })).toBe(false);
    expect(isConversionPair({ left: debit(), right: credit({ payment: { currencyCode: 'USD' } }) })).toBe(false);
    expect(isConversionPair({ left: debit(), right: credit({ payment: { currencyCode: null } }) })).toBe(false);
  });

  it('does not pair a side that names a merchant', () => {
    expect(isConversionPair({ left: debit({ payment: { merchant: 'Wolt' } }), right: credit() })).toBe(false);
    expect(isConversionPair({ left: debit(), right: credit({ payment: { merchant: 'Salary ACME' } }) })).toBe(false);
  });

  it('pairs only within the window', () => {
    const late = credit({ time: new Date('2026-01-15T07:35:00Z') });
    const later = credit({ time: new Date('2026-01-15T07:36:43Z') });

    expect(isConversionPair({ left: debit(), right: late })).toBe(true);
    expect(isConversionPair({ left: debit(), right: later })).toBe(false);
  });
});

describe('sidesOf and impliedRate', () => {
  it('names the outgoing and the incoming side whichever way they are given', () => {
    const out = debit();
    const incoming = credit();

    expect(sidesOf({ left: incoming, right: out })).toEqual({ debit: out, credit: incoming });
    expect(sidesOf({ left: out, right: incoming })).toEqual({ debit: out, credit: incoming });
  });

  it('gives the units of the incoming currency per unit of the outgoing one', () => {
    expect(impliedRate({ debit: payment(), credit: payment({ kind: 'credit', amount: '360.00' }) })).toBe(0.9);
    expect(impliedRate({ debit: payment({ amount: '3' }), credit: payment({ amount: '10' }) })).toBe(3.3333);
    expect(impliedRate({ debit: payment({ amount: '0' }), credit: payment({ amount: '10' }) })).toBeNull();
  });
});
