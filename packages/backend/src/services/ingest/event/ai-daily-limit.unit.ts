import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { RateLimitService } from '@services/common/rate-limit.service';

import { DEFAULT_INGEST_AI_DAILY_LIMIT, getIngestAiDailyLimit, takeIngestAiCall } from './ai-daily-limit';

describe('getIngestAiDailyLimit', () => {
  const original = process.env.INGEST_AI_DAILY_LIMIT;

  afterEach(() => {
    if (original === undefined) delete process.env.INGEST_AI_DAILY_LIMIT;
    else process.env.INGEST_AI_DAILY_LIMIT = original;
  });

  it('defaults to 300', () => {
    delete process.env.INGEST_AI_DAILY_LIMIT;

    expect(getIngestAiDailyLimit()).toBe(DEFAULT_INGEST_AI_DAILY_LIMIT);
    expect(DEFAULT_INGEST_AI_DAILY_LIMIT).toBe(300);
  });

  it('reads the operator figure on every call', () => {
    process.env.INGEST_AI_DAILY_LIMIT = '25';
    expect(getIngestAiDailyLimit()).toBe(25);

    process.env.INGEST_AI_DAILY_LIMIT = '0';
    expect(getIngestAiDailyLimit()).toBe(0);
  });

  it.each(['', 'abc', '-4', '1.5'])('falls back to the default for "%s"', (value) => {
    process.env.INGEST_AI_DAILY_LIMIT = value;

    expect(getIngestAiDailyLimit()).toBe(DEFAULT_INGEST_AI_DAILY_LIMIT);
  });
});

describe('takeIngestAiCall', () => {
  const checkRateLimit = jest.spyOn(RateLimitService, 'checkRateLimit');

  beforeEach(() => {
    delete process.env.INGEST_AI_DAILY_LIMIT;
    checkRateLimit.mockReset();
  });

  it('counts the call against the user on a daily window and allows it under the limit', async () => {
    checkRateLimit.mockResolvedValue({ allowed: true });

    await expect(takeIngestAiCall({ userId: 7 })).resolves.toBe(true);
    expect(checkRateLimit).toHaveBeenCalledWith('ingest-ai:d:7', 86_400, 300);
  });

  it('refuses the call over the limit', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remainingSeconds: 600 });

    await expect(takeIngestAiCall({ userId: 7 })).resolves.toBe(false);
  });

  it('refuses every call when the operator sets the limit to zero, without counting', async () => {
    process.env.INGEST_AI_DAILY_LIMIT = '0';

    await expect(takeIngestAiCall({ userId: 7 })).resolves.toBe(false);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('uses the operator figure as the cap', async () => {
    process.env.INGEST_AI_DAILY_LIMIT = '12';
    checkRateLimit.mockResolvedValue({ allowed: true });

    await takeIngestAiCall({ userId: 7 });

    expect(checkRateLimit).toHaveBeenCalledWith('ingest-ai:d:7', 86_400, 12);
  });
});
