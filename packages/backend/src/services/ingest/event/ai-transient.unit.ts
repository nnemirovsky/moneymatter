import { describe, expect, it } from '@jest/globals';
import { APICallError } from 'ai';

import { formatNextTry, isAiTransientKind, nextAiRetryAt, readAiRetry, readResetAt } from './ai-transient';

const NOW = new Date('2026-01-15T10:00:00Z');
const MINUTE = 60_000;
const SCHEDULE = [5 * MINUTE, 15 * MINUTE, 60 * MINUTE];

const apiError = ({ headers, data }: { headers?: Record<string, string>; data?: unknown } = {}) =>
  new APICallError({
    message: 'limit',
    url: 'https://example.test',
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: headers,
    data,
  });

describe('isAiTransientKind', () => {
  it('takes a used-up quota, a rate limit and an overload as transient, and a rejected key as not', () => {
    expect(['quota-exhausted', 'rate-limited', 'temporary'].every((kind) => isAiTransientKind(kind))).toBe(true);
    expect(['auth', 'model-not-found', 'endpoint-down', 'unknown'].some((kind) => isAiTransientKind(kind))).toBe(false);
  });
});

describe('readResetAt', () => {
  it('reads a Retry-After in seconds and in an HTTP date', () => {
    expect(readResetAt({ cause: apiError({ headers: { 'retry-after': '90' } }), now: NOW })).toEqual(
      new Date('2026-01-15T10:01:30Z'),
    );
    expect(
      readResetAt({ cause: apiError({ headers: { 'retry-after': 'Thu, 15 Jan 2026 12:00:00 GMT' } }), now: NOW }),
    ).toEqual(new Date('2026-01-15T12:00:00Z'));
  });

  it('reads the reset time a subscription CLI reports', () => {
    expect(readResetAt({ cause: apiError({ data: { resetsAt: '2026-01-15T15:30:00Z' } }), now: NOW })).toEqual(
      new Date('2026-01-15T15:30:00Z'),
    );
  });

  it('reads nothing from an error that reports no time', () => {
    expect(readResetAt({ cause: apiError(), now: NOW })).toBeNull();
    expect(readResetAt({ cause: new Error('boom'), now: NOW })).toBeNull();
  });
});

describe('nextAiRetryAt', () => {
  it('walks the schedule: 5 minutes, 15 minutes, an hour, then stops', () => {
    const at = (attempt: number) => nextAiRetryAt({ attempt, resetAt: null, schedule: SCHEDULE, now: NOW });

    expect(at(1)).toEqual(new Date(NOW.getTime() + 5 * MINUTE));
    expect(at(2)).toEqual(new Date(NOW.getTime() + 15 * MINUTE));
    expect(at(3)).toEqual(new Date(NOW.getTime() + 60 * MINUTE));
    expect(at(4)).toBeNull();
  });

  it('uses the reset time the provider reported when it is later than the step', () => {
    const resetAt = new Date('2026-01-15T14:00:00Z');

    expect(nextAiRetryAt({ attempt: 1, resetAt, schedule: SCHEDULE, now: NOW })).toEqual(resetAt);
    // Once the schedule is spent the tries stop, whatever the provider says.
    expect(nextAiRetryAt({ attempt: 4, resetAt, schedule: SCHEDULE, now: NOW })).toBeNull();
  });

  it('never lets a reset that is about to pass, or has passed, shorten a step', () => {
    const soon = new Date(NOW.getTime() + 5_000);
    const past = new Date(NOW.getTime() - 5_000);
    const step = new Date(NOW.getTime() + 5 * MINUTE);

    expect(nextAiRetryAt({ attempt: 1, resetAt: soon, schedule: SCHEDULE, now: NOW })).toEqual(step);
    expect(nextAiRetryAt({ attempt: 1, resetAt: past, schedule: SCHEDULE, now: NOW })).toEqual(step);
  });

  it('ignores a reset more than a day and a half away and follows the schedule', () => {
    const far = new Date(NOW.getTime() + 5 * 24 * 60 * MINUTE);

    expect(nextAiRetryAt({ attempt: 1, resetAt: far, schedule: SCHEDULE, now: NOW })).toEqual(
      new Date(NOW.getTime() + 5 * MINUTE),
    );
  });
});

describe('formatNextTry', () => {
  it('shows the clock time in the owner zone when it is today, and the day with it when it is not', () => {
    const today = formatNextTry({
      at: new Date('2026-01-15T14:30:00Z'),
      timeZone: 'Europe/Berlin',
      locale: 'en',
      now: NOW,
    });
    const later = formatNextTry({
      at: new Date('2026-01-16T14:30:00Z'),
      timeZone: 'Europe/Berlin',
      locale: 'en',
      now: NOW,
    });

    expect(today.replace(/\u202f/gu, ' ')).toBe('03:30 PM');
    expect(later.replace(/\u202f/gu, ' ')).toBe('Jan 16, 03:30 PM');
  });
});

describe('readAiRetry', () => {
  it('reads the state a waiting request keeps, and nothing from a request that has none', () => {
    expect(
      readAiRetry({
        payload: {
          aiRetry: {
            count: 2,
            at: '2026-01-15T10:05:00Z',
            kind: 'rate-limited',
            connectionName: 'Home',
            connectionId: 'c1',
          },
        },
      }),
    ).toEqual({
      count: 2,
      at: '2026-01-15T10:05:00Z',
      kind: 'rate-limited',
      connectionName: 'Home',
      connectionId: 'c1',
    });
    expect(readAiRetry({ payload: {} })).toBeNull();
    expect(readAiRetry({ payload: { aiRetry: { count: 'x' } } })).toBeNull();
  });
});
