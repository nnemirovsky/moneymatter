import { PLANS } from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { isPostHogEnabled, trackAiCapReached, trackAiUsageMonthEnd } from '@js/utils/posthog';
import { redisClient } from '@root/redis-client';

import { getEntitlementsByUserId } from '../entitlements/resolve-entitlements.service';
import { getAiAllowance, recordAiSpend, reportMonthEndAiUsage } from './ai-allowance';

jest.mock('../entitlements/resolve-entitlements.service', () => ({ getEntitlementsByUserId: jest.fn() }));
jest.mock('@js/utils/logger', () => ({ logger: { error: jest.fn() } }));
jest.mock('@js/utils/posthog', () => ({
  isPostHogEnabled: jest.fn(),
  trackAiCapReached: jest.fn(),
  trackAiUsageMonthEnd: jest.fn(),
}));

const ENV_VARS = ['AI_MONTHLY_CAP_USD_PLUS', 'AI_MONTHLY_CAP_USD_TRIAL'] as const;
const TRIAL = { plan: null, subscriptions: [] };
const PLUS = { plan: PLANS.plus, subscriptions: [] };

const redisGetMock = jest.mocked(redisClient.get) as unknown as jest.Mock<(key: string) => Promise<string | null>>;

const allowance = ({
  spentUsd,
  entitlements = TRIAL,
}: {
  spentUsd: number;
  entitlements?: typeof TRIAL | typeof PLUS;
}) => {
  redisGetMock.mockResolvedValue(String(spentUsd * 1_000_000));
  return getAiAllowance({ userId: 1, entitlements });
};

const envBeforeTest = new Map<string, string | undefined>();

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of ENV_VARS) {
    envBeforeTest.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV_VARS) {
    const value = envBeforeTest.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('getAiAllowance', () => {
  it('returns null when no cap is set for the user', async () => {
    process.env.AI_MONTHLY_CAP_USD_PLUS = '10';

    expect(await allowance({ spentUsd: 5 })).toBeNull();
  });

  it.each([
    [0, 0, 'ok'],
    [5.9, 59, 'ok'],
    [6, 60, 'warning'],
    [10, 100, 'reached'],
    [25, 100, 'reached'],
  ])('spending $%d of $10 reads %d%% and %s', async (spentUsd, usedPercent, state) => {
    process.env.AI_MONTHLY_CAP_USD_TRIAL = '10';

    expect(await allowance({ spentUsd })).toMatchObject({ usedPercent, state, plan: 'trial' });
  });

  it('reads the Plus cap for a paid Plus user', async () => {
    process.env.AI_MONTHLY_CAP_USD_TRIAL = '1';
    process.env.AI_MONTHLY_CAP_USD_PLUS = '10';

    expect(await allowance({ spentUsd: 2, entitlements: PLUS })).toMatchObject({ usedPercent: 20, plan: 'plus' });
    expect(await allowance({ spentUsd: 2 })).toMatchObject({ state: 'reached', plan: 'trial' });
  });

  it('treats a zero cap as reached', async () => {
    process.env.AI_MONTHLY_CAP_USD_TRIAL = '0';

    expect(await allowance({ spentUsd: 0 })).toMatchObject({ usedPercent: 100, state: 'reached' });
  });

  it('reads the current UTC month and resets at the start of the next one, across a year boundary', async () => {
    process.env.AI_MONTHLY_CAP_USD_TRIAL = '10';
    jest.useFakeTimers({ now: new Date('2026-12-31T23:59:00Z') });

    try {
      const result = await allowance({ spentUsd: 1 });

      expect(redisGetMock).toHaveBeenLastCalledWith('ai-spend:1:2026-12');
      expect(result?.resetsAt).toBe('2027-01-01T00:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails open when Redis cannot be read', async () => {
    process.env.AI_MONTHLY_CAP_USD_TRIAL = '10';
    redisGetMock.mockRejectedValueOnce(new Error('redis down'));

    expect(await getAiAllowance({ userId: 1, entitlements: TRIAL })).toMatchObject({ state: 'ok', usedPercent: 0 });
  });
});

describe('recordAiSpend', () => {
  it('resolves when Redis rejects the write', async () => {
    jest.mocked(redisClient.incrby).mockRejectedValueOnce(new Error('redis down'));

    await expect(recordAiSpend({ userId: 1, costUsd: 0.5 })).resolves.toBeUndefined();
  });
});

const spendThrice = async () => {
  jest
    .mocked(redisClient.incrby)
    .mockResolvedValueOnce(500_000)
    .mockResolvedValueOnce(1_000_000)
    .mockResolvedValueOnce(1_500_000);
  for (let i = 0; i < 3; i++) await recordAiSpend({ userId: 1, costUsd: 0.5 });
};

describe('ai_cap_reached', () => {
  const entitlementsMock = jest.mocked(getEntitlementsByUserId);

  beforeEach(() => {
    jest.mocked(isPostHogEnabled).mockReturnValue(true);
    process.env.AI_MONTHLY_CAP_USD_TRIAL = '1';
    entitlementsMock.mockResolvedValue(TRIAL as never);
  });

  it('fires only on the call that lands on the cap, and looks up the plan only for that call', async () => {
    await spendThrice();

    expect(trackAiCapReached).toHaveBeenCalledTimes(1);
    expect(trackAiCapReached).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, plan: 'trial', capUsd: 1 }));
    expect(entitlementsMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when analytics is off', async () => {
    jest.mocked(isPostHogEnabled).mockReturnValue(false);

    await spendThrice();

    expect(trackAiCapReached).not.toHaveBeenCalled();
    expect(entitlementsMock).not.toHaveBeenCalled();
  });

  it('still resolves when the plan lookup fails', async () => {
    entitlementsMock.mockRejectedValue(new Error('db down'));

    await expect(spendThrice()).resolves.toBeUndefined();
    expect(trackAiCapReached).not.toHaveBeenCalled();
  });
});

describe('reportMonthEndAiUsage', () => {
  beforeEach(() => {
    process.env.AI_MONTHLY_CAP_USD_TRIAL = '10';
    jest.mocked(getEntitlementsByUserId).mockResolvedValue(TRIAL as never);
    jest.mocked(redisClient.keys).mockResolvedValue(['ai-spend:7:2026-10', 'ai-spend:8:2026-10']);
    redisGetMock.mockResolvedValue('2500000');
  });

  it('reports each spender against their cap for the given month', async () => {
    expect(await reportMonthEndAiUsage({ month: '2026-10' })).toEqual({ reported: 2, failed: 0 });

    expect(redisClient.keys).toHaveBeenCalledWith('ai-spend:*:2026-10');
    expect(redisGetMock).toHaveBeenCalledWith('ai-spend:7:2026-10');
    expect(trackAiUsageMonthEnd).toHaveBeenCalledWith({
      userId: 7,
      plan: 'trial',
      capUsd: 10,
      spentUsd: 2.5,
      month: '2026-10',
    });
  });

  it('keeps reporting other users when one fails', async () => {
    jest.mocked(getEntitlementsByUserId).mockRejectedValueOnce(new Error('db down'));

    expect(await reportMonthEndAiUsage({ month: '2026-10' })).toEqual({ reported: 1, failed: 1 });
    expect(trackAiUsageMonthEnd).toHaveBeenCalledWith(expect.objectContaining({ userId: 8 }));
  });

  it('skips users with no cap', async () => {
    delete process.env.AI_MONTHLY_CAP_USD_TRIAL;

    expect(await reportMonthEndAiUsage({ month: '2026-10' })).toEqual({ reported: 0, failed: 0 });
    expect(trackAiUsageMonthEnd).not.toHaveBeenCalled();
  });
});
