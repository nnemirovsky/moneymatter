import { CATEGORIZATION_SOURCE, type NotificationSourceDto, type RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import Transactions from '@models/transactions.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import { approveCardAsIs, confirmCardOf } from '@tests/helpers/ingest-cards';
import { waitForIngestIdle } from '@tests/helpers/ingest-follow-ups';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { randomUUID } from 'node:crypto';

import { contextConfig } from './context-config';

const CARD = 'TBC Visa';
const BASE = global.BASE_CURRENCY_CODE;
const DEFAULT_CONFIG = { ...contextConfig };

const walletPayment = ({ amount = '60.64', merchant = 'Wolt' }: { amount?: string; merchant?: string } = {}) => ({
  kind: 'notification',
  app: 'Wallet',
  title: CARD,
  subtitle: merchant,
  body: `${BASE} ${amount}`,
  idempotencyKey: `key-${randomUUID()}`,
});

const woltNotification = ({ title, body }: { title: string; body: string }) => ({
  kind: 'notification',
  app: 'Wolt',
  title,
  subtitle: '',
  body,
  idempotencyKey: `key-${randomUUID()}`,
});

const accepted = ({ store = 'Urban Roastery&Coffee' }: { store?: string } = {}) =>
  woltNotification({
    title: 'Order confirmed!',
    body: `${store} has accepted your order! It will be delivered at 11:52 AM.`,
  });

const send = ({ secret, body }: { secret: string; body: object }) => ingestHelpers.postIngestEvent({ secret, body });

const setUp = async () => {
  const account = await helpers.createAccount({ raw: true });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: account.id }, raw: true });

  return { account, secret: (await ingestHelpers.createTestIngestToken()).secret };
};

/** Logs a Wolt payment through Wallet's notification and returns its row. */
const pay = async ({ secret, amount, merchant }: { secret: string; amount?: string; merchant?: string }) => {
  const res = await send({ secret, body: walletPayment({ amount, merchant }) });
  expect(res.body.response.outcome).toBe('logged');
  const request = (await IngestRequests.findOne({ where: { id: res.body.response.requestId } }))!;

  return (await Transactions.findOne({ where: { id: request.transactionId! } }))!;
};

const reload = async ({ id }: { id: RecordId }) => (await Transactions.findOne({ where: { id } }))!;

const requestOf = async ({ requestId }: { requestId: RecordId }) =>
  (await IngestRequests.findOne({ where: { id: requestId } }))!;

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

const noAmount = ({ app }: { app: string }) => ({
  kind: 'notification',
  app,
  title: app,
  subtitle: '',
  body: 'Something happened in your account',
  idempotencyKey: `key-${randomUUID()}`,
});

describe('context notifications', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(resetLimits);
  afterEach(async () => {
    Object.assign(contextConfig, DEFAULT_CONFIG);
    await resetLimits();
  });

  describe('a notification of a merchant app after the payment', () => {
    it('adds the store to the note of the payment and answers with the banner', async () => {
      const { secret } = await setUp();
      const tx = await pay({ secret });

      const res = await send({ secret, body: accepted() });

      expect(res.body.response).toMatchObject({
        outcome: 'enriched',
        summary: `Added Urban Roastery&Coffee to 60.64 ${BASE} at Wolt`,
        notify: true,
      });
      const updated = await reload({ id: tx.id });
      expect(updated.note).toBe('Urban Roastery&Coffee order from Wolt');
      expect(updated.externalData).toMatchObject({
        ingest: {
          unconfirmed: true,
          systemNote: 'Urban Roastery&Coffee order from Wolt',
          context: { service: 'Wolt', store: 'Urban Roastery&Coffee', noteApplied: true, guess: false },
        },
      });

      const request = await requestOf({ requestId: res.body.response.requestId });
      expect(request).toMatchObject({ status: 'enriched', transactionId: tx.id, textEnc: null });
      expect((await helpers.listNotificationSources({ raw: true })).find((s) => s.appName === 'Wolt')?.mode).toBe(
        'context',
      );
    });

    it('shows the note on the confirm card of the payment', async () => {
      const { secret } = await setUp();
      const tx = await pay({ secret });
      await send({ secret, body: accepted() });

      const card = await confirmCardOf({ transactionId: tx.id });

      await until(
        async () => {
          const fresh = await confirmCardOf({ transactionId: tx.id });

          return JSON.stringify(fresh.fields).includes('Urban Roastery&Coffee order from Wolt');
        },
        { timeout: 10_000, interval: 200 },
      );
      expect(card).toBeDefined();
    });

    it('enriches once however many stages of the order arrive', async () => {
      const { secret } = await setUp();
      const tx = await pay({ secret });

      await send({ secret, body: accepted() });
      const onTheWay = await send({
        secret,
        body: woltNotification({ title: 'On the way', body: 'Your order from Urban Roastery & Coffee is on its way' }),
      });
      const delivered = await send({
        secret,
        body: woltNotification({
          title: 'Delivered',
          body: 'Your order from Urban Roastery&Coffee has been delivered. Enjoy!',
        }),
      });

      expect(onTheWay.body.response).toMatchObject({ outcome: 'ignored', reason: 'contextRepeat', notify: false });
      expect(delivered.body.response).toMatchObject({ outcome: 'ignored', reason: 'contextRepeat', notify: false });
      expect((await reload({ id: tx.id })).note).toBe('Urban Roastery&Coffee order from Wolt');
    });

    it('treats a later "delivered" as a repeat even when it comes long after the payment', async () => {
      contextConfig.lookbackMs = 1;
      const { secret } = await setUp();
      await pay({ secret });
      await send({ secret, body: accepted() });

      const delivered = await send({
        secret,
        body: woltNotification({
          title: 'Delivered',
          body: 'Your order from Urban Roastery&Coffee has been delivered',
        }),
      });

      expect(delivered.body.response).toMatchObject({ outcome: 'ignored', reason: 'contextRepeat' });
    });

    it('recognizes the later stages of an order whose acceptance found its payment already confirmed', async () => {
      const { secret } = await setUp();
      const confirmed = await pay({ secret });
      await approveCardAsIs({ card: await confirmCardOf({ transactionId: confirmed.id }) });
      const first = await send({ secret, body: accepted() });
      expect(first.body.response).toMatchObject({ reason: 'contextConfirmed' });

      // A second order of the service is paid, then the first order's next stage arrives.
      const next = await pay({ secret, amount: '12.30' });
      const onTheWay = await send({
        secret,
        body: woltNotification({ title: 'On the way', body: 'Your order from Urban Roastery&Coffee is on its way' }),
      });

      expect(onTheWay.body.response).toMatchObject({ outcome: 'ignored', reason: 'contextRepeat' });
      expect((await reload({ id: next.id })).note).toBeNull();
    });

    it('treats a second acceptance of the same store a moment later as a repeat, not a new order', async () => {
      const { secret } = await setUp();
      const tx = await pay({ secret });
      await send({ secret, body: accepted() });
      await pay({ secret, amount: '12.30' });

      // Another wording, so the two are not one notification folded by the server.
      const again = await send({
        secret,
        body: woltNotification({ title: 'Order received', body: 'Urban Roastery&Coffee has received your order!' }),
      });

      expect(again.body.response).toMatchObject({ outcome: 'ignored', reason: 'contextRepeat' });
      expect((await reload({ id: tx.id })).note).toBe('Urban Roastery&Coffee order from Wolt');
    });

    it('does not hold a later stage whose first stage was never seen, so it cannot land on the next order', async () => {
      const { secret } = await setUp();
      const onTheWay = await send({
        secret,
        body: woltNotification({ title: 'On the way', body: 'Your order from Urban Roastery&Coffee is on its way' }),
      });
      expect(onTheWay.body.response).toMatchObject({ outcome: 'ignored', notify: false });

      const next = await pay({ secret, amount: '12.30' });
      await waitForIngestIdle();

      expect((await reload({ id: next.id })).note).toBeNull();
    });

    it('keeps no text of an applied notification in the request', async () => {
      const { secret } = await setUp();
      await pay({ secret });

      const res = await send({ secret, body: accepted() });

      const request = await requestOf({ requestId: res.body.response.requestId });
      expect(request.textEnc).toBeNull();
      expect(JSON.stringify(request.parsed)).not.toContain('delivered at 11:52');
      expect(request.parsed).toMatchObject({ context: { excerpt: '' } });
    });

    it('leaves a status line that names no store alone', async () => {
      const { secret } = await setUp();
      const tx = await pay({ secret });

      const res = await send({
        secret,
        body: woltNotification({ title: 'On the way', body: 'Your courier is on the way' }),
      });

      expect(res.body.response).toMatchObject({ outcome: 'ignored', notify: false });
      expect((await reload({ id: tx.id })).note).toBeNull();
    });

    it('does nothing to a payment the owner already confirmed', async () => {
      const { secret } = await setUp();
      const tx = await pay({ secret });
      await approveCardAsIs({ card: await confirmCardOf({ transactionId: tx.id }) });

      const res = await send({ secret, body: accepted() });

      expect(res.body.response).toMatchObject({ outcome: 'ignored', reason: 'contextConfirmed', notify: false });
      expect((await reload({ id: tx.id })).note).toBeNull();
    });

    it('is not matched to a payment of another service', async () => {
      const { secret } = await setUp();
      const other = await send({ secret, body: walletPayment({ merchant: 'Carrefour' }) });
      expect(other.body.response.outcome).toBe('logged');

      const res = await send({ secret, body: accepted() });

      expect(res.body.response).toMatchObject({ outcome: 'held', notify: false });
    });

    it('changes the category to the one the store fits, only while it is the pipeline’s own', async () => {
      await helpers.addCustomCategory({ name: 'Bar, cafe', raw: true });
      const cafe = (await helpers.getCategoriesList()).find((category) => category.name === 'Bar, cafe')!;
      const { secret } = await setUp();
      const tx = await pay({ secret });
      const prompts: string[] = [];
      enableServerModel();
      mockNotificationParsing({
        answer: () => ({}),
        contextCategory: ({ prompt }) => {
          prompts.push(prompt);
          const alias = prompt
            .split('\n')
            .find((line) => line.endsWith('|Bar, cafe'))!
            .split('|')[0]!;

          return { categoryId: alias, confidence: 0.9 };
        },
      });

      const res = await send({ secret, body: accepted() });

      expect(res.body.response).toMatchObject({
        outcome: 'enriched',
        summary: `Added Urban Roastery&Coffee to 60.64 ${BASE} at Wolt → Bar, cafe`,
      });
      expect(prompts[0]).toContain('Urban Roastery&Coffee');
      const updated = await reload({ id: tx.id });
      expect(updated.categoryId).toBe(cafe.id);
      expect(updated.categorizationMeta).toMatchObject({ source: CATEGORIZATION_SOURCE.ai });
    });

    it('keeps a category that a rule or the owner chose', async () => {
      const { secret } = await setUp();
      const tx = await pay({ secret });
      await Transactions.update(
        { categorizationMeta: { source: CATEGORIZATION_SOURCE.userRule } },
        { where: { id: tx.id } },
      );
      const prompts: string[] = [];
      enableServerModel();
      mockNotificationParsing({
        answer: () => ({}),
        contextCategory: ({ prompt }) => (prompts.push(prompt), { categoryId: null, confidence: 0 }),
      });

      await send({ secret, body: accepted() });

      expect(prompts).toEqual([]);
      expect((await reload({ id: tx.id })).categoryId).toBe(tx.categoryId);
    });
  });

  describe('a notification of a merchant app before the payment', () => {
    it('is held, and applied once the payment is logged', async () => {
      const { secret } = await setUp();

      const held = await send({ secret, body: accepted() });
      expect(held.body.response).toMatchObject({ outcome: 'held', notify: false });
      expect(await requestOf({ requestId: held.body.response.requestId })).toMatchObject({
        status: 'held',
        textEnc: null,
      });

      const tx = await pay({ secret });

      await until(async () => (await reload({ id: tx.id })).note === 'Urban Roastery&Coffee order from Wolt', {
        timeout: 10_000,
        interval: 200,
      });
      expect(await requestOf({ requestId: held.body.response.requestId })).toMatchObject({
        status: 'enriched',
        transactionId: tx.id,
      });
    });

    it('is given up when no payment comes in time', async () => {
      const { secret } = await setUp();
      const held = await send({ secret, body: accepted() });
      await IngestRequests.update(
        { createdAt: new Date(Date.now() - contextConfig.lookaheadMs - 60_000) },
        { where: { id: held.body.response.requestId }, silent: true },
      );

      const tx = await pay({ secret });
      await waitForIngestIdle();

      expect((await reload({ id: tx.id })).note).toBeNull();
      expect(await requestOf({ requestId: held.body.response.requestId })).toMatchObject({ status: 'held' });
    });
  });

  describe('several payments to one service', () => {
    it('applies a guess between two payments, marks it and asks the model to weigh them', async () => {
      const { secret } = await setUp();
      const first = await pay({ secret, amount: '60.64' });
      const second = await pay({ secret, amount: '12.30' });
      const prompts: string[] = [];
      enableServerModel();
      mockNotificationParsing({
        answer: () => ({}),
        contextPick: ({ prompt }) => {
          prompts.push(prompt);

          return { choice: 't1', confidence: 0.8 };
        },
      });

      const res = await send({ secret, body: accepted() });

      expect(res.body.response.outcome).toBe('enriched');
      expect(prompts).toHaveLength(1);
      const rows = [await reload({ id: first.id }), await reload({ id: second.id })];
      const enriched = rows.filter((row) => row.note === 'Urban Roastery&Coffee order from Wolt');
      expect(enriched).toHaveLength(1);
      // The model's pick (the first payment) wins over the nearest in time (the second).
      expect(enriched[0]!.id).toBe(first.id);
      expect(enriched[0]!.externalData).toMatchObject({ ingest: { context: { guess: true } } });

      // The owner is asked to check a guess on the payment's confirm card.
      const card = await confirmCardOf({ transactionId: enriched[0]!.id });
      expect(card.warnings).toContainEqual({
        key: 'chat.warnings.ingestContextGuess',
        params: { service: 'Wolt', store: 'Urban Roastery&Coffee' },
      });
    });

    it('falls back to the nearest payment when there is no model', async () => {
      const { secret } = await setUp();
      await pay({ secret, amount: '60.64' });
      const second = await pay({ secret, amount: '12.30' });

      const res = await send({ secret, body: accepted() });

      expect(res.body.response.outcome).toBe('enriched');
      expect((await reload({ id: second.id })).note).toBe('Urban Roastery&Coffee order from Wolt');
    });

    it('gives a second order of another store its own payment', async () => {
      const { secret } = await setUp();
      const first = await pay({ secret, amount: '60.64' });
      await send({ secret, body: accepted({ store: 'Urban Roastery&Coffee' }) });
      const second = await pay({ secret, amount: '12.30' });

      const res = await send({ secret, body: accepted({ store: 'Pizza Planet' }) });

      expect(res.body.response.outcome).toBe('enriched');
      expect((await reload({ id: first.id })).note).toBe('Urban Roastery&Coffee order from Wolt');
      expect((await reload({ id: second.id })).note).toBe('Pizza Planet order from Wolt');
    });
  });

  describe('reading with the model', () => {
    it('reads a text no rule reads, and keeps only a store the text prints', async () => {
      const { secret } = await setUp();
      const tx = await pay({ secret });
      enableServerModel();
      mockNotificationParsing({
        answer: () => ({}),
        contextParse: () => ({
          isOrderUpdate: true,
          store: 'Urban Roastery&Coffee',
          status: 'accepted',
          confidence: 0.9,
        }),
      });

      const res = await send({
        secret,
        body: woltNotification({ title: 'Подтверждено', body: 'Urban Roastery&Coffee принял ваш заказ' }),
      });

      expect(res.body.response.outcome).toBe('enriched');
      expect((await reload({ id: tx.id })).note).toBe('Urban Roastery&Coffee order from Wolt');
    });

    it('ignores a text that is no order, and one it cannot read without a model', async () => {
      const { secret } = await setUp();
      enableServerModel();
      mockNotificationParsing({
        answer: () => ({}),
        contextParse: () => ({ isOrderUpdate: false, store: null, status: 'other', confidence: 0.9 }),
      });

      const promo = await send({
        secret,
        body: woltNotification({ title: 'Wolt+', body: 'Try Wolt+ free for a month, no code needed' }),
      });

      expect(promo.body.response).toMatchObject({ outcome: 'ignored', notify: false });
    });

    it('is ignored as unreadable when no model can answer', async () => {
      const { secret } = await setUp();
      await pay({ secret });

      const res = await send({
        secret,
        body: woltNotification({ title: 'Подтверждено', body: 'Urban Roastery&Coffee принял ваш заказ' }),
      });

      expect(res.body.response).toMatchObject({ outcome: 'ignored', reason: 'contextUnreadable', notify: false });
    });
  });

  describe('what a source may send without an amount', () => {
    it('drops it and offers the app as a pending source when the app is not a context one', async () => {
      const { secret } = await setUp();

      const res = await send({ secret, body: noAmount({ app: 'Foodora' }) });

      expect(res.body.response).toMatchObject({ outcome: 'dropped', reason: 'noAmount', notify: false });
      const sources = await helpers.listNotificationSources({ raw: true });
      expect(sources.find((source) => source.appName === 'Foodora')).toMatchObject({
        mode: 'pending',
        counters: { noAmount: 1 },
      });
      expect(await IngestRequests.count({ where: { pipeline: 'notification' } })).toBe(0);
    });

    it('creates no source for a messaging app', async () => {
      const { secret } = await setUp();

      await send({ secret, body: noAmount({ app: 'Messages' }) });

      expect(await helpers.listNotificationSources({ raw: true })).toEqual([]);
    });

    it('reads the notifications of an app the owner switched to context', async () => {
      const { secret } = await setUp();
      const tx = await pay({ secret });
      await send({ secret, body: noAmount({ app: 'Foodora' }) });
      const source = (await helpers.listNotificationSources({ raw: true })).find((s) => s.appName === 'Foodora')!;
      await helpers.updateNotificationSource({ id: source.id, payload: { mode: 'context' }, raw: true });

      const res = await send({
        secret,
        body: { ...noAmount({ app: 'Foodora' }), body: 'Pizza Planet has accepted your order!' },
      });

      // The payment is Wolt's, so the other service's notification waits.
      expect(res.body.response).toMatchObject({ outcome: 'held' });
      expect((await reload({ id: tx.id })).note).toBeNull();
    });

    it('still drops a promo of a context app', async () => {
      const { secret } = await setUp();

      const res = await send({
        secret,
        body: woltNotification({ title: 'Wolt', body: 'Get 20% off your next order, today only' }),
      });

      expect(res.body.response).toMatchObject({ outcome: 'dropped', reason: 'promo' });
    });

    it('still drops a request for a code from a context app', async () => {
      const { secret } = await setUp();

      const res = await send({
        secret,
        body: woltNotification({ title: 'Wolt', body: 'Your verification code is 482913, do not share it' }),
      });

      expect(res.body.response).toMatchObject({ outcome: 'dropped', reason: 'security' });
    });

    it('makes a pending source of a seed app a context source on its next notification', async () => {
      const { secret } = await setUp();
      await send({
        secret,
        body: { ...walletPayment(), app: 'Wolt', title: 'Wolt', subtitle: '', body: `Receipt ${BASE} 5.00` },
      });
      const source = (await helpers.listNotificationSources({ raw: true })).find(
        (s) => s.appName === 'Wolt',
      ) as NotificationSourceDto;
      await helpers.updateNotificationSource({ id: source.id, payload: { mode: 'pending' }, raw: true });

      await send({ secret, body: accepted() });

      expect((await helpers.listNotificationSources({ raw: true })).find((s) => s.appName === 'Wolt')?.mode).toBe(
        'context',
      );
    });

    it('deletes the waiting contexts of a source when it is muted', async () => {
      const { secret } = await setUp();
      const held = await send({ secret, body: accepted() });
      const source = (await helpers.listNotificationSources({ raw: true })).find((s) => s.appName === 'Wolt')!;

      await helpers.updateNotificationSource({ id: source.id, payload: { mode: 'muted' }, raw: true });

      expect(await IngestRequests.findOne({ where: { id: held.body.response.requestId } })).toBeNull();
    });
  });
  describe('a messaging or mail sender', () => {
    const probe = ({ title = 'Госуслуги' }: { title?: string } = {}) => ({
      kind: 'notificationProbe',
      app: 'Mail',
      title,
    });
    const mail = ({ title = 'Госуслуги', body }: { title?: string; body: string }) => ({
      kind: 'notification',
      app: 'Mail',
      title,
      subtitle: '',
      body,
      idempotencyKey: `key-${randomUUID()}`,
    });

    it('is asked for nothing and leaves no trace when the sender is unknown', async () => {
      const { secret } = await setUp();

      const res = await send({ secret, body: probe() });

      expect(res.status).toBe(200);
      expect(res.body.response).toEqual({ outcome: 'probe', notify: false });
      expect(await helpers.listNotificationSources({ raw: true })).toEqual([]);
    });

    it('is asked for its text once the owner added the sender as a context source', async () => {
      const { secret } = await setUp();
      const created = await helpers.createContextSource({
        payload: { appName: 'Mail', sender: 'Госуслуги' },
        raw: true,
      });

      const known = await send({ secret, body: probe() });
      const other = await send({ secret, body: probe({ title: 'Somebody else' }) });

      expect(created).toMatchObject({ appName: 'Mail', sender: 'Госуслуги', conversational: true, mode: 'context' });
      expect(known.body.response).toEqual({ outcome: 'probe', notify: false, send: 'yes' });
      expect(other.body.response).toEqual({ outcome: 'probe', notify: false });
    });

    it('is asked for its text once the owner switched the sender’s source to context', async () => {
      const { secret } = await setUp();
      await send({ secret, body: mail({ body: `Payment ${BASE} 5.00` }) });
      const source = (await helpers.listNotificationSources({ raw: true })).find((s) => s.appName === 'Mail')!;
      expect((await send({ secret, body: probe() })).body.response.send).toBeUndefined();

      await helpers.updateNotificationSource({ id: source.id, payload: { mode: 'context' }, raw: true });

      expect((await send({ secret, body: probe() })).body.response.send).toBe('yes');
    });

    it('is read as context when its text arrives', async () => {
      const { secret } = await setUp();
      const tx = await pay({ secret });
      await helpers.createContextSource({ payload: { appName: 'Mail', sender: 'Wolt Orders' }, raw: true });

      const res = await send({
        secret,
        body: mail({ title: 'Wolt Orders', body: 'Urban Roastery&Coffee has accepted your order!' }),
      });

      // The sender is the service ("Wolt Orders"), and no payment of it exists.
      expect(res.body.response.outcome).toBe('held');
      expect((await reload({ id: tx.id })).note).toBeNull();
    });

    it('gives probes a rate budget of their own, so a burst of them never blocks a payment notification', async () => {
      const { secret } = await setUp();
      const statuses: number[] = [];

      for (let call = 0; call < 121; call += 1) {
        statuses.push((await send({ secret, body: probe({ title: `Sender ${call}` }) })).status);
      }
      const payment = await send({ secret, body: walletPayment() });

      expect(statuses.slice(0, 120).every((status) => status === 200)).toBe(true);
      expect(statuses[120]).toBe(429);
      expect(payment.status).toBe(200);
      expect(payment.body.response.outcome).toBe('logged');
    });

    it('offers a sender named after a merchant just paid, and keeps the names of other senders to itself', async () => {
      const { secret } = await setUp();
      await pay({ secret, merchant: 'Temu' });

      const other = await send({ secret, body: probe({ title: 'Somebody else' }) });
      const temu = await send({ secret, body: probe({ title: 'Temu' }) });

      expect(other.body.response).toEqual({ outcome: 'probe', notify: false });
      expect(temu.body.response).toEqual({ outcome: 'probe', notify: false, send: 'yes' });
      const sources = await helpers.listNotificationSources({ raw: true });
      expect(sources.map((source) => source.sender)).toEqual(['Temu']);
      expect(sources[0]).toMatchObject({ appName: 'Mail', mode: 'pending', conversational: true, counters: {} });
    });

    it('never offers a chat contact that only shares a word with a merchant, or a messaging sender at all', async () => {
      const { secret } = await setUp();
      await pay({ secret, merchant: 'John Lewis' });

      const contact = await send({ secret, body: probe({ title: 'John' }) });
      const sms = await send({ secret, body: { kind: 'notificationProbe', app: 'Messages', title: 'John Lewis' } });

      expect(contact.body.response.send).toBeUndefined();
      expect(sms.body.response.send).toBeUndefined();
      expect(await helpers.listNotificationSources({ raw: true })).toEqual([]);
    });

    it('never offers a sender the owner muted, or one that paid nothing recently', async () => {
      const { secret } = await setUp();
      await pay({ secret, merchant: 'Temu' });
      await send({ secret, body: probe({ title: 'Temu' }) });
      const [source] = await helpers.listNotificationSources({ raw: true });
      await helpers.updateNotificationSource({ id: source!.id, payload: { mode: 'muted' }, raw: true });

      const muted = await send({ secret, body: probe({ title: 'Temu' }) });
      const unrelated = await send({ secret, body: probe({ title: 'Amazon' }) });

      expect(muted.body.response.send).toBeUndefined();
      expect(unrelated.body.response.send).toBeUndefined();
    });

    it('reads that one notification for the payment: no note that repeats the merchant, the store’s category', async () => {
      const shopping = await helpers.addCustomCategory({ name: 'Shopping', raw: true });
      const shoppingId = (await helpers.getCategoriesList()).find((category) => category.name === 'Shopping')!.id;
      expect(shopping).toBeDefined();
      const { secret } = await setUp();
      const tx = await pay({ secret, merchant: 'Temu' });
      await send({ secret, body: probe({ title: 'Temu' }) });
      enableServerModel();
      mockNotificationParsing({
        answer: () => ({}),
        contextCategory: ({ prompt }) => {
          const alias = prompt
            .split('\n')
            .find((line) => line.endsWith('|Shopping'))!
            .split('|')[0]!;

          return { categoryId: alias, confidence: 0.9 };
        },
      });

      const res = await send({
        secret,
        body: mail({ title: 'Temu', body: 'Your Temu order confirmation. Your order is confirmed!' }),
      });

      expect(res.body.response.outcome).toBe('enriched');
      const updated = await reload({ id: tx.id });
      expect(updated.note).toBeNull();
      expect(updated.categoryId).toBe(shoppingId);
    });

    it('adds nothing for a marketplace order when there is no category to give', async () => {
      const { secret } = await setUp();
      const tx = await pay({ secret, merchant: 'Temu' });
      await send({ secret, body: probe({ title: 'Temu' }) });

      const res = await send({
        secret,
        body: mail({ title: 'Temu', body: 'Your Temu order confirmation. Your order is confirmed!' }),
      });

      expect(res.body.response).toMatchObject({ outcome: 'ignored', reason: 'contextNoteKept' });
      expect((await reload({ id: tx.id })).note).toBeNull();
    });

    it('answers a probe that has no sender with no text to send', async () => {
      const { secret } = await setUp();

      const res = await send({ secret, body: { kind: 'notificationProbe', app: 'Mail' } });

      expect(res.body.response).toEqual({ outcome: 'probe', notify: false });
    });
  });

  describe('POST /user/settings/notification-sources', () => {
    it('adds a context source by name, once', async () => {
      const first = await helpers.createContextSource({ payload: { appName: 'Foodora' }, raw: true });
      const again = await helpers.createContextSource({ payload: { appName: 'Foodora' }, raw: true });

      expect(first).toMatchObject({ appName: 'Foodora', sender: null, conversational: false, mode: 'context' });
      expect(again.id).toBe(first.id);
      expect(await helpers.listNotificationSources({ raw: true })).toHaveLength(1);
    });

    it('turns an existing source into a context source', async () => {
      const { secret } = await setUp();
      await send({
        secret,
        body: { ...walletPayment(), app: 'Wolt', title: 'Wolt', subtitle: '', body: `Receipt ${BASE} 5.00` },
      });
      const [wolt] = await helpers.listNotificationSources({ raw: true });
      await helpers.updateNotificationSource({ id: wolt!.id, payload: { mode: 'muted' }, raw: true });

      const added = await helpers.createContextSource({ payload: { appName: 'Wolt' }, raw: true });

      expect(added).toMatchObject({ id: wolt!.id, mode: 'context' });
    });

    it('refuses an empty name', async () => {
      const res = await helpers.createContextSource({ payload: { appName: '  ' } });

      expect(res.statusCode).toBe(422);
    });
  });
});
