import { API_ERROR_CODES } from '@bt/shared/types';
import { sleep } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import { redisClient } from '@root/redis-client';
import { RateLimitService } from '@services/common/rate-limit.service';
import { buildLockKey } from '@services/currencies/base-currency-lock';
import * as helpers from '@tests/helpers';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { randomUUID } from 'node:crypto';

import { notificationLimits, notificationTimings } from './constants';
import * as notificationProcessing from './process-notification';

const CARD = 'TBC Visa';
const BASE = global.BASE_CURRENCY_CODE;

const DEFAULT_TIMINGS = { ...notificationTimings };
const DEFAULT_LIMITS = { ...notificationLimits };

/** A Wallet notification as the iOS 27 shortcut sends it: the app by display name, the card as the title. */
const notification = (overrides: Record<string, unknown> = {}) => ({
  kind: 'notification',
  app: 'Wallet',
  title: CARD,
  subtitle: 'Wolt',
  body: `${BASE} 43.60`,
  idempotencyKey: `key-${randomUUID()}`,
  ...overrides,
});

const walletPayment = (overrides: Record<string, unknown> = {}) => ({
  kind: 'walletTransaction',
  amount: '47.00',
  merchant: 'Cafe Heart of Batumi',
  card: CARD,
  source: 'apple-pay',
  idempotencyKey: `key-${randomUUID()}`,
  ...overrides,
});

/** An ISO 8601 time an hour ago, written with a numeric offset (`+04:00`), as the shortcut writes it. */
const hourAgoWithOffset = ({ offsetMinutes }: { offsetMinutes: number }) => {
  const instant = new Date(Date.now() - 60 * 60_000);
  const wall = new Date(instant.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 19);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;

  return `${wall}${offset}`;
};

const send = ({ secret, body }: { secret: string; body: object }) => ingestHelpers.postIngestEvent({ secret, body });

const setUp = async () => (await ingestHelpers.createTestIngestToken()).secret;

/** A token, and the card linked to a fresh account, so a Wallet notification can be logged. */
const setUpWithCard = async () => {
  const account = await helpers.createAccount({ raw: true });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: account.id }, raw: true });

  return { account, secret: await setUp() };
};

const storedRequests = () => IngestRequests.findAll({ order: [['createdAt', 'ASC']] });

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
};

beforeEach(async () => {
  await resetLimits();
});

afterEach(async () => {
  Object.assign(notificationTimings, DEFAULT_TIMINGS);
  Object.assign(notificationLimits, DEFAULT_LIMITS);
  jest.restoreAllMocks();
  await resetLimits();
});

describe('POST /ingest/event', () => {
  describe('kind', () => {
    it.each([
      ['no kind', { kind: undefined }],
      ['an unknown kind', { kind: 'sms' }],
      ['a kind that is not text', { kind: 3 }],
    ])('answers 422 for %s and never guesses the pipeline', async (_name, overrides) => {
      const secret = await setUp();

      const res = await send({ secret, body: walletPayment(overrides) });

      expect(res.status).toBe(422);
      expect(res.body.response.code).toBe(API_ERROR_CODES.validationError);
      expect(res.body.response.details).toEqual({ reason: 'invalidKind' });
      expect(res.body.response.message).toEqual(expect.any(String));
      expect(await storedRequests()).toEqual([]);
    });

    it.each([
      ['a dry run with no kind', { dryRun: true }],
      ['a body with nothing in it', {}],
      ['a body of empty strings', { kind: '', app: '', title: '', body: '' }],
    ])(
      'answers %s with a silent 200: the shortcut posts it when its notification vanished before it was read',
      async (_name, body) => {
        const secret = await setUp();

        const res = await send({ secret, body });

        expect(res.status).toBe(200);
        expect(res.body.response).toEqual({ outcome: 'ignored', reason: 'emptyRun', notify: false });
        expect(await storedRequests()).toEqual([]);
      },
    );

    it('answers 422 for a body that is not an object', async () => {
      const secret = await setUp();

      const res = await send({ secret, body: ['notification'] });

      expect(res.status).toBe(422);
      expect(res.body.response.details).toEqual({ reason: 'invalidKind' });
    });
  });

  describe('walletTransaction', () => {
    it('runs the card-payment pipeline and always shows a banner', async () => {
      const account = await helpers.createAccount({ raw: true });
      await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: account.id }, raw: true });
      const secret = await setUp();
      const body = walletPayment();

      const res = await send({ secret, body });

      expect(res.status).toBe(200);
      expect(res.body.response).toMatchObject({ outcome: 'logged', notify: true });
      expect(res.body.response.summary).toMatch(/^Logged 47\.00 [A-Z]{3} at Cafe Heart of Batumi → /);
      expect(await helpers.getTransactions({ raw: true })).toHaveLength(1);

      const [stored] = await storedRequests();
      expect(stored).toMatchObject({
        pipeline: 'cardPayment',
        source: 'apple-pay',
        idempotencyKey: body.idempotencyKey,
        status: 'logged',
      });
      expect(stored!.textEnc).toBeNull();
    });

    it('answers a payment on an unlinked card with a 202 and notify true', async () => {
      const secret = await setUp();

      const res = await send({ secret, body: walletPayment() });

      expect(res.status).toBe(202);
      expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownCard', notify: true });
    });

    it('answers a card-payment rejection as the card-payment endpoint does', async () => {
      const secret = await setUp();

      const res = await send({ secret, body: walletPayment({ amount: 'abc' }) });

      expect(res.status).toBe(422);
      expect(res.body.response.details).toEqual({ reason: 'invalidAmount' });
    });
  });

  describe('a notification that reaches the processing job', () => {
    it('is logged with the summary the job wrote', async () => {
      const { secret } = await setUpWithCard();
      const body = notification();

      const res = await send({ secret, body });

      expect(res.status).toBe(200);
      expect(res.body.response).toEqual({
        outcome: 'logged',
        summary: expect.stringMatching(new RegExp(`^Logged 43\\.60 ${BASE} at Wolt → `)),
        requestId: expect.any(String),
        notify: true,
      });

      const [stored] = await storedRequests();
      expect(stored).toMatchObject({
        id: res.body.response.requestId,
        pipeline: 'notification',
        status: 'logged',
        idempotencyKey: body.idempotencyKey,
        source: 'ios-notification',
        attempts: 1,
      });
      expect(stored!.summary).toBe(res.body.response.summary);
    });

    it('answers "queued" when the job is still running at the end of the wait budget', async () => {
      notificationTimings.waitBudgetMs = 200;
      notificationTimings.pollIntervalMs = 50;
      jest.spyOn(notificationProcessing, 'processNotification').mockImplementation(async () => {
        await sleep({ ms: 1000 });

        return 'done';
      });
      const secret = await setUp();

      const res = await send({ secret, body: notification() });

      expect(res.status).toBe(202);
      expect(res.body.response).toEqual({
        outcome: 'queued',
        summary: 'Queued, will appear shortly',
        requestId: expect.any(String),
        notify: true,
      });
      expect((await storedRequests())[0]!.status).toBe('received');
    });

    it('parks the request as processingFailed once every attempt has failed', async () => {
      notificationTimings.retryBackoffMs = 10;
      notificationTimings.waitBudgetMs = 15_000;
      const processor = jest.spyOn(notificationProcessing, 'processNotification').mockRejectedValue(new Error('boom'));
      const secret = await setUp();

      const res = await send({ secret, body: notification() });

      expect(res.status).toBe(202);
      expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'processingFailed', notify: true });
      expect(res.body.response.summary).toContain('Not logged yet');
      expect(processor).toHaveBeenCalledTimes(4);
      expect((await storedRequests())[0]).toMatchObject({ status: 'parked', reason: 'processingFailed', attempts: 1 });
    }, 30_000);

    it('keeps the text out of the plain payload and stores it encrypted', async () => {
      const secret = await setUp();

      await send({ secret, body: notification({ raw: `${CARD}\nWolt\nGEL 43.60` }) });

      const [stored] = await storedRequests();
      expect(stored!.payload).toEqual({
        kind: 'notification',
        app: 'Wallet',
        bundleId: null,
        time: expect.any(String),
        timeProvided: false,
      });
      // The payload and the summary hold no text; a payment that was read keeps its reading in `parsed`.
      expect(JSON.stringify(stored!.payload)).not.toMatch(/Wolt|43\.60/);
      expect(stored!.textEnc).toEqual(expect.any(String));
      expect(stored!.textEnc).not.toContain('Wolt');
    });

    it('takes the app and message from their aliases', async () => {
      const secret = await setUp();

      const res = await send({
        secret,
        body: {
          kind: 'notification',
          idempotencyKey: `key-${randomUUID()}`,
          appName: 'Revolut',
          message: 'Paid GEL 5.00',
        },
      });

      // Revolut is a seeded bank, so the text reaches the reader; with no AI model it waits.
      expect(res.status).toBe(202);
      expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'aiUnavailable' });
      const [source] = await helpers.listNotificationSources({ raw: true });
      expect(source).toMatchObject({ appName: 'Revolut' });
    });

    it('keeps two identical notifications minutes apart as two requests and two transactions', async () => {
      const { secret } = await setUpWithCard();
      const first = notification({ time: new Date(Date.now() - 120_000).toISOString() });
      const second = notification({ time: new Date().toISOString() });

      expect((await send({ secret, body: first })).body.response.outcome).toBe('logged');
      expect((await send({ secret, body: second })).body.response.outcome).toBe('logged');

      expect(await storedRequests()).toHaveLength(2);
      expect(await helpers.getTransactions({ raw: true })).toHaveLength(2);
    });

    it('folds the same notification under a second key within the fold window into the first', async () => {
      const { account, secret } = await setUpWithCard();
      const time = new Date(Date.now() - 60_000);
      const first = await send({ secret, body: notification({ time: time.toISOString() }) });
      const balanceAfterFirst = (await helpers.getAccount({ id: account.id, raw: true })).currentBalance;

      const second = await send({
        secret,
        body: notification({ time: new Date(time.getTime() + 2000).toISOString() }),
      });

      expect(first.body.response.outcome).toBe('logged');
      expect(second.body.response).toEqual({
        outcome: 'duplicate',
        requestId: first.body.response.requestId,
        notify: false,
      });
      expect(await storedRequests()).toHaveLength(1);
      expect(await helpers.getTransactions({ raw: true })).toHaveLength(1);
      expect((await helpers.getAccount({ id: account.id, raw: true })).currentBalance).toBe(balanceAfterFirst);
    });

    it('stores one request when the same notification arrives twice at once under two keys', async () => {
      const { secret } = await setUpWithCard();
      const time = new Date(Date.now() - 60_000).toISOString();

      const [a, b] = await Promise.all([
        send({ secret, body: notification({ time }) }),
        send({ secret, body: notification({ time }) }),
      ]);

      expect([a.body.response.outcome, b.body.response.outcome].toSorted()).toEqual(['duplicate', 'logged']);
      expect(await storedRequests()).toHaveLength(1);
      expect(await helpers.getTransactions({ raw: true })).toHaveLength(1);
    });

    it('does not fold a notification with other text, or the same text past the fold window', async () => {
      const { secret } = await setUpWithCard();
      const time = Date.now() - 60_000;
      notificationTimings.foldMs = 1000;

      await send({ secret, body: notification({ time: new Date(time).toISOString() }) });
      await send({
        secret,
        body: notification({ time: new Date(time + 3000).toISOString() }),
      });
      await send({
        secret,
        body: notification({ time: new Date(time + 3500).toISOString(), body: `${BASE} 12.00` }),
      });

      expect(await storedRequests()).toHaveLength(3);
    });
  });

  describe('the recorded time zone of a notification', () => {
    it('records the request zone and the offset of its time', async () => {
      const { secret } = await setUpWithCard();

      const res = await send({
        secret,
        body: notification({ time: hourAgoWithOffset({ offsetMinutes: 240 }), timeZone: 'Asia/Tbilisi' }),
      });

      expect(res.body.response.outcome).toBe('logged');
      const [tx] = await helpers.getTransactions({ raw: true });
      expect(tx).toMatchObject({ timeZone: 'Asia/Tbilisi', utcOffsetMinutes: 240 });
    });

    it('keeps the offset alone when the setting zone differs', async () => {
      const { secret } = await setUpWithCard();
      await helpers.patchUserSettings({ raw: true, patch: { timeZone: 'Europe/Kiev' } });

      await send({ secret, body: notification({ time: hourAgoWithOffset({ offsetMinutes: 240 }) }) });

      const [tx] = await helpers.getTransactions({ raw: true });
      expect(tx).toMatchObject({ timeZone: null, utcOffsetMinutes: 240 });
    });

    it('logs a notification whose time states an impossible offset without one', async () => {
      const { secret } = await setUpWithCard();

      await send({ secret, body: notification({ time: hourAgoWithOffset({ offsetMinutes: 1439 }) }) });

      const [tx] = await helpers.getTransactions({ raw: true });
      expect(tx).toMatchObject({ timeZone: null, utcOffsetMinutes: null });
    });

    it('records the setting zone for a blank time', async () => {
      const { secret } = await setUpWithCard();
      await helpers.patchUserSettings({ raw: true, patch: { timeZone: 'Asia/Tbilisi' } });

      await send({ secret, body: notification() });

      const [tx] = await helpers.getTransactions({ raw: true });
      expect(tx).toMatchObject({ timeZone: 'Asia/Tbilisi', utcOffsetMinutes: 240 });
    });
  });

  describe('idempotency', () => {
    it('answers a repeated key with "duplicate" and no banner, and stores nothing more', async () => {
      const secret = await setUp();
      const body = notification();
      const first = await send({ secret, body });

      const replay = await send({ secret, body });

      expect(replay.status).toBe(200);
      expect(replay.body.response).toEqual({
        outcome: 'duplicate',
        requestId: first.body.response.requestId,
        notify: false,
      });
      expect(await storedRequests()).toHaveLength(1);
    });

    it('answers 409 for the same key with another body', async () => {
      const secret = await setUp();
      const body = notification();
      await send({ secret, body });

      const res = await send({ secret, body: { ...body, body: 'GEL 99.00' } });

      expect(res.status).toBe(409);
      expect(res.body.response.code).toBe(API_ERROR_CODES.conflict);
      expect(res.body.response.details).toEqual({ reason: 'keyReused' });
      expect(await storedRequests()).toHaveLength(1);
    });

    it.each([
      ['too short', 'short'],
      ['with a space', 'has a space in it'],
    ])('answers 422 for an idempotency key that is %s', async (_name, idempotencyKey) => {
      const secret = await setUp();

      const res = await send({ secret, body: notification({ idempotencyKey }) });

      expect(res.status).toBe(422);
      expect(res.body.response.details).toEqual({ reason: 'invalidIdempotencyKey' });
    });
  });

  describe('dropped before anything is stored', () => {
    it.each([
      ['no amount', 'See you tonight at 20:30', 'noAmount'],
      ['a request for a code', 'Your code 482913 for 43.60 GEL. Enter it to confirm.', 'security'],
      ['a promo', 'Get 20% off orders over 50 GEL', 'promo'],
    ])('drops %s, answers 200 and writes no row', async (_name, body, reason) => {
      const secret = await setUp();

      const res = await send({ secret, body: notification({ title: '', subtitle: '', body }) });

      expect(res.status).toBe(200);
      expect(res.body.response).toEqual({ outcome: 'dropped', reason, notify: false });
      expect(await storedRequests()).toEqual([]);
    });

    it('creates no source for a messaging notification that was dropped', async () => {
      const secret = await setUp();

      await send({ secret, body: notification({ app: 'Messages', title: 'TBC', body: 'Nothing to see' }) });

      expect(await helpers.listNotificationSources({ raw: true })).toEqual([]);
    });

    it('counts the drop on a source that already exists', async () => {
      const secret = await setUp();
      await send({ secret, body: notification() });

      await send({ secret, body: notification({ body: 'Nothing to see' }) });
      await send({ secret, body: notification({ body: 'Nothing to see either' }) });
      await send({ secret, body: notification({ body: 'Get 20% off orders over 50 GEL' }) });

      const [source] = await helpers.listNotificationSources({ raw: true });
      expect(source!.counters).toEqual({ noAmount: 2, promo: 1 });
    });

    it('answers a dropped notification again when it is sent again, since nothing was stored', async () => {
      const secret = await setUp();
      const body = notification({ body: 'Nothing to see' });

      const first = await send({ secret, body });
      const second = await send({ secret, body });

      expect(first.body.response.outcome).toBe('dropped');
      expect(second.body.response.outcome).toBe('dropped');
    });

    it('follows the strictness the user chose', async () => {
      const secret = await setUp();
      const body = notification({ title: '', subtitle: '', body: 'Purchase at Wolt 43.60' });

      const standard = await send({ secret, body });
      await helpers.setGateStrictness({ payload: { strictness: 'loose' }, raw: true });
      const loose = await send({ secret, body: { ...body, idempotencyKey: `key-${randomUUID()}` } });

      expect(standard.body.response).toMatchObject({ outcome: 'dropped', reason: 'noAmount' });
      // Loose lets the text through to the reader, which waits for an AI model here.
      expect(loose.body.response).toMatchObject({ outcome: 'parked', reason: 'aiUnavailable' });
    });

    describe('our own output', () => {
      it.each([
        ['a notification from the Shortcuts app', { app: 'Shortcuts', bundleId: 'com.apple.shortcuts' }],
        ['a notification from the MoneyMatter web app', { app: 'MoneyMatter', bundleId: undefined }],
        [
          'a notification whose text is our own banner',
          { app: 'Messages', bundleId: undefined, title: 'Shortcuts', body: 'Logged 43.60 GEL at Wolt → Food' },
        ],
      ])('drops %s as self, with no row and no source', async (_name, overrides) => {
        const secret = await setUp();

        const res = await send({ secret, body: notification(overrides) });

        expect(res.status).toBe(200);
        expect(res.body.response).toEqual({ outcome: 'dropped', reason: 'self', notify: false });
        expect(await storedRequests()).toEqual([]);
        expect(await helpers.listNotificationSources({ raw: true })).toEqual([]);
      });
    });

    describe('a muted source', () => {
      it('drops its notifications and counts them', async () => {
        const secret = await setUp();
        await send({ secret, body: notification() });
        const [source] = await helpers.listNotificationSources({ raw: true });
        await helpers.updateNotificationSource({ id: source!.id, payload: { mode: 'muted' }, raw: true });

        const res = await send({ secret, body: notification() });

        expect(res.status).toBe(200);
        expect(res.body.response).toEqual({ outcome: 'dropped', reason: 'muted', notify: false });
        expect(await storedRequests()).toHaveLength(1);
        expect((await helpers.listNotificationSources({ raw: true }))[0]!.counters).toEqual({ muted: 1 });
      });
    });
  });

  describe('limits', () => {
    it('answers 429 once the hourly cap is spent, and dropped notifications never count', async () => {
      notificationLimits.perHour = 2;
      const { secret } = await setUpWithCard();

      expect((await send({ secret, body: notification() })).status).toBe(200);
      expect((await send({ secret, body: notification({ body: 'Nothing to see' }) })).status).toBe(200);
      expect((await send({ secret, body: notification({ body: 'Nothing to see' }) })).status).toBe(200);
      expect((await send({ secret, body: notification({ body: `${BASE} 12.00` }) })).status).toBe(200);
      const limited = await send({ secret, body: notification({ body: `${BASE} 13.00` }) });

      expect(limited.status).toBe(429);
      expect(limited.body.response.code).toBe(API_ERROR_CODES.tooManyRequests);
      expect(limited.body.response.message).toEqual(expect.any(String));
      expect(await storedRequests()).toHaveLength(2);
      expect((await helpers.listNotificationSources({ raw: true }))[0]!.counters).toMatchObject({ rateLimited: 1 });
    });

    it('answers 429 once the daily cap is spent', async () => {
      notificationLimits.perDay = 1;
      const { secret } = await setUpWithCard();

      expect((await send({ secret, body: notification() })).status).toBe(200);
      expect((await send({ secret, body: notification() })).status).toBe(429);
    });

    it('does not count a replay of a stored notification', async () => {
      notificationLimits.perHour = 1;
      const { secret } = await setUpWithCard();
      const body = notification();

      expect((await send({ secret, body })).status).toBe(200);
      expect((await send({ secret, body })).body.response.outcome).toBe('duplicate');
    });

    it('answers 413 for a body over 16 KB', async () => {
      const { secret } = await setUpWithCard();

      const res = await send({ secret, body: notification({ raw: 'x'.repeat(17 * 1024) }) });

      expect(res.status).toBe(413);
    });

    it('answers 422 for raw text over 8 KB that fits the body limit', async () => {
      const { secret } = await setUpWithCard();

      const res = await send({ secret, body: notification({ raw: 'x'.repeat(9 * 1024) }) });

      expect(res.status).toBe(422);
      expect(res.body.response.details).toEqual({ reason: 'rawTooLong' });
      expect(await storedRequests()).toEqual([]);
    });
  });

  describe('dry run', () => {
    it.each(['walletTransaction', 'notification'])(
      'answers the connection check for kind %s and writes nothing',
      async (kind) => {
        const secret = await setUp();

        const res = await send({ secret, body: { kind, dryRun: true } });

        expect(res.status).toBe(200);
        expect(res.body.response).toMatchObject({ outcome: 'dryRun', notify: true });
        expect(res.body.response.summary).toMatch(/^Connected as /);
        expect(await storedRequests()).toEqual([]);
      },
    );
  });

  describe('sources', () => {
    it('records the app on first sight in the mode its app starts in', async () => {
      const secret = await setUp();

      await send({ secret, body: notification({ app: 'TBC Bank', bundleId: 'ge.tbconline.TBC-ipad' }) });
      await send({
        secret,
        body: notification({ app: 'Wallet', bundleId: 'com.apple.Passbook', title: 'TBC Bank', body: 'GEL 12.00' }),
      });
      await send({ secret, body: notification({ app: 'Unknown Pay', bundleId: 'pl.unknown.pay', body: 'GEL 9.00' }) });

      const sources = await helpers.listNotificationSources({ raw: true });
      const modes = Object.fromEntries(sources.map((source) => [source.bundleId, source.mode]));
      expect(modes).toEqual({
        'ge.tbconline.TBC-ipad': 'auto',
        'com.apple.Passbook': 'auto',
        'pl.unknown.pay': 'pending',
      });
    });

    it('starts the apps the shortcut names by display name in the mode their name earns', async () => {
      const secret = await setUp();

      for (const app of ['Wallet', 'Кошелёк', 'TBC Bank', 'bcc.kz', 'Telegram', 'Ledger Wallet']) {
        await send({ secret, body: notification({ app, title: app, subtitle: '', body: 'GEL 9.00' }) });
      }

      const sources = await helpers.listNotificationSources({ raw: true });
      const modes = Object.fromEntries(sources.map((source) => [source.appName, source.mode]));
      // Wallet under its English and its Russian name is one source.
      expect(modes).toEqual({
        Wallet: 'auto',
        'TBC Bank': 'auto',
        'bcc.kz': 'auto',
        Telegram: 'pending',
        'Ledger Wallet': 'pending',
      });
    });

    it('splits a messaging app per sender', async () => {
      const secret = await setUp();

      await send({
        secret,
        body: notification({ app: 'Messages', bundleId: 'com.apple.MobileSMS', title: 'TBC', body: 'GEL 12.00' }),
      });
      await send({
        secret,
        body: notification({ app: 'Messages', bundleId: 'com.apple.MobileSMS', title: 'Mum', body: 'Send me 20 GEL' }),
      });

      const sources = await helpers.listNotificationSources({ raw: true });
      expect(sources.map((source) => source.sender).toSorted()).toEqual(['Mum', 'TBC']);
      expect(sources.every((source) => source.conversational && source.mode === 'pending')).toBe(true);
    });
  });

  describe('authentication and guards', () => {
    it('answers 401 without a token', async () => {
      const res = await ingestHelpers.requestWithoutSession({
        method: 'post',
        url: '/ingest/event',
        headers: {},
        body: notification(),
      });

      expect(res.status).toBe(401);
    });

    it.each([
      ['notification', notification],
      ['walletTransaction', walletPayment],
    ])('answers 423 for kind %s while a base-currency change is running, writing no row', async (_kind, build) => {
      const secret = await setUp();
      const user = await helpers.getUserInfo({ raw: true });

      await redisClient.set(buildLockKey(user.id), 'test-lock');
      try {
        const res = await send({ secret, body: build() });

        expect(res.status).toBe(423);
        expect(res.body.response.code).toBe(API_ERROR_CODES.baseCurrencyChangeInProgress);
        expect(res.body.response.message).toBe(
          "MoneyMatter is busy updating your currency. This payment wasn't saved, try again in a minute.",
        );
        expect(await storedRequests()).toEqual([]);
      } finally {
        await redisClient.del(buildLockKey(user.id));
      }
    });

    it("never shows one user's notification sources to another", async () => {
      const secret = await setUp();
      await send({ secret, body: notification() });
      const other = await helpers.signUpSecondUser();

      const otherSources = await helpers.asUser({
        cookies: other.cookies,
        fn: () => helpers.listNotificationSources({ raw: true }),
      });

      expect(otherSources).toEqual([]);
    });
  });
});
