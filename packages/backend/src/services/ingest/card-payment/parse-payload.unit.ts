import { describe, expect, it } from '@jest/globals';

import {
  parsePayload,
  readPayloadTime,
  readPayloadTimeOffset,
  readPayloadTimeZone,
  resolvePayloadTime,
} from './parse-payload';

const DAY_MS = 24 * 60 * 60 * 1000;
const receivedAt = new Date('2026-10-17T17:05:00.000Z');
const idempotencyKey = 'a'.repeat(64);

const validBody = {
  amount: '₾47.00',
  merchant: 'Cafe Heart of Lisbon',
  card: 'Example Visa',
  idempotencyKey,
};

const parse = ({ body }: { body: unknown }) => parsePayload({ body, receivedAt });

const expectRejected = ({ body, reason, field }: { body: unknown; reason: string; field: string }) => {
  expect(parse({ body })).toEqual({ ok: false, reason, field });
};

describe('parsePayload', () => {
  describe('a valid payment', () => {
    it('returns the cleaned fields and defaults', () => {
      expect(parse({ body: validBody })).toEqual({
        ok: true,
        kind: 'payment',
        idempotencyKey,
        source: 'card-payment',
        amount: '47',
        rawAmount: '₾47.00',
        amountCurrencyCode: null,
        amountSymbol: '₾',
        explicitCurrency: null,
        merchant: 'Cafe Heart of Lisbon',
        card: 'Example Visa',
        name: null,
        time: receivedAt,
        timeProvided: false,
        timeZone: null,
        timeSource: 'run',
      });
    });

    it('keeps every optional field that was sent', () => {
      const result = parse({
        body: {
          ...validBody,
          amount: 12.5,
          currency: ' eur ',
          name: ' Cafe ',
          source: 'apple-pay',
          time: '2026-10-17T21:04:11+04:00',
        },
      });

      expect(result).toMatchObject({
        ok: true,
        kind: 'payment',
        amount: '12.5',
        rawAmount: '12.5',
        explicitCurrency: 'EUR',
        name: 'Cafe',
        source: 'apple-pay',
        time: new Date('2026-10-17T17:04:11.000Z'),
        timeProvided: true,
      });
    });

    it('collapses whitespace and drops invisible characters in text fields', () => {
      expect(
        parse({ body: { ...validBody, merchant: '  Cafe  Heart ​of\nLisbon ', card: ' Example\tVisa\u0000 ' } }),
      ).toMatchObject({ merchant: 'Cafe Heart of Lisbon', card: 'Example Visa' });
    });

    it('ignores unknown keys', () => {
      expect(parse({ body: { ...validBody, futureField: { nested: true }, dryRun: false } })).toMatchObject({
        ok: true,
        kind: 'payment',
      });
    });

    it('reports the code and symbol found in the amount text', () => {
      expect(parse({ body: { ...validBody, amount: '47,00 GEL' } })).toMatchObject({
        amount: '47',
        amountCurrencyCode: 'GEL',
        amountSymbol: null,
      });
    });

    it('treats a blank name, time and currency as not sent', () => {
      expect(parse({ body: { ...validBody, name: '  ', time: ' ', currency: '' } })).toMatchObject({
        name: null,
        timeProvided: false,
        explicitCurrency: null,
        time: receivedAt,
      });
    });
  });

  describe('the body', () => {
    it.each([
      ['null', null],
      ['a string', 'text'],
      ['an array', [validBody]],
      ['a number', 5],
    ])('rejects %s', (_name, body) => {
      expectRejected({ body, reason: 'invalidBody', field: 'body' });
    });
  });

  describe('the amount', () => {
    it.each([
      ['a zero number', 0, 'zeroAmount'],
      ['zero text', '0.00', 'zeroAmount'],
      ['a negative amount', '-47', 'negativeAmount'],
      ['an empty amount', '', 'invalidAmount'],
      ['text that is not an amount', 'abc', 'invalidAmount'],
      ['a missing amount', undefined, 'invalidAmount'],
    ])('rejects %s', (_name, amount, reason) => {
      expectRejected({ body: { ...validBody, amount }, reason, field: 'amount' });
    });
  });

  describe('the merchant', () => {
    it.each([
      ['a missing merchant', undefined],
      ['an empty merchant', ''],
      ['a whitespace merchant', '  \n '],
      ['a merchant that is not text', 5],
    ])('rejects %s as blank', (_name, merchant) => {
      expectRejected({ body: { ...validBody, merchant }, reason: 'blankMerchant', field: 'merchant' });
    });

    it('accepts 200 characters and rejects 201', () => {
      expect(parse({ body: { ...validBody, merchant: 'm'.repeat(200) } })).toMatchObject({ ok: true });
      expectRejected({
        body: { ...validBody, merchant: 'm'.repeat(201) },
        reason: 'merchantTooLong',
        field: 'merchant',
      });
    });
  });

  describe('the card', () => {
    it('rejects a missing card', () => {
      expectRejected({ body: { ...validBody, card: undefined }, reason: 'blankCard', field: 'card' });
      expectRejected({ body: { ...validBody, card: '  ' }, reason: 'blankCard', field: 'card' });
    });

    it('accepts 100 characters and rejects 101', () => {
      expect(parse({ body: { ...validBody, card: 'c'.repeat(100) } })).toMatchObject({ ok: true });
      expectRejected({ body: { ...validBody, card: 'c'.repeat(101) }, reason: 'cardTooLong', field: 'card' });
    });
  });

  describe('the name', () => {
    it('accepts 200 characters and rejects 201', () => {
      expect(parse({ body: { ...validBody, name: 'n'.repeat(200) } })).toMatchObject({ ok: true });
      expectRejected({ body: { ...validBody, name: 'n'.repeat(201) }, reason: 'nameTooLong', field: 'name' });
    });

    it('ignores a name that is not text', () => {
      expect(parse({ body: { ...validBody, name: 42 } })).toMatchObject({ ok: true, name: null });
    });
  });

  describe('the currency', () => {
    it('rejects a currency that is not text', () => {
      expectRejected({ body: { ...validBody, currency: 5 }, reason: 'invalidCurrency', field: 'currency' });
    });
  });

  describe('the source', () => {
    it.each(['apple-pay', 'a', 'x'.repeat(32), 'bank-2'])('accepts %s', (source) => {
      expect(parse({ body: { ...validBody, source } })).toMatchObject({ ok: true, source });
    });

    it.each([
      ['upper case', 'Apple'],
      ['an underscore', 'apple_pay'],
      ['a space', 'apple pay'],
      ['33 characters', 'x'.repeat(33)],
      ['an empty string', ''],
      ['a number', 5],
    ])('rejects %s', (_name, source) => {
      expectRejected({ body: { ...validBody, source }, reason: 'invalidSource', field: 'source' });
    });

    it('defaults a null source', () => {
      expect(parse({ body: { ...validBody, source: null } })).toMatchObject({ ok: true, source: 'card-payment' });
    });
  });

  describe('the idempotency key', () => {
    it.each([
      ['a 64-character hex', 'f'.repeat(64)],
      ['8 characters', 'abcd1234'],
      ['128 characters', 'k'.repeat(128)],
      ['a UUID', '3f2b8c1e-7d4a-4b9e-9c3a-1e5f6a7b8c9d'],
      ['punctuation', 'a!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'],
    ])('accepts %s', (_name, key) => {
      expect(parse({ body: { ...validBody, idempotencyKey: key } })).toMatchObject({ ok: true, idempotencyKey: key });
    });

    it.each([
      ['7 characters', 'abcd123'],
      ['129 characters', 'k'.repeat(129)],
      ['a space', 'abcd 1234'],
      ['a lari sign', 'abcd1234₾'],
      ['a non-breaking space', 'abcd 1234'],
      ['a newline', 'abcd1234\n'],
      ['a number', 12345678],
      ['a missing key', undefined],
    ])('rejects %s', (_name, key) => {
      expectRejected({
        body: { ...validBody, idempotencyKey: key },
        reason: 'invalidIdempotencyKey',
        field: 'idempotencyKey',
      });
    });
  });

  describe('the time window, measured from receivedAt', () => {
    const at = ({ offsetMs }: { offsetMs: number }) => new Date(receivedAt.getTime() + offsetMs).toISOString();

    it('accepts a time up to 5 minutes ahead and rejects more', () => {
      expect(parse({ body: { ...validBody, time: at({ offsetMs: 5 * 60_000 }) } })).toMatchObject({ ok: true });
      expectRejected({
        body: { ...validBody, time: at({ offsetMs: 5 * 60_000 + 1000 }) },
        reason: 'timeInFuture',
        field: 'time',
      });
    });

    it('accepts a time up to 30 days back and rejects more', () => {
      expect(parse({ body: { ...validBody, time: at({ offsetMs: -30 * DAY_MS }) } })).toMatchObject({ ok: true });
      expectRejected({
        body: { ...validBody, time: at({ offsetMs: -30 * DAY_MS - 1000 }) },
        reason: 'timeTooOld',
        field: 'time',
      });
    });

    it('measures from receivedAt, not from now: a retry weeks later keeps passing', () => {
      const oldReceivedAt = new Date(Date.now() - 35 * DAY_MS);
      const time = new Date(oldReceivedAt.getTime() - 5 * DAY_MS).toISOString();

      // 40 days before now, which is out of a 30-day window measured from now.
      expect(Date.now() - new Date(time).getTime()).toBeGreaterThan(30 * DAY_MS);
      expect(parsePayload({ body: { ...validBody, time }, receivedAt: oldReceivedAt })).toMatchObject({
        ok: true,
        time: new Date(time),
      });
    });

    it('defaults to receivedAt', () => {
      expect(parse({ body: validBody })).toMatchObject({ time: receivedAt, timeProvided: false });
    });

    it('reads the time as the shortcut run time unless the request says it belongs to the transaction', () => {
      const time = '2026-10-17T21:04:11+04:00';

      expect(parse({ body: { ...validBody, time } })).toMatchObject({ timeSource: 'run' });
      expect(parse({ body: { ...validBody, time, timeSource: 'run' } })).toMatchObject({ timeSource: 'run' });
      expect(parse({ body: { ...validBody, time, timeSource: 'transaction' } })).toMatchObject({
        timeSource: 'transaction',
      });
      expect(parse({ body: { ...validBody, time, timeSource: 'nonsense' } })).toMatchObject({ timeSource: 'run' });
    });
  });

  describe('the time format', () => {
    it.each([
      ['Z', '2026-10-17T17:04:11Z', '2026-10-17T17:04:11.000Z'],
      ['a colon offset', '2026-10-17T21:04:11+04:00', '2026-10-17T17:04:11.000Z'],
      ['a compact offset', '2026-10-17T21:04:11+0400', '2026-10-17T17:04:11.000Z'],
      ['an hour-only offset', '2026-10-17T21:04:11+04', '2026-10-17T17:04:11.000Z'],
      ['a negative offset', '2026-10-17T10:04:11-07:00', '2026-10-17T17:04:11.000Z'],
      ['no seconds', '2026-10-17T21:04+04:00', '2026-10-17T17:04:00.000Z'],
      ['fractional seconds', '2026-10-17T17:04:11.123456Z', '2026-10-17T17:04:11.123Z'],
      ['a space instead of T', '2026-10-17 21:04:11 +04:00'.replace(' +', '+'), '2026-10-17T17:04:11.000Z'],
    ])('accepts %s', (_name, time, iso) => {
      expect(parse({ body: { ...validBody, time } })).toMatchObject({ ok: true, time: new Date(iso) });
    });

    it.each([
      ['no offset', '2026-10-17T21:04:11'],
      ['a date only', '2026-10-17'],
      ['an impossible day', '2026-02-30T10:00:00Z'],
      ['an impossible month', '2026-13-01T10:00:00Z'],
      ['an impossible hour', '2026-10-17T24:00:00Z'],
      ['an impossible offset', '2026-10-17T10:00:00+25:00'],
      ['text', 'yesterday'],
      ['a number', 1760720651],
    ])('rejects %s', (_name, time) => {
      expectRejected({ body: { ...validBody, time }, reason: 'invalidTime', field: 'time' });
    });
  });

  describe('check order', () => {
    it('reports the amount before the merchant: the empty-run glitch sends both as bad', () => {
      expectRejected({ body: { ...validBody, amount: '0', merchant: '' }, reason: 'zeroAmount', field: 'amount' });
    });

    it('reports the idempotency key first', () => {
      expectRejected({
        body: { ...validBody, idempotencyKey: 'short', amount: '0' },
        reason: 'invalidIdempotencyKey',
        field: 'idempotencyKey',
      });
    });
  });

  describe('a dry run', () => {
    it('needs no other field', () => {
      expect(parse({ body: { dryRun: true } })).toEqual({ ok: true, kind: 'dryRun', card: null });
    });

    it('reads a usable card and ignores invalid payment fields', () => {
      expect(parse({ body: { dryRun: true, card: ' Example  Visa ', amount: '0', idempotencyKey: 'x' } })).toEqual({
        ok: true,
        kind: 'dryRun',
        card: 'Example Visa',
      });
    });

    it('drops a card that is blank, not text or too long', () => {
      expect(parse({ body: { dryRun: true, card: '  ' } })).toMatchObject({ card: null });
      expect(parse({ body: { dryRun: true, card: 5 } })).toMatchObject({ card: null });
      expect(parse({ body: { dryRun: true, card: 'c'.repeat(101) } })).toMatchObject({ card: null });
    });

    it('is only a dry run for the boolean true', () => {
      expect(parse({ body: { ...validBody, dryRun: 'true' } })).toMatchObject({ kind: 'payment' });
    });
  });
});

describe('readPayloadTime', () => {
  const fallback = new Date('2026-10-17T17:05:00.000Z');

  it.each([
    ['a blank time', ''],
    ['a whitespace time', '   '],
    ['a missing time', undefined],
    ['a null time', null],
    ['a malformed time', 'yesterday'],
    ['a time without an offset', '2026-10-17T12:00:00'],
    ['a number', 1760000000],
    ['an impossible date', '2026-02-30T12:00:00Z'],
  ])('falls back for %s', (_name, value) => {
    expect(readPayloadTime({ value, fallback })).toBe(fallback.toISOString());
  });

  it('returns a valid time normalized to UTC', () => {
    expect(readPayloadTime({ value: '2026-10-17T21:00:00+04:00', fallback })).toBe('2026-10-17T17:00:00.000Z');
  });
});

describe('resolvePayloadTime offsets', () => {
  const resolve = ({ value }: { value: unknown }) => resolvePayloadTime({ value, receivedAt });

  it.each([
    ['+04:00', '2026-10-17T21:04:11+04:00', 240, true],
    ['-0530', '2026-10-17T11:04:11-0530', -330, true],
    ['Z', '2026-10-17T17:04:11Z', 0, false],
    ['+00:00', '2026-10-17T17:04:11+00:00', 0, true],
  ])('reads the offset of %s', (_name, value, offsetMinutes, offsetStated) => {
    expect(resolve({ value })).toMatchObject({ ok: true, offsetMinutes, offsetStated });
  });

  it('has no offset for a blank time', () => {
    expect(resolve({ value: '' })).toMatchObject({ ok: true, offsetMinutes: null, offsetStated: false });
  });

  it('reads a stored payload offset only when the time wrote one', () => {
    expect(readPayloadTimeOffset({ value: '2026-10-17T21:04:11+04:00' })).toBe(240);
    expect(readPayloadTimeOffset({ value: '2026-10-17T17:04:11Z' })).toBeNull();
    expect(readPayloadTimeOffset({ value: undefined })).toBeNull();
  });
});

describe('the timeZone key', () => {
  it('keeps a valid IANA zone', () => {
    expect(parse({ body: { ...validBody, timeZone: ' Asia/Dubai ' } })).toMatchObject({
      ok: true,
      timeZone: 'Asia/Dubai',
    });
  });

  it('treats a blank zone as none', () => {
    expect(parse({ body: { ...validBody, timeZone: '' } })).toMatchObject({ ok: true, timeZone: null });
  });

  it.each(['+04:00', 'Mars/Base', 12])('refuses %s as invalidTimeZone', (timeZone) => {
    expectRejected({ body: { ...validBody, timeZone }, reason: 'invalidTimeZone', field: 'timeZone' });
  });

  it('reads a stored zone and ignores an invalid one', () => {
    expect(readPayloadTimeZone({ value: 'Asia/Dubai' })).toBe('Asia/Dubai');
    expect(readPayloadTimeZone({ value: 'nope' })).toBeNull();
  });
});
