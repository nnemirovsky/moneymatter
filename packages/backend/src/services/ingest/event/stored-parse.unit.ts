import { describe, expect, it } from '@jest/globals';

import type { ParsedPayment } from './classify-notification';
import {
  FORCE_PARK_REASONS,
  UNCLASSIFIED_PARK_REASONS,
  fromStoredPayment,
  readStoredParse,
  toStoredPayment,
} from './stored-parse';

const payment: ParsedPayment = {
  kind: 'debit',
  stage: 'payment',
  amount: '43.6',
  currencyCode: 'GEL',
  originalAmount: null,
  originalCurrencyCode: null,
  merchant: 'Wolt',
  payee: { type: 'new', name: 'Wolt' },
  cardName: 'TBC Visa',
  cardLastDigits: '4321',
  balanceAfter: { amount: '100', currencyCode: 'GEL', scopeHint: 'account' },
  occurredAt: new Date('2026-10-20T10:15:00.000Z'),
};

describe('stored payment', () => {
  it('survives a trip through JSON, the time included', () => {
    const stored = JSON.parse(JSON.stringify(toStoredPayment({ payment }))) as ReturnType<typeof toStoredPayment>;

    expect(fromStoredPayment({ payment: stored })).toEqual(payment);
  });

  it('keeps a missing time missing', () => {
    const stored = toStoredPayment({ payment: { ...payment, occurredAt: null } });

    expect(stored.occurredAt).toBeNull();
    expect(fromStoredPayment({ payment: stored }).occurredAt).toBeNull();
  });
});

describe('readStoredParse', () => {
  it('reads a stored reading', () => {
    expect(readStoredParse({ value: { parser: 'ai', kind: 'debit', confidence: 0.9 } })).toEqual({
      parser: 'ai',
      kind: 'debit',
      confidence: 0.9,
    });
  });

  it.each([
    ['nothing', null],
    ['another parser', { parser: 'regex', kind: 'debit', confidence: 1 }],
    ['a missing kind', { parser: 'ai', confidence: 1 }],
    ['a confidence that is not a number', { parser: 'ai', kind: 'debit', confidence: '1' }],
  ])('reads %s as nothing', (_name, value) => {
    expect(readStoredParse({ value })).toBeNull();
  });
});

describe('park reasons', () => {
  it('splits the reasons that left the text unread from the ones that need approval', () => {
    expect(UNCLASSIFIED_PARK_REASONS).toEqual([
      'sourceNotApproved',
      'aiUnavailable',
      'aiCapReached',
      'aiLimitReached',
      'aiQuotaWait',
    ]);
    expect(FORCE_PARK_REASONS).toEqual(['ownTransfer', 'lowConfidence', 'unverifiedParse']);
  });
});
