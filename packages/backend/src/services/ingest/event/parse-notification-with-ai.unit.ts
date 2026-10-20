import { AI_PROVIDER, FEATURES } from '@bt/shared/types';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { aiCallGuards, createAIClient } from '@services/ai';
import { isWithinAiAllowance } from '@services/ai/ai-allowance';
import { trackAiUsage } from '@services/ai/track-ai-usage';
import { getEntitlementsByUserId } from '@services/entitlements/resolve-entitlements.service';
import { resolveAiExtractionFailure } from '@services/import-export/core/ai-extraction-failure';
import { markConnectionValid } from '@services/user-settings/ai-connections';
import { generateText } from 'ai';

import { takeIngestAiCall } from './ai-daily-limit';
import type { NotificationParseOutput } from './classify-notification';
import { notificationFixtures } from './fixtures/notifications';
import { parseNotificationWithAi } from './parse-notification-with-ai';

jest.mock('ai', () => ({
  __esModule: true,
  ...(jest.requireActual('ai') as object),
  generateText: jest.fn(),
}));
jest.mock('@services/ai', () => ({
  createAIClient: jest.fn(),
  aiCallGuards: jest.fn(() => ({ abortSignal: undefined, maxRetries: 0 })),
  AI_MAX_OUTPUT_TOKENS: 1000,
}));
jest.mock('@services/ai/ai-allowance', () => ({ isWithinAiAllowance: jest.fn() }));
jest.mock('@services/ai/track-ai-usage', () => ({ trackAiUsage: jest.fn() }));
jest.mock('@services/entitlements/resolve-entitlements.service', () => ({ getEntitlementsByUserId: jest.fn() }));
jest.mock('@services/import-export/core/ai-extraction-failure', () => ({ resolveAiExtractionFailure: jest.fn() }));
jest.mock('@services/user-settings/ai-connections', () => ({ markConnectionValid: jest.fn() }));
jest.mock('./ai-daily-limit', () => ({ takeIngestAiCall: jest.fn() }));

const mocked = <T>(fn: unknown) => fn as jest.Mock<(...args: never[]) => T>;
const createAIClientMock = mocked<Promise<unknown>>(createAIClient);
const generateTextMock = mocked<Promise<unknown>>(generateText);
const withinAllowanceMock = mocked<Promise<boolean>>(isWithinAiAllowance);
const entitlementsMock = mocked<Promise<unknown>>(getEntitlementsByUserId);
const takeCallMock = mocked<Promise<boolean>>(takeIngestAiCall);
const failureMock = mocked<Promise<unknown>>(resolveAiExtractionFailure);
const trackUsageMock = mocked<Promise<void>>(trackAiUsage);
const markValidMock = mocked<Promise<void>>(markConnectionValid);

const PAYEE_ID = '22222222-2222-4222-8222-222222222222';
const aiClient = {
  model: { id: 'model' },
  provider: AI_PROVIDER.openai,
  modelId: 'openai/test',
  usingUserKey: true,
  connectionId: 'connection-1',
};

const fixture = (id: string) => notificationFixtures.find((candidate) => candidate.id === id)!;

const run = ({
  fixtureId = 'tbc-ka-debit',
  candidates = [{ payeeId: PAYEE_ID, name: 'Wolt', aliases: ['WOLT.COM TBILISI'] }],
}: { fixtureId?: string; candidates?: { payeeId: string; name: string; aliases: string[] }[] } = {}) => {
  const { title, subtitle, body, appName, bundleId } = fixture(fixtureId);

  return parseNotificationWithAi({
    userId: 7,
    text: { title, subtitle, body, raw: null },
    source: { appName, bundleId, sender: null },
    candidates: candidates as never,
    nonZeroCurrencies: ['GEL', 'USD'],
  });
};

const answerWith = (output: NotificationParseOutput) =>
  generateTextMock.mockResolvedValue({ output, usage: { inputTokens: 100, outputTokens: 20 } });

beforeEach(() => {
  jest.resetAllMocks();
  mocked<{ abortSignal: undefined; maxRetries: number }>(aiCallGuards).mockReturnValue({
    abortSignal: undefined,
    maxRetries: 0,
  });
  createAIClientMock.mockResolvedValue(aiClient);
  takeCallMock.mockResolvedValue(true);
  withinAllowanceMock.mockResolvedValue(true);
  entitlementsMock.mockResolvedValue({ features: [FEATURES.operator_ai] });
  trackUsageMock.mockResolvedValue(undefined);
  markValidMock.mockResolvedValue(undefined);
});

describe('parseNotificationWithAi', () => {
  it('reads a notification, charging the call to notificationParsing', async () => {
    answerWith(fixture('tbc-ka-debit').answer);

    const result = await run();

    expect(createAIClientMock).toHaveBeenCalledWith({ userId: 7, feature: 'notification_parsing' });
    expect(result).toMatchObject({
      status: 'parsed',
      classified: {
        verdict: 'payment',
        payment: {
          amount: '43.6',
          currencyCode: 'GEL',
          merchant: 'WOLT.COM TBILISI',
          payee: { type: 'candidate', payeeId: PAYEE_ID },
          balanceAfter: { amount: '1204.3', currencyCode: 'GEL' },
        },
      },
    });
    expect(trackUsageMock).toHaveBeenCalledWith({
      userId: 7,
      feature: 'notification_parsing',
      aiClient,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect(markValidMock).toHaveBeenCalledWith({ userId: 7, connectionId: 'connection-1' });
  });

  it('sends the text as untrusted data with the candidates under short ids and the balance context', async () => {
    answerWith(fixture('tbc-ka-debit').answer);

    await run();

    const call = generateTextMock.mock.calls[0]![0] as unknown as { system: string; prompt: string };
    expect(call.prompt).toContain('<notification>');
    expect(call.prompt).toContain('WOLT.COM TBILISI, 20/10/2026');
    expect(call.prompt).toContain('p1|Wolt|WOLT.COM TBILISI');
    expect(call.prompt).not.toContain(PAYEE_ID);
    expect(call.prompt).toContain('The user holds money at this bank in: GEL, USD.');
    expect(call.system).toContain('untrusted');
    expect(call).not.toHaveProperty('tools');
  });

  it('drops a candidate id the model was not shown', async () => {
    answerWith({ ...fixture('tbc-ka-debit').answer, payee: { candidateId: 'p7', newName: null } });

    const result = await run();

    expect(result).toMatchObject({ status: 'parsed', classified: { payment: { payee: null } } });
  });

  it('classifies a non-payment as ignored', async () => {
    answerWith(fixture('en-sms-otp').answer);

    expect(await run({ fixtureId: 'en-sms-otp', candidates: [] })).toMatchObject({
      status: 'parsed',
      classified: { verdict: 'ignore', reason: 'security' },
    });
  });

  it('parks a low-confidence payment', async () => {
    answerWith({ ...fixture('tbc-ka-debit').answer, confidence: 0.4 });

    expect(await run()).toMatchObject({ classified: { verdict: 'park', reason: 'lowConfidence' } });
  });

  describe('when no AI can answer', () => {
    beforeEach(() => {
      createAIClientMock.mockResolvedValue(null);
    });

    it('is aiUnavailable when nothing is set up, and makes no call', async () => {
      expect(await run()).toEqual({ status: 'unavailable', reason: 'aiUnavailable' });
      expect(generateTextMock).not.toHaveBeenCalled();
      expect(takeCallMock).not.toHaveBeenCalled();
    });

    it('is aiCapReached when the plan has the server model and its monthly allowance is spent', async () => {
      withinAllowanceMock.mockResolvedValue(false);

      expect(await run()).toEqual({ status: 'unavailable', reason: 'aiCapReached' });
    });

    it('is aiUnavailable when the allowance is fine but there is no model', async () => {
      withinAllowanceMock.mockResolvedValue(true);

      expect(await run()).toEqual({ status: 'unavailable', reason: 'aiUnavailable' });
    });

    it('is aiUnavailable when the plan has no server model, whatever the allowance', async () => {
      entitlementsMock.mockResolvedValue({ features: [] });
      withinAllowanceMock.mockResolvedValue(false);

      expect(await run()).toEqual({ status: 'unavailable', reason: 'aiUnavailable' });
    });
  });

  it('is aiLimitReached when the daily limit is spent, with no call', async () => {
    takeCallMock.mockResolvedValue(false);

    expect(await run()).toEqual({ status: 'unavailable', reason: 'aiLimitReached' });
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(trackUsageMock).not.toHaveBeenCalled();
  });

  it('throws the failure message of a failed call, so the job retries, and charges nothing', async () => {
    const cause = new Error('provider down');
    generateTextMock.mockRejectedValue(cause);
    failureMock.mockResolvedValue({ error: { code: 'AI_ERROR', message: 'The AI is busy.' }, cause });

    let thrown: unknown;
    await run().catch((error: unknown) => {
      thrown = error;
    });
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('The AI is busy.');
    expect((thrown as Error).cause).toBe(cause);
    expect(failureMock).toHaveBeenCalledWith({
      userId: 7,
      aiClient,
      error: cause,
      logPrefix: '[Notification Parse]',
    });
    expect(trackUsageMock).not.toHaveBeenCalled();
    expect(markValidMock).not.toHaveBeenCalled();
  });

  it('does not mark a connection valid when the answer came from the server model', async () => {
    createAIClientMock.mockResolvedValue({ ...aiClient, connectionId: undefined, usingUserKey: false });
    answerWith(fixture('tbc-ka-debit').answer);

    await run();

    expect(markValidMock).not.toHaveBeenCalled();
  });
});
