import { CHAT_PRESENCE_TTL_MS } from '@bt/shared/types';
import { redisClient } from '@root/redis-client';

/**
 * Which threads the user is looking at right now. A client that shows a thread (visible and focused)
 * refreshes the key every heartbeat and removes it on leave; a run's event stream counts as a reader
 * too. The TTL makes a closed tab stop counting without a goodbye.
 */
const presenceKey = ({ userId, threadId }: { userId: number; threadId: string }) =>
  `chat:presence:${userId}:${threadId}`;

export const touchPresence = async ({ userId, threadId }: { userId: number; threadId: string }): Promise<void> => {
  await redisClient.set(presenceKey({ userId, threadId }), '1', 'PX', CHAT_PRESENCE_TTL_MS);
};

export const clearPresence = async ({ userId, threadId }: { userId: number; threadId: string }): Promise<void> => {
  await redisClient.del(presenceKey({ userId, threadId }));
};

export const isThreadPresent = async ({ userId, threadId }: { userId: number; threadId: string }): Promise<boolean> =>
  (await redisClient.exists(presenceKey({ userId, threadId }))) === 1;
