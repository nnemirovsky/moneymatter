import { CustomError } from '@js/errors';
import { logger } from '@js/utils/logger';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

import type { McpAuthInfo } from './auth';
import { getSession, registerSession, removeSession, touchSession } from './transport-manager';

declare module 'express' {
  interface Request {
    auth?: McpAuthInfo;
    mcpAuthInfo?: McpAuthInfo;
  }
}

/** What a server must offer: the handlers only connect it to a transport and close it. */
interface ConnectableServer {
  connect: (transport: Transport) => Promise<void>;
  close: () => Promise<void>;
}

interface McpHandlerOptions {
  /** Answers the request itself (401, 403) and returns `null` when the caller is refused. */
  authenticate: (params: { req: Request; res: Response }) => Promise<McpAuthInfo | null>;
  /** Builds the server that serves a request or a session. A throw is answered like any other handler failure. */
  createServer: (params: { authInfo: McpAuthInfo }) => ConnectableServer | Promise<ConnectableServer>;
  /** Wraps the transport call of a request; the public route uses it for the balance revalue scope. */
  runRequest?: <T>(run: () => Promise<T>) => Promise<T>;
}

type McpHandler = (req: Request, res: Response) => Promise<void>;

interface McpHandlers {
  post: McpHandler;
  get: McpHandler;
  delete: McpHandler;
}

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

/** Runs `authenticate` and, when the caller is let in, hands the auth info to the MCP SDK. */
const bindAuthenticate =
  ({ authenticate }: Pick<McpHandlerOptions, 'authenticate'>) =>
  async ({ req, res }: { req: Request; res: Response }): Promise<boolean> => {
    const authInfo = await authenticate({ req, res });
    if (!authInfo) return false;

    req.mcpAuthInfo = authInfo;
    // Set req.auth so the MCP SDK passes authInfo to tool handlers via extra.authInfo
    req.auth = authInfo;
    return true;
  };

/**
 * The handlers of the public `/mcp` route, in the Streamable HTTP spec's stateless mode: every POST
 * gets a server and transport of its own and nothing outlives the request. A tool call needs only its
 * request's token, so an idle client or a backend restart has no session to lose, and a session id a
 * client still sends is ignored. Building the server registers every tool, about a millisecond.
 *
 * GET and DELETE answer 405: there is no stream to open, since nothing is ever pushed to a client, and
 * no session to end. Both still authenticate first, so the scope gate answers the same on every method.
 */
export function createStatelessMcpHandlers({
  authenticate,
  createServer,
  runRequest = (run) => run(),
}: McpHandlerOptions): McpHandlers {
  const authenticateRequest = bindAuthenticate({ authenticate });

  // oxlint-disable-next-line oxc/no-async-endpoint-handlers -- handler has internal try/catch for all async operations
  const post: McpHandler = async (req, res) => {
    if (!(await authenticateRequest({ req, res }))) return;

    try {
      const server = await createServer({ authInfo: req.mcpAuthInfo! });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on('close', () => {
        server.close().catch((error: unknown) => {
          logger.error('MCP stateless server close failed', { error: (error as Error).message });
        });
      });

      await server.connect(transport);
      // Tool calls mutate data, so each request gets its own revalue scope: the queued
      // rebuilds must run after the tool's writes, not inline from inside a model hook.
      await runRequest(() => transport.handleRequest(req, res, req.body));
    } catch (error) {
      handleMcpError({ error, res, label: 'POST' });
    }
  };

  // oxlint-disable-next-line oxc/no-async-endpoint-handlers -- handler has internal try/catch for all async operations
  const methodNotAllowed: McpHandler = async (req, res) => {
    try {
      if (!(await authenticateRequest({ req, res }))) return;

      res
        .status(405)
        .set('Allow', 'POST')
        .json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed: this server keeps no sessions or streams.' },
          id: null,
        });
    } catch (error) {
      handleMcpError({ error, res, label: req.method });
    }
  };

  return { post, get: methodNotAllowed, delete: methodNotAllowed };
}

/**
 * The session-based MCP Streamable HTTP handlers of the chat bridge's loopback listener (run tokens).
 * They own the session rules: a session belongs to the user and the run that created it, and nobody
 * else can use it. A session ends with its run, so it never needs to outlive a restart.
 */
export function createMcpSessionHandlers({
  authenticate,
  createServer,
  runRequest = (run) => run(),
}: McpHandlerOptions): McpHandlers {
  const authenticateRequest = bindAuthenticate({ authenticate });

  /**
   * Lookup an existing session transport by session ID from the request header.
   * Returns the transport if found, or sends a 400/403/404 error and returns null.
   * An unknown session answers 404, the status the Streamable HTTP spec tells a client to start a
   * new session on: sessions live in memory, so an idle timeout or a restart ends them. The JSON-RPC
   * code and message are the ones the MCP SDK's own server transport answers with.
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
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null,
      });
      return null;
    }

    // Verify the session belongs to the authenticated user and to the same run
    const authInfo = req.mcpAuthInfo;
    if (session.userId !== authInfo?.extra?.userId || session.runId !== authInfo?.extra?.chat?.runId) {
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
   * POST — Handle MCP JSON-RPC requests (initialization + tool calls)
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
   * GET — SSE stream for server-to-client notifications
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
   * DELETE — Terminate an MCP session
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
