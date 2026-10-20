import { AI_PROVIDER } from '@bt/shared/types';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { aiCallGuards, createAIClient } from '@services/ai';
import { trackAiUsage } from '@services/ai/track-ai-usage';
import { generateText } from 'ai';

import { takeIngestAiCall } from '../event/ai-daily-limit';
import { judgeDuplicates, type JudgeCandidateRow } from './judge-duplicates';
import type { JudgeSubject } from './judge-prompt';

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
jest.mock('@services/ai/track-ai-usage', () => ({ trackAiUsage: jest.fn() }));
jest.mock('../event/ai-daily-limit', () => ({ takeIngestAiCall: jest.fn() }));

const mocked = <T>(fn: unknown) => fn as jest.Mock<(...args: never[]) => T>;
const createAIClientMock = mocked<Promise<unknown>>(createAIClient);
const generateTextMock = mocked<Promise<unknown>>(generateText);
const takeCallMock = mocked<Promise<boolean>>(takeIngestAiCall);
const trackUsageMock = mocked<Promise<void>>(trackAiUsage);

const aiClient = {
  model: { id: 'model' },
  provider: AI_PROVIDER.openai,
  modelId: 'openai/test',
  usingUserKey: true,
  connectionId: 'connection-1',
};

const payment: JudgeSubject = {
  direction: 'debit',
  amount: 29.41,
  currencyCode: 'GEL',
  originalAmount: null,
  originalCurrencyCode: null,
  time: new Date('2026-10-20T14:38:00.000Z'),
  names: ['Wolt'],
  slots: ['tap'],
};
const candidates: JudgeCandidateRow[] = [
  { ...payment, id: 'id-a' as never, slots: [] },
  { ...payment, id: 'id-b' as never, amount: 30, slots: ['wallet-notification'] },
];

const run = () => judgeDuplicates({ userId: 7, payment, candidates, locale: 'en' });

beforeEach(() => {
  jest.resetAllMocks();
  mocked<{ abortSignal: undefined; maxRetries: number }>(aiCallGuards).mockReturnValue({
    abortSignal: undefined,
    maxRetries: 0,
  });
  createAIClientMock.mockResolvedValue(aiClient);
  takeCallMock.mockResolvedValue(true);
  trackUsageMock.mockResolvedValue(undefined);
});

describe('judgeDuplicates', () => {
  it('sends short ids and maps the answer back to the transactions, charging duplicateMatching', async () => {
    generateTextMock.mockResolvedValue({
      output: {
        matches: [
          { id: 'c2', confidence: 0.95, reason: 'same shop and amount' },
          { id: 'c7', confidence: 0.99, reason: 'invented' },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await run();

    expect(result).toEqual([{ candidateId: 'id-b', confidence: 0.95, reason: 'same shop and amount' }]);

    const { prompt, system } = generateTextMock.mock.calls[0]![0] as unknown as { prompt: string; system: string };
    expect(prompt).toContain('c1 | 29.41 GEL');
    expect(prompt).toContain('c2 | 30 GEL');
    expect(prompt).not.toContain('id-a');
    expect(system).toContain('SAME real-world payment');
    expect(createAIClientMock).toHaveBeenCalledWith({ userId: 7, feature: 'duplicate_matching' });
    expect(trackUsageMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, feature: 'duplicate_matching' }));
  });

  it('answers nothing without a client, and makes no call', async () => {
    createAIClientMock.mockResolvedValue(null);

    expect(await run()).toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(takeCallMock).not.toHaveBeenCalled();
  });

  it('answers nothing once the daily limit is spent, and makes no call', async () => {
    takeCallMock.mockResolvedValue(false);

    expect(await run()).toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('answers nothing, and asks no one, when there is no candidate', async () => {
    expect(await judgeDuplicates({ userId: 7, payment, candidates: [], locale: 'en' })).toEqual([]);
    expect(createAIClientMock).not.toHaveBeenCalled();
  });

  it('throws when the call fails, and does not charge it', async () => {
    generateTextMock.mockRejectedValue(new Error('boom'));

    await expect(run()).rejects.toThrow('boom');
    expect(trackUsageMock).not.toHaveBeenCalled();
  });
});
