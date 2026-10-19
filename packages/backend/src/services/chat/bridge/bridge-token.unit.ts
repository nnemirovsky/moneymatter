import { AI_PROVIDER, USER_ROLES } from '@bt/shared/types';
import { hashToken } from '@common/lib/hash-token';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Unauthorized } from '@js/errors';
import ChatMessages from '@models/chat-messages.model';
import Users from '@models/users.model';
import { redisClient } from '@root/redis-client';

jest.mock('../../mcp/auth', () => ({ buildMcpAuthInfo: jest.fn() }));

import { buildMcpAuthInfo } from '../../mcp/auth';
import {
  CHAT_BRIDGE_CLIENT_ID,
  markSlotAcquired,
  mintChatBridgeToken,
  revokeChatBridgeToken,
  revokeChatBridgeTokenOfRun,
  verifyChatBridgeToken,
} from './bridge-token';

const NOW = new Date('2026-10-19T10:00:00.000Z').getTime();
const MINUTE = 60;
const THREAD_ID = '1b4e28ba-2fa1-4d2b-8a5c-3c6f0a9d7e10';
const RUN_ID = 'e2d4a6c8-1f3b-4a5d-9e7f-0b8c6d4a2e13';
const USER = { id: 7, username: 'jane', authUserId: 'auth-7', role: USER_ROLES.common };

/** The token store the unit environment's Redis mock does not keep: values with the TTL they were set with. */
const store = new Map<string, { value: string; ttl: number }>();

const redisSet = jest.mocked(redisClient.set);
const redisGet = jest.mocked(redisClient.get);
const redisDel = jest.mocked(redisClient.del);

const mint = () =>
  mintChatBridgeToken({ userId: USER.id, threadId: THREAD_ID, runId: RUN_ID, provider: AI_PROVIDER.claudeCode });
const tokenKey = ({ token }: { token: string }) => `chat:bridge-token:${hashToken({ token })}`;
const lastTtl = ({ key }: { key: string }) => store.get(key)?.ttl;

describe('chat bridge token', () => {
  beforeEach(() => {
    store.clear();
    redisGet.mockClear();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);

    redisSet.mockImplementation((async (key: string, value: string, ...args: Array<string | number>) => {
      const ttl = Number(args[args.indexOf('EX') + 1]);
      if (args.includes('XX') && !store.has(key)) return null;
      store.set(key, { value, ttl });
      return 'OK';
    }) as never);
    redisGet.mockImplementation((async (key: string) => store.get(key)?.value ?? null) as never);
    redisDel.mockImplementation((async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) removed += store.delete(key) ? 1 : 0;
      return removed;
    }) as never);

    jest.spyOn(ChatMessages, 'findOne').mockResolvedValue({ id: 'message-1' } as never);
    jest.spyOn(Users, 'findOne').mockResolvedValue(USER as never);
    jest.mocked(buildMcpAuthInfo).mockReset();
    jest.mocked(buildMcpAuthInfo).mockImplementation((async ({
      user,
      clientId,
      scopes,
      expiresAt,
      token,
      chat,
    }: any) => ({
      token,
      clientId,
      scopes,
      expiresAt,
      extra: {
        userId: user.id,
        authUserId: user.authUserId,
        username: user.username,
        role: user.role,
        readOnly: false,
        features: [],
        chat,
      },
    })) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('mint', () => {
    it('returns an mmchat_ token of 32 random bytes and stores only its hash, for 13 minutes', async () => {
      const token = await mint();

      expect(token).toMatch(/^mmchat_[A-Za-z0-9_-]{43}$/);
      expect(lastTtl({ key: tokenKey({ token }) })).toBe(13 * MINUTE);
      expect(JSON.parse(store.get(tokenKey({ token }))!.value)).toEqual({
        userId: USER.id,
        threadId: THREAD_ID,
        runId: RUN_ID,
        provider: 'claude-code',
        expiresAt: NOW + 13 * MINUTE * 1000,
      });
      for (const [key, { value }] of store) {
        expect(key).not.toContain(token);
        expect(value).not.toContain(token);
      }
    });

    it('mints a different token every time', async () => {
      expect(await mint()).not.toBe(await mint());
    });
  });

  describe('markSlotAcquired', () => {
    it('resets the lifetime to 11 minutes from that moment', async () => {
      const token = await mint();
      jest.mocked(Date.now).mockReturnValue(NOW + 90 * 1000);

      await markSlotAcquired({ token });

      expect(lastTtl({ key: tokenKey({ token }) })).toBe(11 * MINUTE);
      expect(JSON.parse(store.get(tokenKey({ token }))!.value).expiresAt).toBe(NOW + 90 * 1000 + 11 * MINUTE * 1000);
    });

    it('does not bring back a token that was revoked', async () => {
      const token = await mint();
      await revokeChatBridgeToken({ token });

      await markSlotAcquired({ token });

      expect(store.has(tokenKey({ token }))).toBe(false);
    });
  });

  describe('verify', () => {
    it('answers the auth info of the run through buildMcpAuthInfo', async () => {
      const token = await mint();

      const info = await verifyChatBridgeToken({ token });

      expect(buildMcpAuthInfo).toHaveBeenCalledWith({
        user: USER,
        clientId: CHAT_BRIDGE_CLIENT_ID,
        scopes: ['finance:read', 'chat:propose'],
        expiresAt: (NOW + 13 * MINUTE * 1000) / 1000,
        token,
        chat: { threadId: THREAD_ID, runId: RUN_ID },
      });
      expect(info.clientId).toBe('moneymatter-chat-bridge');
      expect(info.scopes).not.toContain('finance:write');
      expect(info.extra.chat).toEqual({ threadId: THREAD_ID, runId: RUN_ID });
      expect(jest.mocked(ChatMessages.findOne).mock.calls[0]![0]).toMatchObject({
        where: { runId: RUN_ID, userId: USER.id, threadId: THREAD_ID, status: 'streaming' },
      });
    });

    it('refuses a token it never minted', async () => {
      await expect(verifyChatBridgeToken({ token: 'mmchat_unknown' })).rejects.toBeInstanceOf(Unauthorized);
      expect(buildMcpAuthInfo).not.toHaveBeenCalled();
    });

    it('refuses a token without the mmchat_ prefix before reading the store', async () => {
      await expect(verifyChatBridgeToken({ token: 'an-oauth-access-token' })).rejects.toBeInstanceOf(Unauthorized);
      expect(redisGet).not.toHaveBeenCalled();
    });

    it('refuses an expired token even when the store still holds it', async () => {
      const token = await mint();
      jest.mocked(Date.now).mockReturnValue(NOW + 14 * MINUTE * 1000);

      await expect(verifyChatBridgeToken({ token })).rejects.toBeInstanceOf(Unauthorized);
    });

    it('refuses a revoked token', async () => {
      const token = await mint();
      await revokeChatBridgeToken({ token });

      await expect(verifyChatBridgeToken({ token })).rejects.toBeInstanceOf(Unauthorized);
    });

    it('refuses the token of a run that has finished', async () => {
      const token = await mint();
      jest.mocked(ChatMessages.findOne).mockResolvedValue(null);

      await expect(verifyChatBridgeToken({ token })).rejects.toBeInstanceOf(Unauthorized);
      expect(buildMcpAuthInfo).not.toHaveBeenCalled();
    });

    it('refuses the token of a user that no longer exists', async () => {
      const token = await mint();
      jest.mocked(Users.findOne).mockResolvedValue(null);

      await expect(verifyChatBridgeToken({ token })).rejects.toBeInstanceOf(Unauthorized);
    });
  });

  describe('revoke', () => {
    it('removes the token and its run index', async () => {
      const token = await mint();

      await revokeChatBridgeToken({ token });

      expect(store.size).toBe(0);
    });

    it('revokes the token of a run without knowing the token', async () => {
      const token = await mint();

      await revokeChatBridgeTokenOfRun({ runId: RUN_ID });

      expect(store.size).toBe(0);
      await expect(verifyChatBridgeToken({ token })).rejects.toBeInstanceOf(Unauthorized);
    });

    it('does nothing for a run that has no token', async () => {
      await expect(revokeChatBridgeTokenOfRun({ runId: RUN_ID })).resolves.toBeUndefined();
    });
  });
});
