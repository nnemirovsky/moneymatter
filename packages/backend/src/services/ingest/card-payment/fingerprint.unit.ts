import { describe, expect, it } from '@jest/globals';

import { computeFingerprint } from './fingerprint';

const body = { card: 'Example Visa', amount: '47.00', currency: 'GEL', merchant: 'Cafe Heart of Lisbon' };

describe('computeFingerprint', () => {
  it('is a SHA-256 hex digest', () => {
    expect(computeFingerprint({ body })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable over key order', () => {
    const reordered = { merchant: body.merchant, currency: body.currency, amount: body.amount, card: body.card };

    expect(computeFingerprint({ body: reordered })).toBe(computeFingerprint({ body }));
  });

  it('ignores surrounding and repeated whitespace', () => {
    const spaced = {
      card: '  Example   Visa ',
      amount: ' 47.00 ',
      currency: ' GEL ',
      merchant: '\nCafe   Heart of  Lisbon ',
    };

    expect(computeFingerprint({ body: spaced })).toBe(computeFingerprint({ body }));
  });

  it('ignores the card label spelling that normalization folds away', () => {
    expect(computeFingerprint({ body: { ...body, card: 'example visa •••• 1234' } })).toBe(
      computeFingerprint({ body }),
    );
  });

  it('tells a JSON number from a string, because the parser reads 1.234 and "1.234" differently', () => {
    const asNumber = { ...body, amount: 1.234 };
    const asString = { ...body, amount: '1.234' };

    expect(computeFingerprint({ body: asNumber })).not.toBe(computeFingerprint({ body: asString }));
    expect(computeFingerprint({ body: { ...asNumber } })).toBe(computeFingerprint({ body: asNumber }));
  });

  it('ignores time, name, idempotency key, source and unknown keys', () => {
    const extra = {
      ...body,
      time: '2026-10-17T21:04:11+04:00',
      name: 'Cafe',
      idempotencyKey: 'a'.repeat(64),
      source: 'apple-pay',
      other: 1,
    };

    expect(computeFingerprint({ body: extra })).toBe(computeFingerprint({ body }));
  });

  it.each([
    ['amount', { amount: '47.50' }],
    ['currency', { currency: 'EUR' }],
    ['merchant', { merchant: 'Cafe Heart' }],
    ['merchant case', { merchant: 'cafe heart of lisbon' }],
    ['card', { card: 'Example Mastercard' }],
  ])('changes with the %s', (_name, change) => {
    expect(computeFingerprint({ body: { ...body, ...change } })).not.toBe(computeFingerprint({ body }));
  });

  it('does not throw on a body that is not an object, and treats missing fields as empty', () => {
    const empty = computeFingerprint({ body: {} });

    expect(computeFingerprint({ body: null })).toBe(empty);
    expect(computeFingerprint({ body: 'text' })).toBe(empty);
    expect(computeFingerprint({ body: [1] })).toBe(empty);
    expect(computeFingerprint({ body: { card: 5, amount: { x: 1 }, merchant: null } })).toBe(empty);
  });
});
