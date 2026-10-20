import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { redisClient } from '@root/redis-client';
import type { createFakeRedis } from '@tests/mocks/fake-redis';

import { assistantPushConfig } from './assistant-push-config';
import {
  type AssistantPushTarget,
  discardPushState,
  isCoolingDown,
  recordPushEvent,
  startCooldown,
  takePushState,
} from './assistant-push-state';

jest.mock('@root/redis-client', () => ({
  redisClient: (jest.requireActual('@tests/mocks/fake-redis') as { createFakeRedis: () => unknown }).createFakeRedis(),
}));

const mockRedis = redisClient as unknown as ReturnType<typeof createFakeRedis>;

const inbox: AssistantPushTarget = { slot: 'inbox', userId: 1, key: 'inbox-thread' };
const thread: AssistantPushTarget = { slot: 'thread', userId: 1, key: 'chat-thread' };
const DEFAULTS = { ...assistantPushConfig };

describe('assistant push state', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-01T12:00:00Z') });
    mockRedis.store.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.assign(assistantPushConfig, DEFAULTS);
  });

  describe('collapse', () => {
    it('opens one window for a burst: only the first event schedules a job', async () => {
      const first = await recordPushEvent({ target: inbox, detail: {} });
      const second = await recordPushEvent({ target: inbox, detail: {} });
      const third = await recordPushEvent({ target: inbox, detail: {} });

      expect([first.opened, second.opened, third.opened]).toEqual([true, false, false]);
    });

    it('counts every event of the window', async () => {
      for (let item = 0; item < 3; item += 1) await recordPushEvent({ target: inbox, detail: {} });

      expect(await takePushState({ target: inbox })).toMatchObject({ count: 3 });
    });

    it('keeps the latest detail', async () => {
      await recordPushEvent({ target: thread, detail: { messageId: 'first' } });
      await recordPushEvent({ target: thread, detail: { messageId: 'second' } });

      expect(await takePushState({ target: thread })).toEqual({ count: 2, detail: { messageId: 'second' } });
    });

    it('hands the state over once', async () => {
      await recordPushEvent({ target: inbox, detail: {} });

      expect(await takePushState({ target: inbox })).not.toBeNull();
      expect(await takePushState({ target: inbox })).toBeNull();
    });

    it('opens a new window once the debounce passed', async () => {
      await recordPushEvent({ target: inbox, detail: {} });
      jest.setSystemTime(Date.now() + assistantPushConfig.debounceMs + 1);

      expect((await recordPushEvent({ target: inbox, detail: {} })).opened).toBe(true);
    });

    it('keeps targets apart', async () => {
      await recordPushEvent({ target: inbox, detail: {} });

      expect((await recordPushEvent({ target: { ...inbox, userId: 2 }, detail: {} })).opened).toBe(true);
      expect((await recordPushEvent({ target: { ...inbox, key: 'other' }, detail: {} })).opened).toBe(true);
      expect((await recordPushEvent({ target: { ...inbox, slot: 'ingest' }, detail: {} })).opened).toBe(true);
    });
  });

  describe('cooldown', () => {
    it('drops events while cooling down and records them again afterwards', async () => {
      await startCooldown({ target: inbox, ms: assistantPushConfig.inboxCooldownMs });

      const during = await recordPushEvent({ target: inbox, detail: {} });
      expect(during).toEqual({ cooling: true, opened: false });
      expect(await takePushState({ target: inbox })).toBeNull();

      jest.setSystemTime(Date.now() + assistantPushConfig.inboxCooldownMs + 1);
      expect(await isCoolingDown({ target: inbox })).toBe(false);
      expect((await recordPushEvent({ target: inbox, detail: {} })).opened).toBe(true);
    });

    it('cools a park reason for a day', async () => {
      const reason: AssistantPushTarget = { slot: 'ingest', userId: 1, key: 'aiCapReached' };
      await startCooldown({ target: reason, ms: assistantPushConfig.ingestCooldownMs });

      jest.setSystemTime(Date.now() + 23 * 60 * 60_000);
      expect(await isCoolingDown({ target: reason })).toBe(true);

      jest.setSystemTime(Date.now() + 2 * 60 * 60_000);
      expect(await isCoolingDown({ target: reason })).toBe(false);
    });

    it('uses a short cooldown per thread and a longer one for the inbox', () => {
      expect(DEFAULTS.threadCooldownMs).toBe(5 * 60_000);
      expect(DEFAULTS.inboxCooldownMs).toBe(10 * 60_000);
      expect(DEFAULTS.ingestCooldownMs).toBe(24 * 60 * 60_000);
      expect(DEFAULTS.debounceMs).toBe(60_000);
    });
  });

  describe('discard', () => {
    it('forgets what a window collected', async () => {
      await recordPushEvent({ target: inbox, detail: {} });
      await discardPushState({ target: inbox });

      expect(await takePushState({ target: inbox })).toBeNull();
    });
  });
});
