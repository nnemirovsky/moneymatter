import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import { DOMAIN_EVENTS, eventBus } from '@services/common/event-bus';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { createOpenAiConnection, errorMessage } from '@tests/helpers/user-settings';
import { GEMINI_API_URL } from '@tests/mocks/gemini/mock-api';
import { OPENAI_RESPONSES_URL, VALID_OPENAI_API_KEY } from '@tests/mocks/openai/mock-api';
import { HttpResponse, http } from 'msw';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from './constants';
import { notificationIngestQueue } from './notification-queue';

const DEFAULT_TIMINGS = { ...notificationTimings, aiRetryScheduleMs: [...notificationTimings.aiRetryScheduleMs] };
const TEST_TIMEOUT_MS = 60_000;

/** A push the layout rules cannot settle (no word says whether money left or arrived), so the model reads it. */
const UNCLEAR_PUSH = 'Ref 7731: 60.64 EUR at Cafe Moon, card *4455';

/** What the model answers for it. */
const ANSWER = {
  kind: 'debit',
  stage: 'payment',
  isOwnAccountTransfer: false,
  amount: '60.64',
  currency: 'EUR',
  originalAmount: null,
  originalCurrency: null,
  merchant: 'Cafe Moon',
  payee: null,
  cardName: 'Example Visa',
  cardLastDigits: '4455',
  balanceAfter: null,
  occurredAt: null,
  confidence: 0.95,
};

type Mode = 'limited' | 'down' | 'ok';

const geminiText = ({ text }: { text: string }) =>
  HttpResponse.json({
    candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
  });

/** The server model answers by `mode`: out of quota (429), down (500) or with the reading. */
const serveModel = () => {
  const state = { mode: 'limited' as Mode, calls: 0 };
  global.mswMockServer.use(
    http.post(GEMINI_API_URL, async ({ request }) => {
      const body = (await request.clone().json()) as { contents?: { parts?: { text?: string }[] }[] };
      const prompt = (body.contents ?? [])
        .flatMap((content) => content.parts ?? [])
        .map((part) => part.text ?? '')
        .join('\n');
      if (!prompt.includes('NOTIFICATION (untrusted text')) return geminiText({ text: '# No categorizations' });

      state.calls += 1;
      if (state.mode === 'limited') {
        return HttpResponse.json(
          { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } },
          { status: 429 },
        );
      }
      if (state.mode === 'down') {
        return HttpResponse.json(
          { error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } },
          { status: 503 },
        );
      }

      return geminiText({ text: JSON.stringify(ANSWER) });
    }),
  );

  return state;
};

const setUp = async () => {
  const eur = await helpers.createAccount({
    payload: helpers.buildAccountPayload({ name: 'Example EUR', currencyCode: 'EUR', initialBalance: 1000 }),
    raw: true,
  });
  await helpers.createCardMapping({ payload: { cardLabel: 'Example Visa', accountId: eur.id }, raw: true });
  const { secret } = await ingestHelpers.createTestIngestToken();
  // The bank's app is met on a first notification without an amount, then approved.
  await ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'Example Bank',
      title: 'Example',
      subtitle: '',
      body: 'Welcome',
      idempotencyKey: `hello-${randomUUID()}`,
    },
  });
  const [source] = await helpers.listNotificationSources({ raw: true });
  await helpers.updateNotificationSource({ id: source!.id, payload: { mode: 'approved' }, raw: true });

  return { secret, eur };
};

const sendPush = ({ secret }: { secret: string }) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'Example Bank',
      title: 'Example',
      subtitle: '',
      body: UNCLEAR_PUSH,
      idempotencyKey: `push-${randomUUID()}`,
    },
  });

const onlyRequest = async () =>
  (
    await IngestRequests.findAll({
      where: { pipeline: 'notification', status: ['parked', 'received', 'logged'] },
      order: [['createdAt', 'DESC']],
    })
  )[0]!;

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

describe('a notification while the AI model is out of reach', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    enableServerModel();
    notificationTimings.aiRetryScheduleMs = [300, 300];
    await resetLimits();
  });
  afterEach(async () => {
    Object.assign(notificationTimings, DEFAULT_TIMINGS);
    await resetLimits();
  });

  it(
    'logs a plain card payment from its layout without asking the model, even while the model is out of quota',
    async () => {
      const model = serveModel();
      const { secret, eur } = await setUp();
      await helpers.createCardMapping({ payload: { cardLabel: 'Visa', accountId: eur.id }, raw: true });

      const sent = await ingestHelpers.postIngestEvent({
        secret,
        body: {
          kind: 'notification',
          app: 'Example Bank',
          title: 'Example',
          subtitle: '',
          body: 'Purchase 60.64 EUR\nVisa *4455\nCafe Moon 15.01.2026 17:38',
          idempotencyKey: `push-${randomUUID()}`,
        },
      });

      expect(sent.body.response).toMatchObject({ outcome: 'logged' });
      expect(model.calls).toBe(0);
      expect(await onlyRequest()).toMatchObject({ status: 'logged' });
      expect((await onlyRequest()).parsed).toMatchObject({
        parser: 'rules',
        payment: { merchant: 'Cafe Moon', amount: '60.64' },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'waits as a used-up quota instead of failing, says so, and is read by itself when the model is back',
    async () => {
      const model = serveModel();
      const { secret } = await setUp();

      const sent = await sendPush({ secret });

      expect(sent.body.response).toMatchObject({ outcome: 'parked', reason: 'aiQuotaWait' });
      expect(sent.body.response.summary).toMatch(
        /Waiting: the AI quota of MoneyMatter AI is used up\. Retrying automatically \(next try about .+\)\./u,
      );
      const waiting = await onlyRequest();
      expect(waiting).toMatchObject({ status: 'parked', reason: 'aiQuotaWait' });
      expect(waiting.payload.aiRetry).toMatchObject({
        count: 1,
        kind: 'rate-limited',
        connectionName: 'MoneyMatter AI',
      });

      // The model comes back before the next try: the request is read and logged with nobody tapping anything.
      model.mode = 'ok';
      await until(async () => (await onlyRequest()).status === 'logged', { timeout: 30_000, interval: 250 });
      expect((await onlyRequest()).transactionId).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps waiting through several tries, then stops trying by itself and says so, and a retry by hand still works',
    async () => {
      notificationTimings.aiRetryScheduleMs = [300];
      const model = serveModel();
      const { secret } = await setUp();

      await sendPush({ secret });
      await until(
        async () =>
          (await onlyRequest()).payload.aiRetry !== undefined &&
          (await onlyRequest()).summary?.includes('No more automatic tries') === true,
        {
          timeout: 40_000,
          interval: 250,
        },
      );

      const stopped = await onlyRequest();
      expect(stopped).toMatchObject({ status: 'parked', reason: 'aiQuotaWait' });
      expect(stopped.payload.aiRetry).toMatchObject({ count: 2, at: null });

      model.mode = 'ok';
      const retried = await helpers.retryCardPaymentRequest({ id: stopped.id, raw: true });

      expect(retried.outcome).toBe('logged');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers a retry by hand that fails again with the same reason, not the generic one',
    async () => {
      notificationTimings.aiRetryScheduleMs = [];
      serveModel();
      const { secret } = await setUp();
      await sendPush({ secret });
      const waiting = await onlyRequest();

      const retried = await helpers.retryCardPaymentRequest({ id: waiting.id, raw: true });

      expect(retried).toMatchObject({ outcome: 'parked', reason: 'aiQuotaWait' });
      expect((retried as { summary: string }).summary).toContain('the AI quota of MoneyMatter AI is used up');
      expect((retried as { summary: string }).summary).not.toContain('could not process');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps one pending try when the owner retries by hand, and restarts the schedule',
    async () => {
      notificationTimings.aiRetryScheduleMs = [3_600_000, 3_600_000];
      serveModel();
      const { secret } = await setUp();
      await sendPush({ secret });
      const waiting = await onlyRequest();
      expect(await notificationIngestQueue.getDelayedCount()).toBe(1);

      const retried = await helpers.retryCardPaymentRequest({ id: waiting.id, raw: true });

      expect(retried).toMatchObject({ outcome: 'parked', reason: 'aiQuotaWait' });
      expect(await notificationIngestQueue.getDelayedCount()).toBe(1);
      expect((await onlyRequest()).payload.aiRetry).toMatchObject({ count: 1 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'tells the owner once, not at every automatic try',
    async () => {
      notificationTimings.aiRetryScheduleMs = [300, 300, 300];
      serveModel();
      const parked: string[] = [];
      const listener = ({ reason }: { reason: string }) => parked.push(reason);
      eventBus.on(DOMAIN_EVENTS.INGEST_REQUEST_PARKED, listener);
      try {
        const { secret } = await setUp();
        await sendPush({ secret });

        await until(async () => ((await onlyRequest()).payload.aiRetry as { count: number } | undefined)?.count === 3, {
          timeout: 50_000,
          interval: 250,
        });
      } finally {
        eventBus.off(DOMAIN_EVENTS.INGEST_REQUEST_PARKED, listener);
      }

      expect(parked.filter((reason) => reason === 'aiQuotaWait')).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'tells an overloaded provider from a used-up quota',
    async () => {
      const model = serveModel();
      model.mode = 'down';
      const { secret } = await setUp();

      const sent = await sendPush({ secret });

      expect(sent.body.response).toMatchObject({ outcome: 'parked', reason: 'aiQuotaWait' });
      expect(sent.body.response.summary).toContain('MoneyMatter AI cannot take AI requests right now');
      expect((await onlyRequest()).payload.aiRetry).toMatchObject({ kind: 'temporary' });
    },
    TEST_TIMEOUT_MS,
  );

  describe('with a second AI connection of the owner', () => {
    const answerOn = ({ apiKey, limited }: { apiKey: string; limited: boolean }) =>
      http.post(OPENAI_RESPONSES_URL, ({ request }) => {
        if (request.headers.get('authorization') !== `Bearer ${apiKey}`) return undefined;
        if (limited) {
          return HttpResponse.json(
            {
              error: {
                message: 'You exceeded your current quota',
                type: 'insufficient_quota',
                code: 'rate_limit_exceeded',
              },
            },
            { status: 429 },
          );
        }

        return HttpResponse.json({
          id: 'resp_test',
          object: 'response',
          created_at: 1_700_000_000,
          model: 'gpt-5.4-nano',
          output: [
            {
              type: 'message',
              role: 'assistant',
              id: 'msg_test',
              content: [{ type: 'output_text', text: JSON.stringify(ANSWER), annotations: [] }],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 1 },
        });
      });

    it(
      'offers the other connection on the waiting payment, and reads it there only when the owner asks',
      async () => {
        const LIMITED_KEY = `${VALID_OPENAI_API_KEY}-limited`;
        const first = await createOpenAiConnection({ name: 'Work key', apiKey: VALID_OPENAI_API_KEY });
        const second = await createOpenAiConnection({ name: 'Spare key', apiKey: LIMITED_KEY });
        await helpers.setDefaultAiConnection({ id: second.id, raw: true });
        global.mswMockServer.use(
          answerOn({ apiKey: VALID_OPENAI_API_KEY, limited: false }),
          answerOn({ apiKey: LIMITED_KEY, limited: true }),
        );
        notificationTimings.aiRetryScheduleMs = [];
        const { secret } = await setUp();

        const sent = await sendPush({ secret });

        expect(sent.body.response.summary).toContain('the AI quota of Spare key is used up');
        const [waiting] = await helpers.listCardPaymentRequests({ raw: true });
        expect(waiting).toMatchObject({
          reason: 'aiQuotaWait',
          aiRetryAt: null,
          aiAlternatives: [{ id: first.id, name: 'Work key' }],
        });

        // Nothing switched by itself.
        expect((await onlyRequest()).status).toBe('parked');

        const retried = await helpers.retryCardPaymentRequest({
          id: waiting!.id,
          payload: { aiConnectionId: first.id },
          raw: true,
        });

        expect(retried.outcome).toBe('logged');
        expect((await onlyRequest()).payload.aiPin).toBe(first.id);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'refuses a connection that is not the owner’s',
      async () => {
        notificationTimings.aiRetryScheduleMs = [];
        serveModel();
        const { secret } = await setUp();
        await sendPush({ secret });
        const waiting = await onlyRequest();

        const response = await helpers.retryCardPaymentRequest({ id: waiting.id, payload: { aiConnectionId: 'nope' } });

        expect(response.statusCode).toBe(422);
        expect(errorMessage({ response })).toContain('not available');
      },
      TEST_TIMEOUT_MS,
    );
  });
});
