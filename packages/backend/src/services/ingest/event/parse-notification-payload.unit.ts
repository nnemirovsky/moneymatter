import { NOTIFICATION_RAW_MAX_BYTES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import { parseNotificationPayload, readEventKind } from './parse-notification-payload';

const RECEIVED_AT = new Date('2026-10-20T12:00:00.000Z');

const body = (overrides: Record<string, unknown> = {}) => ({
  kind: 'notification',
  idempotencyKey: 'key-0123456789',
  app: 'TBC Bank',
  bundleId: 'ge.tbc.app',
  title: 'TBC Bank',
  subtitle: 'Wolt',
  body: 'GEL 43.60',
  ...overrides,
});

const parse = ({ overrides = {} }: { overrides?: Record<string, unknown> } = {}) =>
  parseNotificationPayload({ body: body(overrides), receivedAt: RECEIVED_AT });

describe('readEventKind', () => {
  it.each(['walletTransaction', 'notification'] as const)('reads %s', (kind) => {
    expect(readEventKind({ body: { kind } })).toBe(kind);
  });

  it.each([
    ['a missing kind', {}],
    ['an unknown kind', { kind: 'sms' }],
    ['a non-string kind', { kind: 1 }],
    ['a kind in another case', { kind: 'Notification' }],
  ])('refuses %s instead of guessing', (_name, value) => {
    expect(readEventKind({ body: value })).toBeNull();
  });

  it.each([null, undefined, 'notification', ['notification'], 7])('refuses a body that is %p', (value) => {
    expect(readEventKind({ body: value })).toBeNull();
  });
});

describe('parseNotificationPayload', () => {
  it('reads the fields of a notification', () => {
    const result = parse();

    expect(result).toEqual({
      ok: true,
      notification: {
        idempotencyKey: 'key-0123456789',
        source: 'ios-notification',
        app: 'TBC Bank',
        bundleId: 'ge.tbc.app',
        title: 'TBC Bank',
        subtitle: 'Wolt',
        body: 'GEL 43.60',
        raw: null,
        time: RECEIVED_AT,
        timeProvided: false,
        timeZone: null,
        timeOffsetMinutes: null,
      },
    });
  });

  describe('aliases', () => {
    it.each(['app', 'appName', 'sourceApp'])('takes the app from %s', (key) => {
      const result = parse({ overrides: { app: undefined, [key]: 'Revolut' } });

      expect(result).toMatchObject({ ok: true, notification: { app: 'Revolut' } });
    });

    it.each(['body', 'message', 'text'])('takes the message from %s', (key) => {
      const result = parse({ overrides: { body: undefined, [key]: 'Paid 12 GEL' } });

      expect(result).toMatchObject({ ok: true, notification: { body: 'Paid 12 GEL' } });
    });

    it('prefers the primary key over its alias', () => {
      expect(parse({ overrides: { appName: 'Other' } })).toMatchObject({ notification: { app: 'TBC Bank' } });
    });
  });

  describe('text', () => {
    it('collapses whitespace and drops invisible characters', () => {
      const result = parse({ overrides: { body: ' GEL  43.60​\n at   Wolt ' } });

      expect(result).toMatchObject({ notification: { body: 'GEL 43.60 at Wolt' } });
    });

    it('cuts a field over its cap instead of refusing the message', () => {
      const result = parse({ overrides: { body: 'x'.repeat(10_000), title: 'y'.repeat(2000), app: 'z'.repeat(500) } });

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.notification.body).toHaveLength(4000);
      expect(result.notification.title).toHaveLength(500);
      expect(result.notification.app).toHaveLength(255);
    });

    it('leaves absent text empty', () => {
      const result = parse({ overrides: { title: undefined, subtitle: undefined, body: undefined } });

      expect(result).toMatchObject({ ok: true, notification: { title: '', subtitle: '', body: '' } });
    });
  });

  describe('raw', () => {
    it('keeps line breaks and drops control characters', () => {
      const result = parse({ overrides: { raw: 'Line one\nLine\u0000 two​' } });

      expect(result).toMatchObject({ notification: { raw: 'Line one\nLine two' } });
    });

    it('accepts raw text up to the cap and refuses more', () => {
      expect(parse({ overrides: { raw: 'a'.repeat(NOTIFICATION_RAW_MAX_BYTES) } }).ok).toBe(true);
      expect(parse({ overrides: { raw: 'a'.repeat(NOTIFICATION_RAW_MAX_BYTES + 1) } })).toEqual({
        ok: false,
        reason: 'rawTooLong',
      });
    });

    it('counts bytes, not characters', () => {
      const raw = 'ა'.repeat(NOTIFICATION_RAW_MAX_BYTES / 3 + 1);

      expect(parse({ overrides: { raw } })).toEqual({ ok: false, reason: 'rawTooLong' });
    });
  });

  describe('refusals', () => {
    it.each([null, 'text', [1], 3])('refuses a body that is %p', (value) => {
      expect(parseNotificationPayload({ body: value, receivedAt: RECEIVED_AT })).toEqual({
        ok: false,
        reason: 'invalidBody',
      });
    });

    it.each([undefined, 'short', 'has space in it', `k${'x'.repeat(128)}`, 12345678])(
      'refuses the idempotency key %p',
      (key) => {
        expect(parse({ overrides: { idempotencyKey: key } })).toEqual({ ok: false, reason: 'invalidIdempotencyKey' });
      },
    );

    it.each(['UPPER', 'has space', 'x'.repeat(33), 7])('refuses the source label %p', (source) => {
      expect(parse({ overrides: { source } })).toEqual({ ok: false, reason: 'invalidSource' });
    });

    it('keeps a valid source label', () => {
      expect(parse({ overrides: { source: 'ios-27' } })).toMatchObject({ notification: { source: 'ios-27' } });
    });
  });

  describe('time', () => {
    it('uses the notification time when it is sent', () => {
      const result = parse({ overrides: { time: '2026-10-20T11:59:50+00:00' } });

      expect(result).toMatchObject({
        notification: { time: new Date('2026-10-20T11:59:50.000Z'), timeProvided: true },
      });
    });

    it.each([
      ['malformed', 'yesterday', 'invalidTime'],
      ['not text', 12345, 'invalidTime'],
      ['in the future', '2026-10-20T13:00:00Z', 'timeInFuture'],
      ['older than 30 days', '2026-09-01T12:00:00Z', 'timeTooOld'],
    ])('refuses a time that is %s', (_name, time, reason) => {
      expect(parse({ overrides: { time } })).toEqual({ ok: false, reason });
    });

    it('treats a blank time as now', () => {
      expect(parse({ overrides: { time: '  ' } })).toMatchObject({
        notification: { time: RECEIVED_AT, timeProvided: false },
      });
    });
  });

  describe('timeZone', () => {
    it('keeps a valid zone and the offset the time wrote', () => {
      expect(parse({ overrides: { time: '2026-10-20T15:59:50+04:00', timeZone: 'Asia/Tbilisi' } })).toMatchObject({
        notification: { timeZone: 'Asia/Tbilisi', timeOffsetMinutes: 240 },
      });
    });

    it('has none for a blank zone or a Z time', () => {
      expect(parse({ overrides: { time: '2026-10-20T11:59:50Z' } })).toMatchObject({
        notification: { timeZone: null, timeOffsetMinutes: null },
      });
    });

    it('refuses an invalid zone', () => {
      expect(parse({ overrides: { timeZone: '+04:00' } })).toEqual({ ok: false, reason: 'invalidTimeZone' });
    });
  });
});
