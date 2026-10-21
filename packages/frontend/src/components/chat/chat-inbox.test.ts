import { describe, expect, it } from 'vitest';

import { isInboxThread } from './chat-inbox';

describe('isInboxThread', () => {
  it('tells the inbox from a chat', () => {
    expect(isInboxThread({ thread: { kind: 'automationInbox' } })).toBe(true);
    expect(isInboxThread({ thread: { kind: 'chat' } })).toBe(false);
    expect(isInboxThread({ thread: null })).toBe(false);
  });
});
