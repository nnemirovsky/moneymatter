import { describe, expect, it } from '@jest/globals';

import { inboxConfig, isPinnedInboxState, nextInboxState } from './inbox-transitions';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-01T12:00:00Z');
const createdAgo = ({ days }: { days: number }) => new Date(now.getTime() - days * DAY_MS);

describe('nextInboxState', () => {
  it('keeps a young live thread with room live', () => {
    expect(nextInboxState({ state: 'live', createdAt: createdAgo({ days: 1 }), cardCount: 3, openCount: 2, now })).toBe(
      'live',
    );
  });

  it('closes a live thread that is 7 days old with no pending card', () => {
    expect(nextInboxState({ state: 'live', createdAt: createdAgo({ days: 7 }), cardCount: 3, openCount: 0, now })).toBe(
      'closed',
    );
  });

  it('keeps a live thread that is 7 days old live while a card is pending', () => {
    expect(nextInboxState({ state: 'live', createdAt: createdAgo({ days: 9 }), cardCount: 3, openCount: 1, now })).toBe(
      'live',
    );
  });

  it('closes a live thread that holds 200 cards when none is pending', () => {
    expect(
      nextInboxState({
        state: 'live',
        createdAt: createdAgo({ days: 1 }),
        cardCount: inboxConfig.maxCards,
        openCount: 0,
        now,
      }),
    ).toBe('closed');
  });

  it('opens a live thread that holds 200 cards while cards are pending', () => {
    expect(
      nextInboxState({
        state: 'live',
        createdAt: createdAgo({ days: 1 }),
        cardCount: inboxConfig.maxCards,
        openCount: 4,
        now,
      }),
    ).toBe('open');
  });

  it('keeps an open thread open while a card is pending and closes it with the last one', () => {
    const base = { state: 'open' as const, createdAt: createdAgo({ days: 30 }), cardCount: 200, now };

    expect(nextInboxState({ ...base, openCount: 1 })).toBe('open');
    expect(nextInboxState({ ...base, openCount: 0 })).toBe('closed');
  });

  it('never reopens a closed thread', () => {
    expect(
      nextInboxState({ state: 'closed', createdAt: createdAgo({ days: 0 }), cardCount: 0, openCount: 5, now }),
    ).toBe('closed');
  });

  it('honors a shortened config', () => {
    expect(
      nextInboxState({
        state: 'live',
        createdAt: createdAgo({ days: 1 }),
        cardCount: 2,
        openCount: 0,
        now,
        config: { ...inboxConfig, maxCards: 2 },
      }),
    ).toBe('closed');
  });
});

describe('isPinnedInboxState', () => {
  it('pins live and open threads only', () => {
    expect(isPinnedInboxState({ state: 'live' })).toBe(true);
    expect(isPinnedInboxState({ state: 'open' })).toBe(true);
    expect(isPinnedInboxState({ state: 'closed' })).toBe(false);
    expect(isPinnedInboxState({ state: null })).toBe(false);
  });
});
