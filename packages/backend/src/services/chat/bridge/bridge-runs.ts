import { logger } from '@js/utils/logger';

import { removeSessionsOfRun } from '../../mcp/transport-manager';
import type { ChatToolkit } from '../toolkit/types';
import { revokeChatBridgeTokenOfRun } from './bridge-token';

/**
 * The toolkits of the CLI runs this process executes, by run id. A bridge request is served by the
 * toolkit of the run its token names, so every call meets the same limits, the same "waiting for the
 * answer" rule and the same recorder as the AI SDK path. A run executes in the process that accepted
 * it, so a token only ever finds its toolkit here.
 */
const toolkits = new Map<string, ChatToolkit>();

export function registerBridgeRun({ runId, toolkit }: { runId: string; toolkit: ChatToolkit }): void {
  toolkits.set(runId, toolkit);
}

export function getBridgeRunToolkit({ runId }: { runId: string }): ChatToolkit | undefined {
  return toolkits.get(runId);
}

/**
 * Ends the bridge side of a run, whatever the run's outcome: its toolkit leaves the registry, its
 * sessions close and its token is revoked. Safe for a run that never used the bridge.
 */
export async function endBridgeRun({ runId }: { runId: string }): Promise<void> {
  toolkits.delete(runId);
  removeSessionsOfRun({ runId });

  try {
    await revokeChatBridgeTokenOfRun({ runId });
  } catch (error) {
    // The token still dies with its TTL; the run's end must not fail on it.
    logger.warn('Chat bridge token revoke failed', { runId, error: (error as Error).message });
  }
}
