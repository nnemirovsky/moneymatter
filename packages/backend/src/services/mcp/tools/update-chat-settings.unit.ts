import { CHAT_INBOX_KEEP_RESOLVED, CHAT_RETENTION_OPTIONS } from '@bt/shared/types';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { updateChatSettings } from '@services/chat/threads/update-chat-settings.service';
import { captureTools, makeExtra, parseToolResult } from '@tests/helpers/mcp-tools';
import { z } from 'zod';

// The service chain opens queues and Redis connections at module scope.
jest.mock('@services/chat/threads/update-chat-settings.service', () => ({
  updateChatSettings: jest.fn(),
}));

import { registerUpdateChatSettings, validateUpdateChatSettingsArgs } from './update-chat-settings';

const WRITE = makeExtra({ scopes: ['finance:read', 'finance:write'] });
const READ_ONLY_WRITE_SCOPE = makeExtra({
  scopes: ['finance:read', 'finance:write'],
  readOnly: true,
});
const NO_WRITE_SCOPE = makeExtra({ scopes: ['finance:read'] });
const DEMO = makeExtra({
  scopes: ['finance:read', 'finance:write'],
  role: 'demo',
});

const service = jest.mocked(updateChatSettings);
const tool = captureTools({ register: registerUpdateChatSettings })[0]!;
const schema = z.object(tool.config.inputSchema ?? {}).strict();

beforeEach(() => {
  jest.resetAllMocks();
  service.mockResolvedValue({ retentionDays: 7, inboxKeepResolved: 250 });
});

describe('update_chat_settings', () => {
  it('registers under its name with exactly the two chat settings', () => {
    expect(tool.name).toBe('update_chat_settings');
    expect(Object.keys(tool.config.inputSchema ?? {}).toSorted()).toEqual(['inboxKeepResolved', 'retentionDays']);
  });

  it.each(CHAT_RETENTION_OPTIONS)('accepts %s days and null (keep threads for good)', (retentionDays) => {
    expect(schema.safeParse({ retentionDays }).success).toBe(true);
    expect(schema.safeParse({ retentionDays: null }).success).toBe(true);
  });

  it('applies the bounds PUT /chat/settings applies', () => {
    expect(schema.safeParse({ retentionDays: 45 }).success).toBe(false);
    expect(schema.safeParse({ retentionDays: '7' }).success).toBe(false);
    expect(schema.safeParse({ inboxKeepResolved: CHAT_INBOX_KEEP_RESOLVED.min }).success).toBe(true);
    expect(schema.safeParse({ inboxKeepResolved: CHAT_INBOX_KEEP_RESOLVED.max }).success).toBe(true);
    expect(schema.safeParse({ inboxKeepResolved: CHAT_INBOX_KEEP_RESOLVED.min - 1 }).success).toBe(false);
    expect(schema.safeParse({ inboxKeepResolved: CHAT_INBOX_KEEP_RESOLVED.max + 1 }).success).toBe(false);
    expect(schema.safeParse({ inboxKeepResolved: 10.5 }).success).toBe(false);
  });

  it('refuses a call that names no setting, in the validator and in the handler', async () => {
    expect(() => validateUpdateChatSettingsArgs({ args: {} })).toThrow(/retentionDays or inboxKeepResolved/);
    await expect(tool.handler({}, WRITE)).rejects.toThrow(/retentionDays or inboxKeepResolved/);
    expect(service).not.toHaveBeenCalled();
  });

  it('writes the named settings for the caller and returns the settings after the change', async () => {
    const result = parseToolResult({
      result: await tool.handler({ retentionDays: 7, inboxKeepResolved: 250 }, WRITE),
    });

    expect(service).toHaveBeenCalledWith({
      userId: 42,
      update: { retentionDays: 7, inboxKeepResolved: 250 },
    });
    expect(result).toEqual({ retentionDays: 7, inboxKeepResolved: 250 });
  });

  it('passes null through as "keep forever", not as an omitted key', async () => {
    await tool.handler({ retentionDays: null }, WRITE);

    expect(service).toHaveBeenCalledWith({
      userId: 42,
      update: { retentionDays: null },
    });
  });

  it('needs the write scope, with the service not called', async () => {
    await expect(tool.handler({ retentionDays: 7 }, NO_WRITE_SCOPE)).rejects.toThrow();
    expect(service).not.toHaveBeenCalled();
  });

  it('lets a read-only account and a demo user through, as the REST route does', async () => {
    await tool.handler({ retentionDays: 7 }, READ_ONLY_WRITE_SCOPE);
    await tool.handler({ retentionDays: 7 }, DEMO);

    expect(service).toHaveBeenCalledTimes(2);
  });
});
