import { API_ERROR_CODES } from '@bt/shared/types';
import { CustomError } from '@js/errors';
import { logger } from '@js/utils/logger';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** `oauth` sessions belong to the public `/mcp`; `chatBridge` sessions to one chat run on the loopback listener. */
export type McpSessionKind = 'oauth' | 'chatBridge';

interface McpSession {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  userId: number;
  kind: McpSessionKind;
  /** Set for `chatBridge` sessions: the one run that may use the session. */
  runId?: string;
}

const sessions = new Map<string, McpSession>();

const MAX_SESSIONS = 1000;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function cleanupIdleSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    const idleTime = now - session.lastActivity;
    if (idleTime > IDLE_TIMEOUT_MS) {
      logger.info(`MCP: Cleaning up idle session ${sessionId}`);
      sessions.delete(sessionId);
      try {
        session.transport.close();
      } catch (err) {
        logger.error(`Failed to close idle MCP session ${sessionId}`, {
          error: (err as Error).message,
        });
      }
    }
  }
}

export function startSessionCleanup() {
  if (!cleanupTimer) {
    cleanupTimer = setInterval(cleanupIdleSessions, CLEANUP_INTERVAL_MS);
  }
}

export function getSession({ sessionId }: { sessionId: string }): McpSession | undefined {
  return sessions.get(sessionId);
}

export function registerSession({
  sessionId,
  transport,
  userId,
  kind = 'oauth',
  runId,
}: {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  userId: number;
  kind?: McpSessionKind;
  runId?: string;
}) {
  if (sessions.size >= MAX_SESSIONS) {
    throw new CustomError(503, API_ERROR_CODES.unexpected, 'Maximum number of concurrent MCP sessions reached');
  }

  sessions.set(sessionId, {
    transport,
    lastActivity: Date.now(),
    userId,
    kind,
    runId,
  });
}

export function touchSession({ sessionId }: { sessionId: string }) {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivity = Date.now();
  }
}

export function removeSession({ sessionId }: { sessionId: string }) {
  const session = sessions.get(sessionId);
  if (session) {
    sessions.delete(sessionId);
    try {
      session.transport.close();
    } catch (err) {
      logger.error(`Failed to close MCP session ${sessionId}`, {
        error: (err as Error).message,
      });
    }
  }
}

/** Closes every session of a chat run, so a CLI that outlives its run cannot keep calling. */
export function removeSessionsOfRun({ runId }: { runId: string }) {
  for (const [sessionId, session] of sessions) {
    if (session.kind === 'chatBridge' && session.runId === runId) removeSession({ sessionId });
  }
}
