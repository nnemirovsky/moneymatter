import { describe, expect, it } from '@jest/globals';

import { createEventQueue } from './event-queue';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createEventQueue', () => {
  it('runs the tasks one at a time, in the order they were pushed', async () => {
    const queue = createEventQueue();
    const order: string[] = [];

    queue.push(async () => {
      await sleep(20);
      order.push('slow');
    });
    queue.push(async () => {
      order.push('fast');
    });
    await queue.drain();

    expect(order).toEqual(['slow', 'fast']);
  });

  it('rejects the drain with the first failure and skips what was queued after it', async () => {
    const queue = createEventQueue();
    const ran: string[] = [];

    queue.push(async () => {
      ran.push('a');
    });
    queue.push(async () => {
      throw new Error('boom');
    });
    queue.push(async () => {
      ran.push('c');
    });

    await expect(queue.drain()).rejects.toThrow('boom');
    expect(ran).toEqual(['a']);
  });

  it('drains at once when nothing was pushed', async () => {
    await expect(createEventQueue().drain()).resolves.toBeUndefined();
  });
});
