import {
  AMOUNT_GATE_PATTERNS,
  decodeSetupCode,
  encodeSetupCode,
  GATE_STRICTNESS_LEVELS,
  SETUP_CODE_MAX_LENGTH,
  SETUP_CODE_PREFIX,
  SETUP_CODE_QR_MAX_LENGTH,
  SetupCodeError,
} from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

const URL_VALUE = 'https://money.example.com/api/v1/ingest/card-payment';
const TOKEN = 'mm_ingest_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

const encodeRaw = ({ value }: { value: unknown }) =>
  `${SETUP_CODE_PREFIX}${Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64')}`;

const decodeFailure = ({ code }: { code: string }): SetupCodeError | undefined => {
  try {
    decodeSetupCode({ code });
  } catch (error) {
    return error instanceof SetupCodeError ? error : undefined;
  }
  return undefined;
};

const readJson = ({ code }: { code: string }) =>
  JSON.parse(Buffer.from(code.slice(SETUP_CODE_PREFIX.length), 'base64').toString('utf8'));

describe('card-payment setup code', () => {
  describe('encodeSetupCode', () => {
    it('round-trips url and token without Cloudflare Access fields', () => {
      const code = encodeSetupCode({ url: URL_VALUE, token: TOKEN });

      expect(decodeSetupCode({ code })).toEqual({ url: URL_VALUE, token: TOKEN });
    });

    it('round-trips the Cloudflare Access fields', () => {
      const code = encodeSetupCode({
        url: URL_VALUE,
        token: TOKEN,
        cfAccessId: 'abc123.access',
        cfAccessSecret: 'secret-value',
      });

      expect(decodeSetupCode({ code })).toEqual({
        url: URL_VALUE,
        token: TOKEN,
        cfAccessId: 'abc123.access',
        cfAccessSecret: 'secret-value',
      });
    });

    it('prefixes v1. and writes standard base64 with padding, never base64url', () => {
      // Runs of `?` and `>` encode to `/` and `+`, the characters where base64 and base64url differ.
      const code = encodeSetupCode({
        url: `${URL_VALUE}?a=~~~&b=${'?'.repeat(9)}${'>'.repeat(9)}`,
        token: `${TOKEN}${'?'.repeat(9)}${'>'.repeat(9)}`,
        cfAccessId: 'ü'.repeat(7),
        cfAccessSecret: 's',
      });

      expect(code.startsWith('v1.')).toBe(true);

      const body = code.slice('v1.'.length);
      expect(body).toMatch(/[+/]/);
      expect(body).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(body).not.toMatch(/[-_]/);
      expect(body.length % 4).toBe(0);
    });

    it('writes the version and leaves the Cloudflare fields out when they are not set', () => {
      const code = encodeSetupCode({ url: URL_VALUE, token: TOKEN });

      const json = JSON.parse(Buffer.from(code.slice(SETUP_CODE_PREFIX.length), 'base64').toString('utf8'));

      expect(json).toEqual({ v: 1, url: URL_VALUE, token: TOKEN });
    });

    it('rejects a Cloudflare id without a secret, and the other way round', () => {
      expect(() => encodeSetupCode({ url: URL_VALUE, token: TOKEN, cfAccessId: 'id' })).toThrow(SetupCodeError);
      expect(() => encodeSetupCode({ url: URL_VALUE, token: TOKEN, cfAccessSecret: 'secret' })).toThrow(SetupCodeError);
    });

    it('rejects a non-http(s) url', () => {
      for (const url of ['ftp://money.example.com/x', 'javascript:alert(1)', 'not a url', '']) {
        expect(() => encodeSetupCode({ url, token: TOKEN })).toThrow(SetupCodeError);
      }
    });

    it('rejects a code that would exceed the size limit', () => {
      expect(() =>
        encodeSetupCode({ url: `https://money.example.com/${'a'.repeat(SETUP_CODE_MAX_LENGTH)}`, token: TOKEN }),
      ).toThrow(SetupCodeError);
    });

    it('keeps a code without a gate small enough for a QR code', () => {
      const code = encodeSetupCode({
        url: URL_VALUE,
        token: TOKEN,
        cfAccessId: 'abc123.access',
        cfAccessSecret: 'secret-value',
      });

      expect(code.length).toBeLessThan(SETUP_CODE_QR_MAX_LENGTH);
    });
  });

  describe('the gate', () => {
    it('round-trips a gate regex', () => {
      const code = encodeSetupCode({ url: URL_VALUE, token: TOKEN, gate: AMOUNT_GATE_PATTERNS.strict });

      expect(decodeSetupCode({ code })).toEqual({ url: URL_VALUE, token: TOKEN, gate: AMOUNT_GATE_PATTERNS.strict });
    });

    it('writes the gate next to the other fields and leaves it out when there is none', () => {
      const withGate = encodeSetupCode({ url: URL_VALUE, token: TOKEN, gate: '\\d+' });
      const without = encodeSetupCode({ url: URL_VALUE, token: TOKEN });

      expect(readJson({ code: withGate })).toEqual({ v: 1, url: URL_VALUE, token: TOKEN, gate: '\\d+' });
      expect(readJson({ code: without })).not.toHaveProperty('gate');
    });

    it('still decodes a code that was made before the gate existed', () => {
      const code = encodeRaw({ value: { v: 1, url: URL_VALUE, token: TOKEN, cfAccessId: 'id', cfAccessSecret: 's' } });

      expect(decodeSetupCode({ code })).toEqual({
        url: URL_VALUE,
        token: TOKEN,
        cfAccessId: 'id',
        cfAccessSecret: 's',
      });
    });

    it.each(GATE_STRICTNESS_LEVELS)('fits the %s pattern together with the Cloudflare pair', (level) => {
      const code = encodeSetupCode({
        url: URL_VALUE,
        token: TOKEN,
        cfAccessId: 'abc123.access',
        cfAccessSecret: 'secret-value',
        gate: AMOUNT_GATE_PATTERNS[level],
      });

      expect(code.length).toBeLessThanOrEqual(SETUP_CODE_MAX_LENGTH);
      expect(decodeSetupCode({ code }).gate).toBe(AMOUNT_GATE_PATTERNS[level]);
    });

    it('rejects a gate that is empty, not text or longer than the limit', () => {
      for (const gate of ['', 7, 'x'.repeat(4097)]) {
        expect(() => encodeSetupCode({ url: URL_VALUE, token: TOKEN, gate: gate as string })).toThrow(SetupCodeError);
      }
      expect(
        decodeFailure({ code: encodeRaw({ value: { v: 1, url: URL_VALUE, token: TOKEN, gate: 3 } }) })?.reason,
      ).toBe('invalidGate');
    });
  });

  describe('decodeSetupCode', () => {
    it('rejects a missing or wrong prefix', () => {
      const valid = encodeSetupCode({ url: URL_VALUE, token: TOKEN });
      const body = valid.slice(SETUP_CODE_PREFIX.length);

      expect(decodeFailure({ code: body })?.reason).toBe('badPrefix');
      expect(decodeFailure({ code: `v2.${body}` })?.reason).toBe('badPrefix');
      expect(decodeFailure({ code: '' })?.reason).toBe('badPrefix');
    });

    it('rejects an unknown payload version', () => {
      const code = encodeRaw({ value: { v: 2, url: URL_VALUE, token: TOKEN } });

      expect(decodeFailure({ code })?.reason).toBe('unsupportedVersion');
    });

    it('rejects a payload with no version', () => {
      const code = encodeRaw({ value: { url: URL_VALUE, token: TOKEN } });

      expect(decodeFailure({ code })?.reason).toBe('unsupportedVersion');
    });

    it('rejects input that is not base64', () => {
      expect(decodeFailure({ code: 'v1.@@@not-base64@@@' })?.reason).toBe('badEncoding');
      expect(decodeFailure({ code: 'v1.abc' })?.reason).toBe('badEncoding');
    });

    it('rejects base64url, which the Shortcuts decoder does not read', () => {
      const code = encodeRaw({ value: { v: 1, url: `${URL_VALUE}?q=${'?'.repeat(9)}${'>'.repeat(9)}`, token: TOKEN } });
      const urlSafe = code.replaceAll('+', '-').replaceAll('/', '_');

      expect(code).toMatch(/[+/]/);
      expect(decodeFailure({ code: urlSafe })?.reason).toBe('badEncoding');
    });

    it('rejects bad JSON and JSON that is not an object', () => {
      expect(decodeFailure({ code: encodeRaw({ value: '{not json' }) })?.reason).toBe('badJson');
      expect(decodeFailure({ code: encodeRaw({ value: '[1,2]' }) })?.reason).toBe('badJson');
      expect(decodeFailure({ code: encodeRaw({ value: 'null' }) })?.reason).toBe('badJson');
    });

    it('rejects a missing or empty url and token', () => {
      expect(decodeFailure({ code: encodeRaw({ value: { v: 1, token: TOKEN } }) })?.reason).toBe('missingUrl');
      expect(decodeFailure({ code: encodeRaw({ value: { v: 1, url: '', token: TOKEN } }) })?.reason).toBe('missingUrl');
      expect(decodeFailure({ code: encodeRaw({ value: { v: 1, url: URL_VALUE } }) })?.reason).toBe('missingToken');
      expect(decodeFailure({ code: encodeRaw({ value: { v: 1, url: URL_VALUE, token: '' } }) })?.reason).toBe(
        'missingToken',
      );
    });

    it('rejects a non-http(s) url', () => {
      const code = encodeRaw({ value: { v: 1, url: 'ftp://money.example.com/x', token: TOKEN } });

      expect(decodeFailure({ code })?.reason).toBe('invalidUrl');
    });

    it('rejects Cloudflare fields that are not a complete pair of strings', () => {
      expect(
        decodeFailure({ code: encodeRaw({ value: { v: 1, url: URL_VALUE, token: TOKEN, cfAccessId: 'id' } }) })?.reason,
      ).toBe('invalidAccessHeaders');
      expect(
        decodeFailure({
          code: encodeRaw({ value: { v: 1, url: URL_VALUE, token: TOKEN, cfAccessId: 1, cfAccessSecret: 'x' } }),
        })?.reason,
      ).toBe('invalidAccessHeaders');
    });

    it('rejects input over the size limit before decoding it', () => {
      const oversize = `${SETUP_CODE_PREFIX}${'A'.repeat(SETUP_CODE_MAX_LENGTH)}`;

      expect(oversize.length).toBeGreaterThan(SETUP_CODE_MAX_LENGTH);
      expect(decodeFailure({ code: oversize })?.reason).toBe('tooLarge');
    });

    it('never puts the secret in the error message', () => {
      const error = decodeFailure({ code: encodeRaw({ value: { v: 2, url: URL_VALUE, token: TOKEN } }) });

      expect(error?.message).not.toContain(TOKEN);
    });
  });
});
