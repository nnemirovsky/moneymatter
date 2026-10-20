import { CHAT_PRESENCE_HEARTBEAT_MS, CHAT_PRESENCE_TTL_MS } from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { redisClient } from '@root/redis-client';
import type { createFakeRedis } from '@tests/mocks/fake-redis';

import { clearPresence, isThreadPresent, touchPresence } from './presence';

jest.mock('@root/redis-client', () => ({
  redisClient: (jest.requireActual('@tests/mocks/fake-redis') as { createFakeRedis: () => unknown }).createFakeRedis(),
}));

const mockRedis = redisClient as unknown as ReturnType<typeof createFakeRedis>;

describe('presence', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-01T12:00:00Z') });
    mockRedis.store.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('marks a thread present under a per-user, per-thread key', async () => {
    await touchPresence({ userId: 7, threadId: 'thread-1' });

    expect([...mockRedis.store.keys()]).toEqual(['chat:presence:7:thread-1']);
    expect(await isThreadPresent({ userId: 7, threadId: 'thread-1' })).toBe(true);
  });

  it('stops counting a thread whose heartbeat stopped, but not one that kept beating', async () => {
    await touchPresence({ userId: 7, threadId: 'quiet' });
    await touchPresence({ userId: 7, threadId: 'beating' });

    for (let beat = 0; beat < 4; beat += 1) {
      jest.setSystemTime(Date.now() + CHAT_PRESENCE_HEARTBEAT_MS);
      await touchPresence({ userId: 7, threadId: 'beating' });
    }

    expect(await isThreadPresent({ userId: 7, threadId: 'quiet' })).toBe(false);
    expect(await isThreadPresent({ userId: 7, threadId: 'beating' })).toBe(true);
  });

  it('lasts the TTL and no longer', async () => {
    await touchPresence({ userId: 7, threadId: 'thread-1' });

    jest.setSystemTime(Date.now() + CHAT_PRESENCE_TTL_MS - 1);
    expect(await isThreadPresent({ userId: 7, threadId: 'thread-1' })).toBe(true);

    jest.setSystemTime(Date.now() + 2);
    expect(await isThreadPresent({ userId: 7, threadId: 'thread-1' })).toBe(false);
  });

  it('clears the mark on leave', async () => {
    await touchPresence({ userId: 7, threadId: 'thread-1' });
    await clearPresence({ userId: 7, threadId: 'thread-1' });

    expect(await isThreadPresent({ userId: 7, threadId: 'thread-1' })).toBe(false);
  });

  it('does not share presence between users or threads', async () => {
    await touchPresence({ userId: 7, threadId: 'a' });

    expect(await isThreadPresent({ userId: 8, threadId: 'a' })).toBe(false);
    expect(await isThreadPresent({ userId: 7, threadId: 'b' })).toBe(false);
  });
});
