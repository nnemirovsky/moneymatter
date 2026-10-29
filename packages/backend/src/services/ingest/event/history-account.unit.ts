import type { RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';

import { pickHistoryAccount, type HistoryUse } from './history-account';

const A = 'account-a' as RecordId;
const B = 'account-b' as RecordId;
const C = 'account-c' as RecordId;

const use = (overrides: Partial<HistoryUse> = {}): HistoryUse => ({
  accountId: A,
  accountCurrencyCode: 'USD',
  paymentCurrencyCode: 'USD',
  cardLastDigits: '1234',
  ...overrides,
});

const balances = new Map<RecordId, Money>([
  [A, Money.fromDecimal('240.50')],
  [B, Money.fromDecimal('15')],
  [C, Money.fromDecimal('500')],
]);

const pick = (overrides: Partial<Parameters<typeof pickHistoryAccount>[0]> = {}) =>
  pickHistoryAccount({
    uses: [use()],
    balances,
    cardLastDigits: '1234',
    currencyCode: 'USD',
    balanceAfter: null,
    amount: Money.fromDecimal('40.25'),
    kind: 'debit',
    ...overrides,
  });

describe('pickHistoryAccount', () => {
  it('takes the one account the same digits and currency landed on', () => {
    expect(pick()).toEqual({ accountId: A, confidence: 'digits' });
  });

  it('keys on the digits and the currency together', () => {
    const uses = [use(), use({ accountId: B, accountCurrencyCode: 'EUR', paymentCurrencyCode: 'EUR' })];

    expect(pick({ uses })).toEqual({ accountId: A, confidence: 'digits' });
    expect(pick({ uses, currencyCode: 'EUR' })).toEqual({ accountId: B, confidence: 'digits' });
  });

  it('settles several accounts for the same digits by the stated balance', () => {
    const uses = [use(), use({ accountId: C })];

    expect(pick({ uses })).toBeNull();
    expect(pick({ uses, balanceAfter: Money.fromDecimal('200.37') })).toEqual({ accountId: A, confidence: 'balance' });
  });

  it('falls back to the one account in the currency among those the source used, but only as an unconfirmed pick', () => {
    const uses = [
      use({ cardLastDigits: '9999' }),
      use({ accountId: B, accountCurrencyCode: 'EUR', paymentCurrencyCode: 'EUR' }),
    ];

    expect(pick({ uses })).toEqual({ accountId: A, confidence: 'unique' });
  });

  it('confirms the currency-unique account by the stated balance', () => {
    expect(pick({ uses: [use({ cardLastDigits: null })], balanceAfter: Money.fromDecimal('200.37') })).toEqual({
      accountId: A,
      confidence: 'balance',
    });
  });

  it('picks nothing when two accounts in the currency are used and no balance tells them apart', () => {
    const uses = [use({ cardLastDigits: null }), use({ accountId: C, cardLastDigits: null })];

    expect(pick({ uses, cardLastDigits: null })).toBeNull();
  });

  it('reads a credit as raising the balance', () => {
    const uses = [use({ cardLastDigits: null }), use({ accountId: C, cardLastDigits: null })];

    expect(pick({ uses, cardLastDigits: null, kind: 'credit', balanceAfter: Money.fromDecimal('540.25') })).toEqual({
      accountId: C,
      confidence: 'balance',
    });
  });

  it('picks nothing without a currency or without any history', () => {
    expect(pick({ currencyCode: null })).toBeNull();
    expect(pick({ uses: [] })).toBeNull();
  });
});
