import type { AIAllowance } from '@bt/shared/types';

import { trackEvent } from '../index';

/** Fired by the call whose spend crosses the monthly cap. */
export function trackAiCapReached({
  userId,
  plan,
  capUsd,
  month,
  dayOfMonth,
}: {
  userId: number;
  plan: AIAllowance['plan'];
  capUsd: number;
  month: string;
  dayOfMonth: number;
}): void {
  trackEvent({
    userId,
    event: 'ai_cap_reached',
    properties: {
      plan,
      cap_usd: capUsd,
      month,
      day_of_month: dayOfMonth,
    },
  });
}

/** One per user with AI spend in the month, sent right after it ends. */
export function trackAiUsageMonthEnd({
  userId,
  plan,
  capUsd,
  spentUsd,
  month,
}: {
  userId: number;
  plan: AIAllowance['plan'];
  capUsd: number;
  spentUsd: number;
  month: string;
}): void {
  trackEvent({
    userId,
    event: 'ai_usage_month_end',
    properties: {
      plan,
      cap_usd: capUsd,
      spent_usd: spentUsd,
      left_usd: Math.max(0, capUsd - spentUsd),
      used_percent: capUsd === 0 ? 100 : Math.round((spentUsd / capUsd) * 100),
      month,
    },
  });
}
