import { Unauthorized } from '@js/errors';
import { logger } from '@js/utils/logger';
import type { Request, Response } from 'express';

import type { McpAuthInfo } from '../../mcp/auth';
import { verifyChatBridgeToken } from './bridge-token';
import { CHAT_BRIDGE_TOKEN_PREFIX } from './bridge-token-prefix';

const jsonRpcError = ({ code, message }: { code: number; message: string }) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

/**
 * Authenticates a request to the loopback listener. Only a chat bridge token is accepted: an OAuth
 * access token, or no token, is a 401 without a lookup. Answers the request itself when it refuses.
 */
export async function authenticateBridgeRequest({
  req,
  res,
}: {
  req: Request;
  res: Response;
}): Promise<McpAuthInfo | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token.startsWith(CHAT_BRIDGE_TOKEN_PREFIX)) {
    res.status(401).json(jsonRpcError({ code: -32001, message: 'Unauthorized' }));
    return null;
  }

  try {
    return await verifyChatBridgeToken({ token });
  } catch (error) {
    if (error instanceof Unauthorized) {
      res.status(401).json(jsonRpcError({ code: -32001, message: 'Unauthorized' }));
    } else {
      // The token store or the database failed: the run is not at fault, and a retry may work.
      logger.error(error as Error);
      res.status(503).json(jsonRpcError({ code: -32000, message: 'The chat bridge is unavailable' }));
    }
    return null;
  }
}
