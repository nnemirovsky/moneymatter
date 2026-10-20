import type { ChatProposalCard } from '@bt/shared/types';
import { describe, expect, it } from 'vitest';

import { countWaitingCards, isInboxLocked, isInboxThread } from './chat-inbox';

const card = ({ id, status }: { id: string; status: ChatProposalCard['status'] }) =>
  [id, { id, status } as ChatProposalCard] as const;

describe('isInboxThread', () => {
  it('tells the inbox from a chat', () => {
    expect(isInboxThread({ thread: { kind: 'automationInbox' } })).toBe(true);
    expect(isInboxThread({ thread: { kind: 'chat' } })).toBe(false);
    expect(isInboxThread({ thread: null })).toBe(false);
  });
});

describe('isInboxLocked', () => {
  it('locks a live or open inbox', () => {
    expect(isInboxLocked({ thread: { kind: 'automationInbox', inboxState: 'live' } })).toBe(true);
    expect(isInboxLocked({ thread: { kind: 'automationInbox', inboxState: 'open' } })).toBe(true);
  });

  it('lets a closed inbox and a chat be unpinned and deleted', () => {
    expect(isInboxLocked({ thread: { kind: 'automationInbox', inboxState: 'closed' } })).toBe(false);
    expect(isInboxLocked({ thread: { kind: 'chat', inboxState: null } })).toBe(false);
  });
});

describe('countWaitingCards', () => {
  it('counts pending, stale and failed cards only', () => {
    const cards = Object.fromEntries([
      card({ id: 'a', status: 'pending' }),
      card({ id: 'b', status: 'stale' }),
      card({ id: 'c', status: 'failed' }),
      card({ id: 'd', status: 'applied' }),
      card({ id: 'e', status: 'rejected' }),
      card({ id: 'f', status: 'expired' }),
    ]);

    expect(countWaitingCards({ cards })).toBe(3);
  });
});
