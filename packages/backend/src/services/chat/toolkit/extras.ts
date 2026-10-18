import { buildMcpAuthInfo } from '../../mcp/auth';
import type { ToolInvokeExtra } from '../../mcp/tool-catalog';
import type { ChatToolkitRun } from './types';

/** The client id every chat read runs under. */
export const CHAT_CLIENT_ID = 'moneymatter-chat';

/**
 * The `extra` a read runs with: the plan entitlements of the user, and only the `finance:read`
 * scope. If a write tool were ever classified as a read, its own `requireScope` would refuse it.
 */
export async function buildChatReadExtra({ user }: { user: ChatToolkitRun['user'] }): Promise<ToolInvokeExtra> {
  const authInfo = await buildMcpAuthInfo({
    user,
    clientId: CHAT_CLIENT_ID,
    scopes: ['finance:read'],
    // No bearer token exists for an in-process call; nothing reads this value.
    token: `${CHAT_CLIENT_ID}:in-process`,
  });

  return { authInfo };
}
