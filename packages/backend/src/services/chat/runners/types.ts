import type { ChatRunEvent } from '@bt/shared/types';
import type { AIClientResult } from '@services/ai/ai-client-factory';

import type { ChatTextPolicy } from '../prompt/text-policy';

/** What a runner receives from the run manager, whichever model path it drives. */
export interface ChatRunnerInput {
  runId: string;
  threadId: string;
  /** The assistant message the run fills. */
  messageId: string;
  /** The user message the run answers. */
  userMessageId: string;
  userId: number;
  aiClient: AIClientResult;
  /** Aborts on cancel, shutdown and the run's wall-time ceiling. */
  signal: AbortSignal;
  /** Writes one event to the run's stream and to the message being recorded. */
  emit: (event: ChatRunEvent) => Promise<void>;
  textPolicy: ChatTextPolicy;
  /** Saves the parts recorded so far; runners call it at the end of each model step. */
  persist: (params: { stepCount: number }) => Promise<void>;
}

/** `aborted`: the signal fired and the runner stopped early; the manager reads the reason off the signal. */
export interface ChatRunnerResult {
  status: 'complete' | 'stepLimit' | 'aborted';
  stepCount: number;
}

export type ChatRunner = (input: ChatRunnerInput) => Promise<ChatRunnerResult>;

/** What one CLI chat process reports back to the runner that spawned it. */
export interface CliChatOutcome {
  /** `stepLimit`: the CLI ran out of model turns. */
  status: 'complete' | 'stepLimit';
  stepCount: number;
  /** Absent when the CLI never got to report it (the process was ended after a clarification). */
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
}
