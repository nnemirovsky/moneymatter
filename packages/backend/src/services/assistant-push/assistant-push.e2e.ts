import { NOTIFICATION_STATUSES, NOTIFICATION_TYPES, type NotificationType } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import ChatMessages from '@models/chat-messages.model';
import Notifications from '@models/notifications.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { createChatScript, failOnUnscriptedChatRequests } from '@tests/mocks/openai-compatible/chat-script';
import type { ChatScriptTurn } from '@tests/mocks/openai-compatible/chat-script';
import { clearCapturedPushRequests, getCapturedPushRequests } from '@tests/mocks/web-push/mock-api';
import { randomUUID } from 'node:crypto';

import { assistantPushConfig } from './assistant-push-config';
import { assistantPushQueue } from './assistant-push-queue';

useSelfHostWithoutServerAiKeys();
failOnUnscriptedChatRequests();

const DEFAULT_CONFIG = { ...assistantPushConfig };
const BASE = global.BASE_CURRENCY_CODE;
const CARD = 'TBC Visa';

const ASSISTANT_TYPES: NotificationType[] = [
  NOTIFICATION_TYPES.chatReplyReady,
  NOTIFICATION_TYPES.chatCardsWaiting,
  NOTIFICATION_TYPES.automationInbox,
  NOTIFICATION_TYPES.ingestAttention,
];

type Device = Awaited<ReturnType<typeof subscribeDevice>>;

async function subscribeDevice() {
  const subscription = helpers.buildPushSubscription();
  const response = await helpers.subscribePush({ payload: subscription.body });
  expect(response.statusCode).toBe(201);

  return { subscription, endpoint: subscription.body.endpoint };
}

/** The assistant pushes the device received so far, decrypted. */
const assistantPushes = ({ device }: { device: Device }) =>
  getCapturedPushRequests({ endpoint: device.endpoint })
    .map((request) => helpers.decryptCapturedRequest({ request, subscription: device.subscription }))
    .filter((message) => ASSISTANT_TYPES.includes(message.notification.data.type as NotificationType));

const waitForAssistantPushes = async ({ device, count }: { device: Device; count: number }) => {
  await until(() => assistantPushes({ device }).length >= count, { timeout: 10_000, interval: 25 });

  return assistantPushes({ device });
};

/**
 * The barrier behind every "no push" case. It waits until no assistant job is left in the queue, then
 * until a sentinel (queued after those jobs) reached the device, so a push that was going to come has.
 */
const awaitQuiet = async ({ device }: { device: Device }) => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await until(
    async () => {
      const counts = await assistantPushQueue.getJobCounts('delayed', 'waiting', 'active', 'prioritized');
      return Object.values(counts).every((count) => count === 0);
    },
    { timeout: 10_000, interval: 25 },
  );
  await helpers.awaitSentinelPush({ subscription: device.subscription });
};

let modelConnected = false;

/** Sends one message to a scripted model and waits for the run to end. */
const runChat = async ({
  turns,
  threadId,
  text = 'Please help with my budget',
  watch = false,
  title = 'Budget review',
}: {
  turns: ChatScriptTurn[];
  threadId?: string;
  text?: string;
  /** Opens the run's event stream, as the app does while the thread is on screen. */
  watch?: boolean;
  /** An empty title leaves the thread untitled, so its title becomes the first words typed. */
  title?: string;
}) => {
  if (!modelConnected) {
    await helpers.createFirstConnection();
    modelConnected = true;
  }
  global.mswMockServer.use(createChatScript({ turns }).handler);

  const thread = threadId ?? (await helpers.createChatThread({ ...(title && { title }), raw: true })).id;
  const sent = await helpers.sendChatMessage({ threadId: thread, payload: { text }, raw: true });
  if (watch) await helpers.getChatRunEvents({ runId: sent.runId });
  await until(async () => (await ChatMessages.findByPk(sent.messageId))!.status !== 'streaming', {
    timeout: 15_000,
    interval: 50,
  });

  return { threadId: thread, ...sent };
};

const REPLY: ChatScriptTurn[] = [{ text: 'Your secret answer is 42.' }];
const PROPOSE_CATEGORY: ChatScriptTurn[] = [
  { toolCalls: [{ name: 'create_category', arguments: { name: 'Chat Dining', color: '#4CAF50' } }] },
  { text: 'Proposed.' },
];

const notificationsOfType = async ({ type }: { type: NotificationType }) =>
  (await helpers.getNotifications({ raw: true })).filter((notification) => notification.type === type);

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

const walletPayment = ({ secret, card = CARD, amount }: { secret: string; card?: string; amount: string }) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'Wallet',
      title: card,
      subtitle: 'Wolt',
      body: `${BASE} ${amount}`,
      idempotencyKey: `wallet-${randomUUID()}`,
    },
  });

/** A TBC push that only the AI can read. */
const bankPush = ({ secret }: { secret: string }) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'TBC Bank',
      title: 'TBC Bank',
      subtitle: '',
      body: `Purchase ${BASE} 43.60, WOLT.COM TBILISI`,
      idempotencyKey: `push-${randomUUID()}`,
    },
  });

const linkedCard = async () => {
  const account = await helpers.createAccount({ raw: true });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: account.id }, raw: true });

  return { account, secret: (await ingestHelpers.createTestIngestToken()).secret };
};

describe('Assistant push', () => {
  let device: Device;

  beforeEach(async () => {
    modelConnected = false;
    assistantPushConfig.debounceMs = 50;
    clearCapturedPushRequests();
    await resetLimits();
    device = await subscribeDevice();
  });

  afterEach(async () => {
    Object.assign(assistantPushConfig, DEFAULT_CONFIG);
    delete process.env.AI_MONTHLY_CAP_USD_TRIAL;
    await resetLimits();
  });

  describe('chat replies', () => {
    it('pushes one chatReplyReady when a run ends and nobody is looking at the thread', async () => {
      const { threadId } = await runChat({ turns: REPLY });

      const [push, ...rest] = await waitForAssistantPushes({ device, count: 1 });

      expect(rest).toEqual([]);
      expect(push!.notification).toMatchObject({
        title: 'Your reply is ready',
        body: 'Budget review',
        tag: `assistant:${threadId}`,
        data: { type: NOTIFICATION_TYPES.chatReplyReady },
      });
      expect(await notificationsOfType({ type: NOTIFICATION_TYPES.chatReplyReady })).toHaveLength(1);
    });

    it('keeps message text out of the push, and out of the title when it is the first words typed', async () => {
      const { threadId } = await runChat({ turns: REPLY, text: 'My salary is 5000 euros', title: '' });

      const [push] = await waitForAssistantPushes({ device, count: 1 });

      const thread = await helpers.getChatThread({ threadId, raw: true });
      expect(thread.thread).toMatchObject({ title: 'My salary is 5000 euros', titleSource: 'auto' });
      expect(push!.notification.body).toBe('Open the chat to read it.');
      const wire = JSON.stringify(push);
      expect(wire).not.toContain('salary');
      expect(wire).not.toContain('secret answer');
    });

    it('pushes one chatCardsWaiting instead when the run left cards, and counts them', async () => {
      const { threadId } = await runChat({ turns: PROPOSE_CATEGORY });

      const [push, ...rest] = await waitForAssistantPushes({ device, count: 1 });

      expect(rest).toEqual([]);
      expect(push!.notification).toMatchObject({
        title: '1 card waits for your OK',
        tag: `assistant:${threadId}`,
        data: { type: NOTIFICATION_TYPES.chatCardsWaiting },
      });
      expect(await notificationsOfType({ type: NOTIFICATION_TYPES.chatReplyReady })).toEqual([]);
    });

    it('sends nothing while a fresh presence key marks the thread as open', async () => {
      const thread = await helpers.createChatThread({ title: 'Open thread', raw: true });
      expect((await helpers.putChatPresence({ threadId: thread.id, raw: false })).statusCode).toBe(200);

      await runChat({ turns: REPLY, threadId: thread.id });
      await awaitQuiet({ device });

      expect(assistantPushes({ device })).toEqual([]);
      expect(await notificationsOfType({ type: NOTIFICATION_TYPES.chatReplyReady })).toEqual([]);
    });

    it('sends nothing when the app is reading the run stream', async () => {
      await runChat({ turns: REPLY, watch: true });
      await awaitQuiet({ device });

      expect(assistantPushes({ device })).toEqual([]);
    });

    it('sends the push again once the thread was left', async () => {
      const thread = await helpers.createChatThread({ title: 'Left thread', raw: true });
      await helpers.putChatPresence({ threadId: thread.id });
      await helpers.deleteChatPresence({ threadId: thread.id });

      await runChat({ turns: REPLY, threadId: thread.id });

      expect(await waitForAssistantPushes({ device, count: 1 })).toHaveLength(1);
    });

    it('does not push when the user opens the thread before the debounce ends', async () => {
      assistantPushConfig.debounceMs = 1500;
      const thread = await helpers.createChatThread({ title: 'Opened late', raw: true });

      await runChat({ turns: REPLY, threadId: thread.id });
      await helpers.putChatPresence({ threadId: thread.id });
      await awaitQuiet({ device });

      expect(assistantPushes({ device })).toEqual([]);
    });

    it('collapses the replies of one thread for the cooldown but not those of another thread', async () => {
      const first = await runChat({ turns: REPLY });
      await waitForAssistantPushes({ device, count: 1 });

      await runChat({ turns: REPLY, threadId: first.threadId, text: 'And again' });
      const other = await runChat({ turns: REPLY, title: 'Other thread' });

      const pushes = await waitForAssistantPushes({ device, count: 2 });
      await awaitQuiet({ device });

      expect(assistantPushes({ device })).toHaveLength(2);
      expect(pushes.map((push) => push.notification.tag).toSorted()).toEqual(
        [`assistant:${first.threadId}`, `assistant:${other.threadId}`].toSorted(),
      );
    });

    it('sends no push for a cancelled run', async () => {
      await helpers.createFirstConnection();
      global.mswMockServer.use(
        createChatScript({ turns: [{ text: ['Working', ' on it', ' still'], pieceDelayMs: 8_000 }] }).handler,
      );
      const thread = await helpers.createChatThread({ title: 'Cancelled', raw: true });
      const sent = await helpers.sendChatMessage({ threadId: thread.id, payload: { text: 'Go' }, raw: true });
      await new Promise((resolve) => setTimeout(resolve, 300));

      await helpers.cancelChatRun({ runId: sent.runId });
      await until(async () => (await ChatMessages.findByPk(sent.messageId))!.status === 'cancelled', {
        timeout: 15_000,
        interval: 50,
      });
      await awaitQuiet({ device });

      expect(assistantPushes({ device })).toEqual([]);
    });
  });

  describe('the group switch', () => {
    it('keeps the in-app entry but sends no push when the assistant group is off', async () => {
      await helpers.patchUserSettings({ patch: { notifications: { push: { groups: { assistant: false } } } } });

      await runChat({ turns: REPLY });
      await until(async () => (await notificationsOfType({ type: NOTIFICATION_TYPES.chatReplyReady })).length === 1, {
        timeout: 10_000,
        interval: 25,
      });
      await awaitQuiet({ device });

      expect(assistantPushes({ device })).toEqual([]);
    });

    it('keeps push.groups.assistant through a later patch of another group', async () => {
      await helpers.patchUserSettings({ patch: { notifications: { push: { groups: { assistant: false } } } } });
      await helpers.patchUserSettings({ patch: { notifications: { push: { groups: { releases: true } } } } });

      const settings = await helpers.getUserSettings({ raw: true });

      expect(settings.notifications?.push?.groups).toStrictEqual({ assistant: false, releases: true });
    });
  });

  describe('the Automation inbox', () => {
    it('pushes three items as one push with the count, and nothing more within the cooldown', async () => {
      // Long enough for three payments to land inside one window.
      assistantPushConfig.debounceMs = 2000;
      const { secret } = await linkedCard();

      for (const amount of ['11.00', '12.00', '13.00']) await walletPayment({ secret, amount });
      const [push, ...rest] = await waitForAssistantPushes({ device, count: 1 });

      expect(rest).toEqual([]);
      expect(push!.notification).toMatchObject({
        title: 'Automation inbox',
        body: '3 new items to review',
        data: { type: NOTIFICATION_TYPES.automationInbox },
      });
      expect(push!.notification.tag).toMatch(/^assistant:/);
      const [entry] = await notificationsOfType({ type: NOTIFICATION_TYPES.automationInbox });
      expect(entry).toMatchObject({ payload: { count: 3 } });

      await walletPayment({ secret, amount: '14.00' });
      await awaitQuiet({ device });

      expect(assistantPushes({ device })).toHaveLength(1);
      expect(await notificationsOfType({ type: NOTIFICATION_TYPES.automationInbox })).toHaveLength(1);
    });

    it('pushes again once the cooldown has passed', async () => {
      assistantPushConfig.inboxCooldownMs = 200;
      const { secret } = await linkedCard();

      await walletPayment({ secret, amount: '11.00' });
      await waitForAssistantPushes({ device, count: 1 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await walletPayment({ secret, amount: '12.00' });

      const pushes = await waitForAssistantPushes({ device, count: 2 });
      expect(pushes.map((push) => push.notification.body)).toEqual(['1 new item to review', '1 new item to review']);
    });

    it('sends nothing while the inbox thread is open', async () => {
      assistantPushConfig.inboxCooldownMs = 1;
      const { secret } = await linkedCard();
      await walletPayment({ secret, amount: '11.00' });
      await waitForAssistantPushes({ device, count: 1 });
      clearCapturedPushRequests();

      const { threadId } = (await notificationsOfType({ type: NOTIFICATION_TYPES.automationInbox }))[0]!.payload as {
        threadId: string;
      };
      await helpers.putChatPresence({ threadId });
      await walletPayment({ secret, amount: '12.00' });
      await awaitQuiet({ device });

      expect(assistantPushes({ device })).toEqual([]);
    });

    it('pushes an unknown-account park as automationInbox only, because it has a card', async () => {
      await helpers.createAccount({ raw: true });
      const { secret } = { secret: (await ingestHelpers.createTestIngestToken()).secret };

      const res = await walletPayment({ secret, card: 'Unlinked Mastercard', amount: '43.60' });
      expect(res.body.response).toMatchObject({ outcome: 'parked', reason: 'unknownAccount' });

      await waitForAssistantPushes({ device, count: 1 });
      await awaitQuiet({ device });

      expect(assistantPushes({ device }).map((push) => push.notification.data.type)).toEqual([
        NOTIFICATION_TYPES.automationInbox,
      ]);
      expect(await notificationsOfType({ type: NOTIFICATION_TYPES.ingestAttention })).toEqual([]);
    });
  });

  describe('parks without a card', () => {
    it('pushes one ingestAttention for aiCapReached, and nothing for a second park the same day', async () => {
      process.env.AI_MONTHLY_CAP_USD_TRIAL = '0';
      const { secret } = await linkedCard();

      const first = await bankPush({ secret });
      expect(first.body.response).toMatchObject({ outcome: 'parked', reason: 'aiCapReached' });
      const [push] = await waitForAssistantPushes({ device, count: 1 });

      expect(push!.notification).toMatchObject({
        title: 'A payment needs attention',
        body: 'A bank notification could not be read: the monthly AI limit is reached.',
        tag: 'assistant:ingest-aiCapReached',
        data: { type: NOTIFICATION_TYPES.ingestAttention },
      });
      expect(JSON.stringify(push)).not.toContain('WOLT');

      const second = await bankPush({ secret });
      expect(second.body.response).toMatchObject({ outcome: 'parked', reason: 'aiCapReached' });
      await awaitQuiet({ device });

      expect(assistantPushes({ device })).toHaveLength(1);
      expect(await notificationsOfType({ type: NOTIFICATION_TYPES.automationInbox })).toEqual([]);
    });

    it('pushes a different reason separately', async () => {
      const { secret } = await linkedCard();
      process.env.AI_MONTHLY_CAP_USD_TRIAL = '0';
      await bankPush({ secret });
      await waitForAssistantPushes({ device, count: 1 });

      delete process.env.AI_MONTHLY_CAP_USD_TRIAL;
      enableServerModel();
      mockNotificationParsing({ answer: () => ({}) });
      process.env.INGEST_AI_DAILY_LIMIT = '0';
      try {
        await bankPush({ secret });
        const pushes = await waitForAssistantPushes({ device, count: 2 });

        expect(pushes.map((push) => push.notification.tag).toSorted()).toEqual([
          'assistant:ingest-aiCapReached',
          'assistant:ingest-aiLimitReached',
        ]);
      } finally {
        delete process.env.INGEST_AI_DAILY_LIMIT;
      }
    });
  });

  describe('reading a thread', () => {
    it('marks the entries about the thread read when it is opened, and leaves the others', async () => {
      const first = await runChat({ turns: REPLY, title: 'First' });
      const second = await runChat({ turns: REPLY, title: 'Second' });
      await until(async () => (await notificationsOfType({ type: NOTIFICATION_TYPES.chatReplyReady })).length === 2, {
        timeout: 10_000,
        interval: 25,
      });

      await helpers.getChatThread({ threadId: first.threadId, raw: true });

      const entries = await Notifications.findAll({ where: { type: NOTIFICATION_TYPES.chatReplyReady } });
      const byThread = Object.fromEntries(
        entries.map((entry) => [(entry.payload as { threadId: string }).threadId, entry.status]),
      );

      expect(byThread[first.threadId]).toBe(NOTIFICATION_STATUSES.read);
      expect(byThread[second.threadId]).toBe(NOTIFICATION_STATUSES.unread);
    });

    it('does not touch the entries of other types', async () => {
      const { threadId } = await runChat({ turns: REPLY });
      await waitForAssistantPushes({ device, count: 1 });
      const system = await helpers.createNotification({
        payload: { type: NOTIFICATION_TYPES.system, title: 'Heads up', payload: { threadId } },
        raw: true,
      });

      await helpers.getChatThread({ threadId, raw: true });

      expect((await Notifications.findByPk(system.id))!.status).toBe(NOTIFICATION_STATUSES.unread);
    });
  });

  describe('PUT and DELETE /chat/presence', () => {
    it('answers 404 for a thread of another user', async () => {
      const other = await helpers.provisionSecondUserWithBaseCurrency();
      const foreign = await helpers.asUser({
        cookies: other.cookies,
        fn: () => helpers.createChatThread({ raw: true }),
      });

      const put = await helpers.putChatPresence({ threadId: foreign.id, raw: false });
      const del = await helpers.deleteChatPresence({ threadId: foreign.id, raw: false });

      expect(put.statusCode).toBe(ERROR_CODES.NotFoundError);
      expect(del.statusCode).toBe(ERROR_CODES.NotFoundError);
    });

    it('answers 404 for a thread that does not exist', async () => {
      const res = await helpers.putChatPresence({ threadId: randomUUID(), raw: false });

      expect(res.statusCode).toBe(ERROR_CODES.NotFoundError);
    });

    it('answers 422 for a body that is not a thread id', async () => {
      const res = await helpers.putChatPresence({ threadId: 'not-an-id', raw: false });
      const missing = await helpers.putChatPresence({ threadId: undefined, raw: false });

      expect(res.statusCode).toBe(ERROR_CODES.ValidationError);
      expect(missing.statusCode).toBe(ERROR_CODES.ValidationError);
    });

    it('lets a read-only user send presence', async () => {
      const thread = await helpers.createChatThread({ raw: true });
      await helpers.setUserBilling({ trialEndsAt: new Date(Date.now() - 86_400_000) });

      const put = await helpers.putChatPresence({ threadId: thread.id, raw: false });
      const del = await helpers.deleteChatPresence({ threadId: thread.id, raw: false });

      expect(put.statusCode).toBe(200);
      expect(del.statusCode).toBe(200);
    });
  });
});
