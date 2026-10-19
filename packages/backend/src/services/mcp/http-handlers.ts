import { CustomError } from '@js/errors';
import { logger } from '@js/utils/logger';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

import type { McpAuthInfo } from './auth';
import { getSession, type McpSessionKind, registerSession, removeSession, touchSession } from './transport-manager';

declare module 'express' {
  interface Request {
    auth?: McpAuthInfo;
    mcpAuthInfo?: McpAuthInfo;
  }
}

/** What a session's server must offer: the handlers only connect it to the session's transport. */
interface ConnectableServer {
  connect: (transport: Transport) => Promise<void>;
}

interface McpHandlerOptions {
  /** Answers the request itself (401, 403) and returns `null` when the caller is refused. */
  authenticate: (params: { req: Request; res: Response }) => Promise<McpAuthInfo | null>;
  /** Builds the server of a new session. A throw is answered like any other handler failure. */
  createServer: (params: { authInfo: McpAuthInfo }) => ConnectableServer | Promise<ConnectableServer>;
  /** Which sessions these handlers own; a session of the other kind is never reachable through them. */
  sessionKind: McpSessionKind;
  /** Wraps the transport call of a request; the public route uses it for the balance revalue scope. */
  runRequest?: <T>(run: () => Promise<T>) => Promise<T>;
}

type McpHandler = (req: Request, res: Response) => Promise<void>;

/**
 * Extract the MCP session ID from the request header, handling the string[] case.
 */
function getSessionId({ req }: { req: Request }): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * Shared error handler for MCP route catch blocks.
 */
function handleMcpError({ error, res, label }: { error: unknown; res: Response; label: string }) {
  logger.error(`MCP ${label} handler error`, { error: (error as Error).message });
  if (!res.headersSent) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null,
    });
  }
}

/**
 * The MCP Streamable HTTP handlers, shared by the public `/mcp` route (OAuth tokens) and the
 * loopback listener of the chat bridge (run tokens). They own the session rules: a session belongs
 * to the user, the kind and the run that created it, and nobody else can use it.
 */
export function createMcpHandlers({
  authenticate,
  createServer,
  sessionKind,
  runRequest = (run) => run(),
}: McpHandlerOptions): {
  post: McpHandler;
  get: McpHandler;
  delete: McpHandler;
} {
  const authenticateRequest = async ({ req, res }: { req: Request; res: Response }): Promise<boolean> => {
    const authInfo = await authenticate({ req, res });
    if (!authInfo) return false;

    req.mcpAuthInfo = authInfo;
    // Set req.auth so the MCP SDK passes authInfo to tool handlers via extra.authInfo
    req.auth = authInfo;
    return true;
  };

  /**
   * Lookup an existing session transport by session ID from the request header.
   * Returns the transport if found, or sends a 400/403 error and returns null.
   */
  const resolveSessionTransport = ({
    req,
    res,
  }: {
    req: Request;
    res: Response;
  }): StreamableHTTPServerTransport | null => {
    const sessionId = getSessionId({ req });

    if (!sessionId) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing session ID' },
        id: null,
      });
      return null;
    }

    const session = getSession({ sessionId });
    if (!session) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid or expired session ID' },
        id: null,
      });
      return null;
    }

    // Verify the session belongs to the authenticated user, and to the same run for a bridge session
    const authInfo = req.mcpAuthInfo;
    if (
      session.userId !== authInfo?.extra?.userId ||
      session.kind !== sessionKind ||
      (session.runId ?? null) !== (authInfo?.extra?.chat?.runId ?? null)
    ) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session does not belong to authenticated user' },
        id: null,
      });
      return null;
    }

    touchSession({ sessionId });
    return session.transport;
  };

  /**
   * POST /mcp — Handle MCP JSON-RPC requests (initialization + tool calls)
   */
  // oxlint-disable-next-line oxc/no-async-endpoint-handlers -- handler has internal try/catch for all async operations
  const post: McpHandler = async (req, res) => {
    if (!(await authenticateRequest({ req, res }))) return;

    const sessionId = getSessionId({ req });

    // Tool calls mutate data, so each request gets its own revalue scope: the queued
    // rebuilds must run after the tool's writes, not inline from inside a model hook.
    try {
      // Reuse existing transport for established sessions
      if (sessionId) {
        const transport = resolveSessionTransport({ req, res });
        if (!transport) return;

        await runRequest(() => transport.handleRequest(req, res, req.body));
        return;
      }

      // New session — must be an initialization request
      if (req.body?.method === 'initialize') {
        const authInfo = req.mcpAuthInfo!;

        // Built before the transport exists, so a refusal (no toolkit for the run) leaves nothing behind.
        const server = await createServer({ authInfo });

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            registerSession({
              sessionId: sid,
              transport,
              userId: authInfo.extra.userId,
              kind: sessionKind,
              runId: authInfo.extra.chat?.runId,
            });
          },
        });

        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- StreamableHTTPServerTransport only exposes onclose setter
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) removeSession({ sessionId: sid });
        };

        await server.connect(transport);
        await runRequest(() => transport.handleRequest(req, res, req.body));
        return;
      }

      // Invalid request — no session and not initialization
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid request. Send an initialization request first.' },
        id: null,
      });
    } catch (error) {
      if (error instanceof CustomError && error.httpCode === 503) {
        if (!res.headersSent) {
          res.status(503).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: (error as Error).message },
            id: null,
          });
        }
        return;
      }
      handleMcpError({ error, res, label: 'POST' });
    }
  };

  /**
   * GET /mcp — SSE stream for server-to-client notifications
   */
  // oxlint-disable-next-line oxc/no-async-endpoint-handlers -- handler has internal try/catch for all async operations
  const get: McpHandler = async (req, res) => {
    if (!(await authenticateRequest({ req, res }))) return;

    const transport = resolveSessionTransport({ req, res });
    if (!transport) return;

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      handleMcpError({ error, res, label: 'GET' });
    }
  };

  /**
   * DELETE /mcp — Terminate an MCP session
   */
  // oxlint-disable-next-line oxc/no-async-endpoint-handlers -- handler has internal try/catch for all async operations
  const del: McpHandler = async (req, res) => {
    if (!(await authenticateRequest({ req, res }))) return;

    const sessionId = getSessionId({ req });

    const transport = resolveSessionTransport({ req, res });
    if (!transport) return;

    try {
      await transport.handleRequest(req, res);
      if (sessionId) removeSession({ sessionId });
    } catch (error) {
      if (sessionId) removeSession({ sessionId });
      handleMcpError({ error, res, label: 'DELETE' });
    }
  };

  return { post, get, delete: del };
}
