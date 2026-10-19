import type { AICliProvider } from '@bt/shared/types';
import { hashToken } from '@common/lib/hash-token';
import { Unauthorized } from '@js/errors';
import ChatMessages from '@models/chat-messages.model';
import Users from '@models/users.model';
import { redisClient } from '@root/redis-client';
import { randomBytes } from 'node:crypto';

import { buildMcpAuthInfo, type McpAuthInfo } from '../../mcp/auth';
import { CHAT_BRIDGE_TOKEN_PREFIX } from './bridge-token-prefix';

/** The client id every bridge call runs under; no OAuth client has it, and Connected apps never lists it. */
export const CHAT_BRIDGE_CLIENT_ID = 'moneymatter-chat-bridge';
/** Read scope for the reads, `chat:propose` for the proposing wrappers. No `finance:write`: a real write handler would refuse. */
const CHAT_BRIDGE_SCOPES = ['finance:read', 'chat:propose'];

const MINUTE_SECONDS = 60;
/** Slot wait (2) + run timeout (10) + margin (1): an abandoned token still dies within this. */
const MINT_TTL_SECONDS = 13 * MINUTE_SECONDS;
/** Once the slot is acquired only the run timeout (10) and the margin (1) remain. */
const RUN_TTL_SECONDS = 11 * MINUTE_SECONDS;

interface BridgeTokenRecord {
  userId: number;
  threadId: string;
  runId: string;
  provider: AICliProvider;
  /** Epoch milliseconds. The store's TTL is the real clock; this is a second check. */
  expiresAt: number;
}

/** The record is found by the hash of the token, so the raw token is never a key or a value. */
const tokenKeyOfHash = ({ hash }: { hash: string }): string => `chat:bridge-token:${hash}`;
export const chatBridgeTokenKey = ({ token }: { token: string }): string =>
  tokenKeyOfHash({ hash: hashToken({ token }) });
/** Points a run at the hash of its token, so a thread delete or a sweep can revoke without the token. */
export const chatBridgeRunKey = ({ runId }: { runId: string }): string => `chat:bridge-run:${runId}`;

const store = async ({
  token,
  record,
  ttlSeconds,
  onlyIfPresent = false,
}: {
  token: string;
  record: Omit<BridgeTokenRecord, 'expiresAt'>;
  ttlSeconds: number;
  onlyIfPresent?: boolean;
}): Promise<boolean> => {
  const value = JSON.stringify({ ...record, expiresAt: Date.now() + ttlSeconds * 1000 } satisfies BridgeTokenRecord);
  const stored = onlyIfPresent
    ? await redisClient.set(chatBridgeTokenKey({ token }), value, 'EX', ttlSeconds, 'XX')
    : await redisClient.set(chatBridgeTokenKey({ token }), value, 'EX', ttlSeconds);
  if (stored !== 'OK') return false;

  await redisClient.set(chatBridgeRunKey({ runId: record.runId }), hashToken({ token }), 'EX', ttlSeconds);
  return true;
};

const readRecord = async ({ token }: { token: string }): Promise<BridgeTokenRecord | null> => {
  const raw = await redisClient.get(chatBridgeTokenKey({ token }));
  return raw ? (JSON.parse(raw) as BridgeTokenRecord) : null;
};

/**
 * Mints the token a CLI run uses to reach the bridge: `mmchat_` and 32 random bytes. Only its hash
 * is stored, alive for the slot wait and the whole run. The raw token lives in the runner's memory
 * and the CLI's environment, and is never logged or put in argv or a prompt.
 */
export async function mintChatBridgeToken({
  userId,
  threadId,
  runId,
  provider,
}: {
  userId: number;
  threadId: string;
  runId: string;
  provider: AICliProvider;
}): Promise<string> {
  const token = `${CHAT_BRIDGE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  await store({ token, record: { userId, threadId, runId, provider }, ttlSeconds: MINT_TTL_SECONDS });
  return token;
}

/**
 * Called once the run holds its CLI slot: the token then lives for the run timeout and the margin
 * from this moment, so neither a long wait nor a full-length run outlives it. A token that was
 * revoked meanwhile stays revoked.
 */
export async function markSlotAcquired({ token }: { token: string }): Promise<void> {
  const record = await readRecord({ token });
  if (!record) return;

  const { expiresAt: _previous, ...rest } = record;
  await store({ token, record: rest, ttlSeconds: RUN_TTL_SECONDS, onlyIfPresent: true });
}

/**
 * The auth info of a live run's token. Every request checks the run again: a token whose run has
 * finished, been cancelled or been deleted is refused even if it has not expired.
 */
export async function verifyChatBridgeToken({ token }: { token: string }): Promise<McpAuthInfo> {
  if (!token.startsWith(CHAT_BRIDGE_TOKEN_PREFIX)) throw new Unauthorized({ message: 'Not a chat bridge token' });

  const record = await readRecord({ token });
  if (!record) throw new Unauthorized({ message: 'Token not found' });
  if (record.expiresAt <= Date.now()) throw new Unauthorized({ message: 'Token expired' });

  const run = await ChatMessages.findOne({
    where: {
      runId: record.runId,
      userId: record.userId,
      threadId: record.threadId,
      role: 'assistant',
      status: 'streaming',
    },
    attributes: ['id'],
    raw: true,
  });
  if (!run) throw new Unauthorized({ message: 'The run has ended' });

  const user = await Users.findOne({
    where: { id: record.userId },
    attributes: ['username', 'id', 'authUserId', 'role'],
    raw: true,
  });
  if (!user) throw new Unauthorized({ message: 'App user not found' });

  return buildMcpAuthInfo({
    user,
    clientId: CHAT_BRIDGE_CLIENT_ID,
    scopes: CHAT_BRIDGE_SCOPES,
    expiresAt: record.expiresAt / 1000,
    token,
    chat: { threadId: record.threadId, runId: record.runId },
  });
}

export async function revokeChatBridgeToken({ token }: { token: string }): Promise<void> {
  const record = await readRecord({ token });
  await redisClient.del(chatBridgeTokenKey({ token }), ...(record ? [chatBridgeRunKey({ runId: record.runId })] : []));
}

/** Revokes the token of a run without knowing it: thread delete, user wipe, the interrupted-run sweep and the run's end. */
export async function revokeChatBridgeTokenOfRun({ runId }: { runId: string }): Promise<void> {
  const hash = await redisClient.get(chatBridgeRunKey({ runId }));
  await redisClient.del(chatBridgeRunKey({ runId }), ...(hash ? [tokenKeyOfHash({ hash })] : []));
}
