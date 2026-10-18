import { type AI_PROVIDER, isAiCliProvider } from '@bt/shared/types';

import { runAiSdkChat } from './ai-sdk-runner';
import { runCliBridgeChat } from './cli-bridge-runner';
import type { ChatRunner } from './types';

/**
 * The runner for a connection's provider. API-key and custom-endpoint connections run in process
 * on the AI SDK; the Claude Code and Codex subscription connections run their CLI against the
 * chat bridge.
 */
export function selectChatRunner({ provider }: { provider: AI_PROVIDER }): ChatRunner {
  return isAiCliProvider({ provider }) ? runCliBridgeChat : runAiSdkChat;
}
