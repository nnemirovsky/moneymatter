import { i18nextReady } from '@i18n/index';
import { beforeAll, describe, expect, it } from '@jest/globals';

import {
  type NotificationParseOutput,
  NOTIFICATION_MIN_CONFIDENCE,
  classifyNotification,
  notificationParseSchema,
} from './classify-notification';
import { notificationFixtures } from './fixtures/notifications';
import { prefilterNotification } from './prefilter-notification';

const PAYEE_ID = '11111111-1111-4111-8111-111111111111';
const candidateIds = new Map([['p1', PAYEE_ID]]);

const baseOutput = (overrides: Partial<NotificationParseOutput> = {}): NotificationParseOutput => ({
  kind: 'debit',
  stage: 'payment',
  isOwnAccountTransfer: false,
  amount: '43.60',
  currency: 'GEL',
  originalAmount: null,
  originalCurrency: null,
  merchant: 'WOLT.COM TBILISI',
  payee: null,
  cardName: null,
  cardLastDigits: null,
  balanceAfter: null,
  occurredAt: null,
  confidence: 0.9,
  ...overrides,
});

const classify = (overrides: Partial<NotificationParseOutput> = {}) =>
  classifyNotification({ output: baseOutput(overrides), candidateIds });

const paymentOf = (overrides: Partial<NotificationParseOutput> = {}) => {
  const result = classify(overrides);
  if (result.verdict === 'ignore' || !result.payment) throw new Error('expected a payment');

  return result.payment;
};

describe('kind mapping', () => {
  it('logs a debit and a credit', () => {
    expect(classify({ kind: 'debit' })).toMatchObject({ verdict: 'payment', parser: 'ai', kind: 'debit' });
    expect(classify({ kind: 'credit' })).toMatchObject({ verdict: 'payment', kind: 'credit' });
  });

  it.each(['declined', 'security', 'promo', 'info', 'other'] as const)('ignores %s under its own name', (kind) => {
    expect(classify({ kind })).toEqual({ parser: 'ai', kind, confidence: 0.9, verdict: 'ignore', reason: kind });
  });

  it('ignores a non-payment whatever the confidence, since there is nothing to log', () => {
    expect(classify({ kind: 'promo', confidence: 0.2 })).toMatchObject({ verdict: 'ignore', reason: 'promo' });
  });

  it('parks an own-account transfer with what was read, so a forced retry can log it', () => {
    const result = classify({ isOwnAccountTransfer: true });

    expect(result).toMatchObject({ verdict: 'park', reason: 'ownTransfer', payment: { amount: '43.6' } });
  });

  it('does not park an own-account flag on a non-payment', () => {
    expect(classify({ kind: 'info', isOwnAccountTransfer: true })).toMatchObject({ verdict: 'ignore' });
  });
});

describe('confidence', () => {
  it('parks a payment under the bar as lowConfidence, keeping the payment', () => {
    const result = classify({ confidence: 0.59 });

    expect(result).toMatchObject({ verdict: 'park', reason: 'lowConfidence', confidence: 0.59 });
    expect(result.verdict === 'park' && result.payment?.amount).toBe('43.6');
  });

  it('logs a payment at the bar', () => {
    expect(NOTIFICATION_MIN_CONFIDENCE).toBe(0.6);
    expect(classify({ confidence: 0.6 }).verdict).toBe('payment');
  });

  it('clamps the confidence into 0..1', () => {
    expect(classify({ confidence: 7 })).toMatchObject({ verdict: 'payment', confidence: 1 });
    expect(classify({ confidence: -2 })).toMatchObject({ verdict: 'park', confidence: 0 });
  });

  it('treats a confidence that is not a number as zero', () => {
    expect(classify({ confidence: Number.NaN })).toMatchObject({
      verdict: 'park',
      reason: 'lowConfidence',
      confidence: 0,
    });
  });

  it('puts an own-account transfer ahead of a low confidence', () => {
    expect(classify({ isOwnAccountTransfer: true, confidence: 0.1 })).toMatchObject({ reason: 'ownTransfer' });
  });
});

describe('amounts', () => {
  it.each([
    ['43.60', '43.6'],
    ['1.500', '1.5'],
    ['0.500', '0.5'],
    ['1,234.50', '1234.5'],
    ['1 250,00', '1250'],
    ['007', '7'],
  ])('reads "%s" as %s', (amount, expected) => {
    expect(paymentOf({ amount }).amount).toBe(expected);
  });

  it('takes the currency out of an amount written with a code when the model gave none', () => {
    expect(paymentOf({ amount: '43.60 GEL', currency: null }).currencyCode).toBe('GEL');
  });

  it.each(['abc', '', '0', '0.00', '-5', null])('parks a payment whose amount is %p, with nothing to log', (amount) => {
    expect(classify({ amount })).toMatchObject({ verdict: 'park', reason: 'lowConfidence', payment: null });
  });

  it('keeps a payment with no currency, which the account settles', () => {
    expect(paymentOf({ currency: null }).currencyCode).toBeNull();
  });

  it.each([
    ['gel', 'GEL'],
    [' usd ', 'USD'],
    ['€', null],
    ['EURO', null],
    ['', null],
  ])('reads the currency %p as %p', (currency, expected) => {
    expect(paymentOf({ currency }).currencyCode).toBe(expected);
  });

  it('keeps an original amount only with a different currency', () => {
    expect(paymentOf({ originalAmount: '41.80', originalCurrency: 'USD', currency: 'EUR' })).toMatchObject({
      originalAmount: '41.8',
      originalCurrencyCode: 'USD',
    });
    expect(paymentOf({ originalAmount: '41.80', originalCurrency: 'GEL' })).toMatchObject({
      originalAmount: null,
      originalCurrencyCode: null,
    });
    expect(paymentOf({ originalAmount: '41.80', originalCurrency: null })).toMatchObject({ originalAmount: null });
    expect(paymentOf({ originalAmount: null, originalCurrency: 'USD' })).toMatchObject({ originalCurrencyCode: null });
    expect(paymentOf({ originalAmount: 'many', originalCurrency: 'USD' })).toMatchObject({ originalAmount: null });
  });
});

describe('invalid fields are dropped', () => {
  it.each([
    ['*4321', '4321'],
    ['•••• 12345678', '12345678'],
    ['12', null],
    ['123456789', null],
    ['abcd', null],
  ])('reads the card digits %p as %p', (cardLastDigits, expected) => {
    expect(paymentOf({ cardLastDigits }).cardLastDigits).toBe(expected);
  });

  it('keeps a valid time and drops one that is not a date', () => {
    expect(paymentOf({ occurredAt: '2026-10-20T14:30:00' }).occurredAt).toEqual(new Date('2026-10-20T14:30:00'));
    expect(paymentOf({ occurredAt: 'yesterday' }).occurredAt).toBeNull();
    expect(paymentOf({ occurredAt: '2026-13-45' }).occurredAt).toBeNull();
  });

  it('cleans the merchant and the card name', () => {
    expect(paymentOf({ merchant: '  WOLT.COM \n TBILISI ', cardName: ' Visa  Classic ' })).toMatchObject({
      merchant: 'WOLT.COM TBILISI',
      cardName: 'Visa Classic',
    });
    expect(paymentOf({ merchant: '   ' }).merchant).toBeNull();
  });

  it('cuts an oversize merchant', () => {
    expect(paymentOf({ merchant: 'x'.repeat(500) }).merchant).toHaveLength(200);
  });
});

describe('payee choice', () => {
  it('maps a candidate id the model was shown to its payee', () => {
    expect(paymentOf({ payee: { candidateId: 'p1', newName: null } }).payee).toEqual({
      type: 'candidate',
      payeeId: PAYEE_ID,
    });
    expect(paymentOf({ payee: { candidateId: ' p1 ', newName: null } }).payee).toEqual({
      type: 'candidate',
      payeeId: PAYEE_ID,
    });
  });

  it('drops a candidate id outside the list', () => {
    expect(paymentOf({ payee: { candidateId: 'p9', newName: null } }).payee).toBeNull();
    expect(paymentOf({ payee: { candidateId: PAYEE_ID, newName: null } }).payee).toBeNull();
  });

  it('falls back to the new name when the candidate id is invalid', () => {
    expect(paymentOf({ payee: { candidateId: 'p9', newName: 'Wolt' } }).payee).toEqual({ type: 'new', name: 'Wolt' });
  });

  it('prefers a valid candidate over a new name', () => {
    expect(paymentOf({ payee: { candidateId: 'p1', newName: 'Wolt' } }).payee).toEqual({
      type: 'candidate',
      payeeId: PAYEE_ID,
    });
  });

  it('gives a clean new name and nothing for a blank one', () => {
    expect(paymentOf({ payee: { candidateId: null, newName: ' Coffee  Lab ' } }).payee).toEqual({
      type: 'new',
      name: 'Coffee Lab',
    });
    expect(paymentOf({ payee: { candidateId: null, newName: ' ' } }).payee).toBeNull();
    expect(paymentOf({ payee: null }).payee).toBeNull();
  });
});

const balance = (amount: string, currency: string | null = 'GEL') => ({
  amount,
  currency,
  scopeHint: 'total' as const,
});

describe('balanceAfter', () => {
  it('reads the amount, the currency and the scope', () => {
    expect(paymentOf({ balanceAfter: balance('3,040.15') }).balanceAfter).toEqual({
      amount: '3040.15',
      currencyCode: 'GEL',
      scopeHint: 'total',
    });
  });

  it('keeps a zero balance and a negative one', () => {
    expect(paymentOf({ balanceAfter: balance('0.00') }).balanceAfter?.amount).toBe('0');
    expect(paymentOf({ balanceAfter: balance('-35.20') }).balanceAfter?.amount).toBe('-35.2');
    expect(paymentOf({ balanceAfter: balance('(35.20)') }).balanceAfter?.amount).toBe('-35.2');
  });

  it('takes the currency out of the amount text when the model gave none', () => {
    expect(paymentOf({ balanceAfter: balance('410.55 GEL', null) }).balanceAfter).toMatchObject({
      amount: '410.55',
      currencyCode: 'GEL',
    });
  });

  it('drops a balance with no currency or an unreadable amount', () => {
    expect(paymentOf({ balanceAfter: balance('410.55', null) }).balanceAfter).toBeNull();
    expect(paymentOf({ balanceAfter: balance('plenty') }).balanceAfter).toBeNull();
  });
});

describe('the schema', () => {
  it('accepts a complete answer and refuses an unknown kind', () => {
    expect(notificationParseSchema.safeParse(baseOutput()).success).toBe(true);
    expect(notificationParseSchema.safeParse({ ...baseOutput(), kind: 'refund' }).success).toBe(false);
  });
});

describe('the fixtures', () => {
  beforeAll(async () => {
    await i18nextReady;
  });

  it.each(notificationFixtures.filter((fixture) => fixture.channel !== 'wallet'))(
    '$id: the prefilter does what the fixture says',
    (fixture) => {
      const result = prefilterNotification({
        bundleId: fixture.bundleId,
        appName: fixture.appName,
        title: fixture.title,
        subtitle: fixture.subtitle,
        body: fixture.body,
        strictness: 'standard',
      });

      expect(result.pass ? 'pass' : result.reason).toBe(fixture.prefilter);
    },
  );

  it.each(notificationFixtures)('$id: the model answer classifies as a verdict', (fixture) => {
    const result = classifyNotification({ output: fixture.answer, candidateIds });

    if (fixture.answer.kind === 'debit' || fixture.answer.kind === 'credit') {
      expect(result.verdict).toBe(fixture.answer.isOwnAccountTransfer ? 'park' : 'payment');
    } else {
      expect(result).toMatchObject({ verdict: 'ignore', reason: fixture.answer.kind });
    }
  });

  it('keeps a stated foreign-currency amount and a total balance apart', () => {
    const fixture = notificationFixtures.find((candidate) => candidate.id === 'tbc-en-foreign-currency')!;
    const result = classifyNotification({ output: fixture.answer, candidateIds });

    expect(result.verdict === 'payment' && result.payment).toMatchObject({
      amount: '12.5',
      currencyCode: 'USD',
      balanceAfter: { amount: '3040.15', currencyCode: 'GEL', scopeHint: 'total' },
    });
  });
});
