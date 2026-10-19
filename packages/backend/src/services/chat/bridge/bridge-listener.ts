import { API_ERROR_CODES } from '@bt/shared/types';
import { isSelfHost } from '@config/is-self-host';
import { CustomError } from '@js/errors';
import { createMcpHandlers } from '@services/mcp/http-handlers';
import express from 'express';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticateBridgeRequest } from './bridge-auth';
import { getBridgeRunToolkit } from './bridge-runs';
import { createChatMcpServer } from './chat-mcp-server';

const LOOPBACK = '127.0.0.1';
const BRIDGE_PATH = '/mcp';

interface RunningListener {
  server: HttpServer;
  port: number;
  url: string;
}

let listener: Promise<RunningListener> | null = null;

function createBridgeApp(): express.Express {
  const handlers = createMcpHandlers({
    authenticate: authenticateBridgeRequest,
    sessionKind: 'chatBridge',
    createServer: ({ authInfo }) => {
      const runId = authInfo.extra.chat?.runId;
      const toolkit = runId ? getBridgeRunToolkit({ runId }) : undefined;
      // A run executes in the process that accepted it; a token that reaches another one finds no toolkit.
      if (!toolkit) throw new CustomError(503, API_ERROR_CODES.unexpected, 'This chat run is not served here');

      return createChatMcpServer({ toolkit });
    },
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.post(BRIDGE_PATH, handlers.post);
  app.get(BRIDGE_PATH, handlers.get);
  app.delete(BRIDGE_PATH, handlers.delete);
  return app;
}

const startListener = (): Promise<RunningListener> =>
  new Promise((resolve, reject) => {
    const server = createBridgeApp().listen(0, LOOPBACK);
    server.once('error', reject);
    server.once('listening', () => {
      // Closing is explicit (`closeBridgeListener`); an idle listener must not keep the process alive.
      server.unref();
      const { port } = server.address() as AddressInfo;
      resolve({ server, port, url: `http://${LOOPBACK}:${port}${BRIDGE_PATH}` });
    });
  });

/**
 * The loopback endpoint the CLI dials: `http://127.0.0.1:<port>/mcp`, no TLS, no Cloudflare Access in
 * the way and no public exposure. Started on first use, and only on a self-hosted instance, because
 * only there does the server run the user's CLI.
 */
export async function ensureBridgeListener(): Promise<{ port: number; url: string }> {
  if (!isSelfHost()) throw new Error('The chat bridge runs on self-hosted instances only');

  listener ??= startListener().catch((error: unknown) => {
    listener = null;
    throw error;
  });
  const { port, url } = await listener;
  return { port, url };
}

export async function closeBridgeListener(): Promise<void> {
  if (!listener) return;

  const running = await listener.catch(() => null);
  listener = null;
  if (!running) return;

  await new Promise<void>((resolve) => {
    running.server.close(() => resolve());
    running.server.closeAllConnections();
  });
}
