import { redisClient } from '@root/redis-client';

import { assistantPushConfig } from './assistant-push-config';

/**
 * What a push is waiting on. Each `slot` is one stream of pushes that collapses into one:
 *
 * - `thread`: replies and waiting cards of one chat thread (`key` is the thread id);
 * - `inbox`: new items of the Automation inbox (`key` is the inbox thread id);
 * - `ingest`: parked payments without a card (`key` is the park reason).
 */
const ASSISTANT_PUSH_SLOTS = ['thread', 'inbox', 'ingest'] as const;

export type AssistantPushSlot = (typeof ASSISTANT_PUSH_SLOTS)[number];

export interface AssistantPushTarget {
  slot: AssistantPushSlot;
  userId: number;
  key: string;
}

/** Keeps the pending state past the debounce window even when the worker is slow. */
const STATE_MARGIN_MS = 60 * 60_000;

const stateKeys = ({ slot, userId, key }: AssistantPushTarget) => {
  const base = `assistant-push:${slot}:${userId}:${key}`;

  return {
    /** Exists from a push until its cooldown ends; events meanwhile are dropped. */
    cooldown: `${base}:cooldown`,
    /** Events since the last push. */
    count: `${base}:count`,
    /** Exists while a delayed job is waiting, so one window schedules one job. */
    window: `${base}:window`,
    /** What the job needs to build its notification; the latest event wins. */
    detail: `${base}:detail`,
  };
};

/**
 * Records an event for `target`. Returns true when it opened a window, which is the caller's cue to
 * schedule the delayed job; false when the target is cooling down or a job is already waiting.
 */
export const recordPushEvent = async ({
  target,
  detail,
}: {
  target: AssistantPushTarget;
  detail: Record<string, unknown>;
}): Promise<{ cooling: boolean; opened: boolean }> => {
  const keys = stateKeys(target);
  if ((await redisClient.exists(keys.cooldown)) === 1) return { cooling: true, opened: false };

  const ttl = assistantPushConfig.debounceMs + STATE_MARGIN_MS;
  await redisClient.set(keys.detail, JSON.stringify(detail), 'PX', ttl);
  await redisClient.incr(keys.count);
  await redisClient.pexpire(keys.count, ttl);

  const opened = await redisClient.set(keys.window, '1', 'PX', Math.max(1, assistantPushConfig.debounceMs), 'NX');

  return { cooling: false, opened: opened === 'OK' };
};

/** What the job takes: the events counted and the latest detail. Null when nothing is waiting. */
export const takePushState = async ({
  target,
}: {
  target: AssistantPushTarget;
}): Promise<{ count: number; detail: Record<string, any> } | null> => {
  const keys = stateKeys(target);
  const results = await redisClient.multi().get(keys.count).get(keys.detail).del(keys.count, keys.detail).exec();

  const count = Number(results?.[0]?.[1] ?? 0);
  const raw = results?.[1]?.[1];
  if (!count || typeof raw !== 'string') return null;

  return { count, detail: JSON.parse(raw) as Record<string, any> };
};

export const isCoolingDown = async ({ target }: { target: AssistantPushTarget }): Promise<boolean> =>
  (await redisClient.exists(stateKeys(target).cooldown)) === 1;

export const startCooldown = async ({ target, ms }: { target: AssistantPushTarget; ms: number }): Promise<void> => {
  await redisClient.set(stateKeys(target).cooldown, '1', 'PX', Math.max(1, ms));
};

/** Drops what is waiting for `target`, e.g. when its job finds the user already looking. */
export const discardPushState = async ({ target }: { target: AssistantPushTarget }): Promise<void> => {
  const keys = stateKeys(target);
  await redisClient.del(keys.count, keys.detail);
};
