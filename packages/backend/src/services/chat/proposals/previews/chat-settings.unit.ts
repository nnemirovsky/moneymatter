import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getChatSettings } from '@services/chat/threads/retention.service';

import { resolveChatSettings } from './chat-settings';

jest.mock('@services/chat/threads/retention.service', () => ({
  getChatSettings: jest.fn(),
}));

const policy = {} as Parameters<typeof resolveChatSettings>[0]['policy'];
const resolve = ({ userId }: { userId: number }) =>
  resolveChatSettings({
    userId,
    toolName: 'update_chat_settings',
    args: { retentionDays: 7 },
    policy,
  });

describe('resolveChatSettings', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('shows the settings the user has now as the before values', async () => {
    jest.mocked(getChatSettings).mockResolvedValue({ retentionDays: null, inboxKeepResolved: 100 });

    const { preview } = await resolve({ userId: 1 });

    expect(getChatSettings).toHaveBeenCalledWith({ userId: 1 });
    expect(preview.before).toEqual({
      retentionDays: null,
      inboxKeepResolved: 100,
    });
  });

  it('hashes the settings, so a change made after the card was proposed makes it stale', async () => {
    jest.mocked(getChatSettings).mockResolvedValue({ retentionDays: 30, inboxKeepResolved: 100 });
    const first = await resolve({ userId: 1 });
    const again = await resolve({ userId: 1 });

    jest.mocked(getChatSettings).mockResolvedValue({ retentionDays: null, inboxKeepResolved: 100 });
    const changed = await resolve({ userId: 1 });

    expect(first.snapshot.targetHash).toBe(again.snapshot.targetHash);
    expect(first.snapshot.targetHash).not.toBe(changed.snapshot.targetHash);
    expect(first.snapshot.targetCount).toBe(1);
  });
});
