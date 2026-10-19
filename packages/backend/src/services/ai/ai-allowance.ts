import { type AIAllowance, type Entitlements, hasPaidPlus } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { isPostHogEnabled, trackAiCapReached, trackAiUsageMonthEnd } from '@js/utils/posthog';
import { redisClient } from '@root/redis-client';

import { getEntitlementsByUserId } from '../entitlements/resolve-entitlements.service';

const MICROS_PER_USD = 1_000_000;
const WARNING_RATIO = 0.6;
const KEY_TTL_SECONDS = 40 * 24 * 60 * 60;

/** `YYYY-MM` in UTC, the period one spend counter covers. */
export const monthOf = ({ now }: { now: Date }) => now.toISOString().slice(0, 7);

const spendKey = ({ userId, month }: { userId: number | '*'; month: string }) => `ai-spend:${userId}:${month}`;

/** Unset means no cap, which is what self-hosters get. */
const monthlyCapUsd = ({ paidPlus }: { paidPlus: boolean }): number | null => {
  const envVar = paidPlus ? 'AI_MONTHLY_CAP_USD_PLUS' : 'AI_MONTHLY_CAP_USD_TRIAL';
  const raw = process.env[envVar];
  if (!raw) return null;

  const cap = Number(raw);
  if (Number.isFinite(cap) && cap >= 0) return cap;

  logger.error('Invalid AI cap env var, treating it as no cap', { envVar, raw });
  return null;
};

const capFor = ({
  entitlements,
}: {
  entitlements: Pick<Entitlements, 'plan' | 'subscriptions'>;
}): { capUsd: number | null; plan: AIAllowance['plan'] } => {
  const paidPlus = hasPaidPlus({ entitlements });
  return { capUsd: monthlyCapUsd({ paidPlus }), plan: paidPlus ? 'plus' : 'trial' };
};

const crosses = ({ capUsd, spentMicros, addedMicros }: { capUsd: number; spentMicros: number; addedMicros: number }) =>
  spentMicros >= capUsd * MICROS_PER_USD && spentMicros - addedMicros < capUsd * MICROS_PER_USD;

/** Spend only grows within a month, so this fires at most once per user per month. */
const trackCapCrossing = async ({
  userId,
  spentMicros,
  addedMicros,
  now,
}: {
  userId: number;
  spentMicros: number;
  addedMicros: number;
  now: Date;
}): Promise<void> => {
  if (!isPostHogEnabled()) return;

  // Skips the entitlements lookup on every call that crosses neither plan's cap.
  const anyCapCrossed = [false, true].some((paidPlus) => {
    const capUsd = monthlyCapUsd({ paidPlus });
    return capUsd !== null && crosses({ capUsd, spentMicros, addedMicros });
  });
  if (!anyCapCrossed) return;

  try {
    const { capUsd, plan } = capFor({ entitlements: await getEntitlementsByUserId({ userId }) });
    if (capUsd !== null && crosses({ capUsd, spentMicros, addedMicros })) {
      trackAiCapReached({ userId, plan, capUsd, month: monthOf({ now }), dayOfMonth: now.getUTCDate() });
    }
  } catch (error) {
    logger.error({ message: 'Failed to track AI cap crossing', error: error as Error }, { userId });
  }
};

export const recordAiSpend = async ({ userId, costUsd }: { userId: number; costUsd: number }): Promise<void> => {
  if (costUsd <= 0) return;

  const now = new Date();
  const addedMicros = Math.round(costUsd * MICROS_PER_USD);
  const key = spendKey({ userId, month: monthOf({ now }) });
  let spentMicros: number;
  try {
    spentMicros = await redisClient.incrby(key, addedMicros);
    await redisClient.expire(key, KEY_TTL_SECONDS);
  } catch (error) {
    logger.error({ message: 'Failed to record AI spend', error: error as Error }, { userId });
    return;
  }

  await trackCapCrossing({ userId, spentMicros, addedMicros, now });
};

/**
 * Null when no cap applies to the user. Fails open: an unreachable Redis reads as nothing spent.
 *
 * ponytail: checked before a call and recorded after it, so one big run can overshoot the cap.
 * Reserve spend up front if overshoot ever matters.
 */
export const getAiAllowance = async ({
  userId,
  entitlements,
}: {
  userId: number;
  entitlements?: Pick<Entitlements, 'plan' | 'subscriptions'>;
}): Promise<AIAllowance | null> => {
  const { capUsd, plan } = capFor({ entitlements: entitlements ?? (await getEntitlementsByUserId({ userId })) });
  if (capUsd === null) return null;

  const now = new Date();
  let spentMicros = 0;
  try {
    spentMicros = Number(await redisClient.get(spendKey({ userId, month: monthOf({ now }) }))) || 0;
  } catch (error) {
    logger.error({ message: 'Failed to read AI spend, treating it as zero', error: error as Error });
  }

  const ratio = capUsd === 0 ? 1 : spentMicros / (capUsd * MICROS_PER_USD);

  return {
    usedPercent: Math.min(100, Math.floor(ratio * 100)),
    state: ratio >= 1 ? 'reached' : ratio >= WARNING_RATIO ? 'warning' : 'ok',
    resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    plan,
  };
};

export const isWithinAiAllowance = async (params: Parameters<typeof getAiAllowance>[0]): Promise<boolean> =>
  (await getAiAllowance(params))?.state !== 'reached';

/**
 * Users who spent nothing in the month have no key and are not reported. Each key is re-read
 * through `spendKey` because `keys()` returns ioredis-prefixed names that `get` would prefix again.
 *
 * ponytail: KEYS blocks Redis while it walks the keyspace, fine at one call a month. Switch to
 * SCAN if the keyspace grows large.
 */
export const reportMonthEndAiUsage = async ({
  month,
}: {
  month: string;
}): Promise<{ reported: number; failed: number }> => {
  const keys = await redisClient.keys(spendKey({ userId: '*', month }));

  let reported = 0;
  let failed = 0;
  for (const key of keys) {
    const userId = Number(key.match(/ai-spend:(\d+):/)?.[1]);
    if (!Number.isInteger(userId)) continue;

    try {
      const { capUsd, plan } = capFor({ entitlements: await getEntitlementsByUserId({ userId }) });
      if (capUsd === null) continue;

      const spentMicros = Number(await redisClient.get(spendKey({ userId, month }))) || 0;
      trackAiUsageMonthEnd({ userId, plan, capUsd, spentUsd: spentMicros / MICROS_PER_USD, month });
      reported++;
    } catch (error) {
      failed++;
      logger.error({ message: 'Failed to report month-end AI usage', error: error as Error }, { userId });
    }
  }

  return { reported, failed };
};
