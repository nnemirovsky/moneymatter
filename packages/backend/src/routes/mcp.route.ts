import { logger } from '@js/utils/logger';
import { runWithBalanceRevalueBatch } from '@services/balances/revalue-balance-history.service';
import { McpAuthInfo, verifyMcpToken } from '@services/mcp/auth';
import { createMcpHandlers } from '@services/mcp/http-handlers';
import { createMcpServer } from '@services/mcp/server';
import { startSessionCleanup } from '@services/mcp/transport-manager';
import { Router, Request, Response } from 'express';

import { MCP_BASE_URL } from '../config';

const router = Router();

// Start the idle session cleanup interval (skip in tests to avoid open handles)
if (process.env.NODE_ENV !== 'test') {
  startSessionCleanup();
}

/**
 * Authenticate MCP requests via OAuth bearer token.
 * Answers 401 if the token is missing, invalid, or expired, and 403 if it lacks `finance:read`;
 * returns the auth info otherwise.
 */
async function authenticateMcpRequest({ req, res }: { req: Request; res: Response }): Promise<McpAuthInfo | null> {
  const resourceMetadataUrl = `${MCP_BASE_URL}/.well-known/oauth-protected-resource`;

  let authInfo: McpAuthInfo;
  try {
    authInfo = await verifyMcpToken({
      authorizationHeader: req.headers.authorization,
    });
  } catch {
    res
      .status(401)
      .set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`)
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
    return null;
  }

  // Read tools do not check scopes themselves, so this is the only gate keeping a
  // token without `finance:read` away from them.
  if (!authInfo.scopes.includes('finance:read')) {
    logger.info('MCP request rejected: token lacks finance:read', {
      clientId: authInfo.clientId,
      scopes: authInfo.scopes,
    });
    // The challenge repeats the granted scopes: a client that re-authorizes with
    // exactly the challenged list would otherwise lose them.
    const challengeScope = ['finance:read', ...authInfo.scopes].join(' ');
    res
      .status(403)
      .set(
        'WWW-Authenticate',
        `Bearer error="insufficient_scope", scope="${challengeScope}", resource_metadata="${resourceMetadataUrl}"`,
      )
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Missing required scope: finance:read. Re-connect the app and grant it.' },
        id: null,
      });
    return null;
  }

  return authInfo;
}

const handlers = createMcpHandlers({
  authenticate: authenticateMcpRequest,
  createServer: () => createMcpServer(),
  sessionKind: 'oauth',
  runRequest: runWithBalanceRevalueBatch,
});

router.post('/', handlers.post);
router.get('/', handlers.get);
router.delete('/', handlers.delete);

export default router;
