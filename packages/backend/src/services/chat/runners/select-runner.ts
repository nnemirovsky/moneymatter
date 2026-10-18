import { type AI_PROVIDER, isAiCliProvider } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';

import { runAiSdkChat } from './ai-sdk-runner';
import type { ChatRunner } from './types';

/**
 * The runner for a connection's provider. API-key and custom-endpoint connections run in process
 * on the AI SDK; the Claude Code and Codex subscription connections need the CLI bridge, which the
 * Phase 2 runners add here, and are refused until then.
 */
export function selectChatRunner({ provider }: { provider: AI_PROVIDER }): ChatRunner {
  if (isAiCliProvider({ provider })) {
    throw new ValidationError({ message: t({ key: 'chat.cliBridgeUnavailable' }) });
  }

  return runAiSdkChat;
}
