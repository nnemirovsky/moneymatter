import { AI_FEATURE, AI_PROVIDER, asAiCliProvider, CHAT_MAX_STEPS, getModelNameFromModelId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { runWithCliCredential } from '@services/ai/cli/cli-credential-run';
import { CliSlotBusyError, getChatRunTimeoutMs, getChatSlotWaitMs } from '@services/ai/cli/cli-run-limiter';
import { trackAiUsage } from '@services/ai/track-ai-usage';
import { connectionCredentialSource } from '@services/user-settings/ai-connections';
import { randomUUID } from 'node:crypto';

import { ensureBridgeListener } from '../bridge/bridge-listener';
import { registerBridgeRun } from '../bridge/bridge-runs';
import { markSlotAcquired, mintChatBridgeToken, revokeChatBridgeToken } from '../bridge/bridge-token';
import { ChatRunFailureError } from '../runs/run-failure';
import { createClarificationStop } from './clarification-stop';
import { runClaudeChat } from './claude-chat-run';
import { toCliPrompt } from './cli-transcript';
import { runCodexChat } from './codex-chat-run';
import { prepareChatTurn } from './prepare-turn';
import { createToolCallTracker } from './tool-call-tracker';
import type { ChatRunner } from './types';

/** A run that is still queued for a CLI slot after this long says so. */
const WAITING_NOTICE_DELAY_MS = 1_000;

/**
 * Runs one chat turn on a Claude Code or Codex subscription. The CLI gets MoneyMatter's chat-mode
 * MCP server on the loopback listener and a token that names this run alone; everything it can do
 * goes through the run's toolkit, the same one the AI SDK runner uses, so the limits, the cards and
 * the text policy are the same. The token exists from before the wait for a slot until the run
 * ends, and is revoked here whatever the outcome (the run manager revokes by run as well).
 */
export const runCliBridgeChat: ChatRunner = async (input) => {
  const { runId, threadId, userId, aiClient, signal, emit, textPolicy, persist } = input;
  const provider = asAiCliProvider({ provider: aiClient.provider });

  if (!provider || !aiClient.connectionId) {
    throw new Error('The CLI bridge runner needs a Claude Code or Codex connection');
  }

  let stepCount = 0;
  const persistStep = async (params: { stepCount: number }) => {
    stepCount = params.stepCount;
    await persist(params);
  };

  const tracker = createToolCallTracker({ emit });
  const stop = createClarificationStop();
  let token: string | null = null;
  let waitingNotice: NodeJS.Timeout | undefined;

  try {
    const turn = await prepareChatTurn({
      input: { ...input, emit: tracker.emit },
      toolkitRun: { onAwaitingClarification: stop.arm, announceToolCalls: true },
    });
    const prompt = toCliPrompt({ system: turn.system, messages: turn.messages });

    registerBridgeRun({ runId, toolkit: turn.toolkit });
    const { url } = await ensureBridgeListener();
    const chatToken = await mintChatBridgeToken({ userId, threadId, runId, provider });
    token = chatToken;

    waitingNotice = setTimeout(() => {
      emit({
        type: 'part.started',
        part: { type: 'notice', id: randomUUID(), key: 'chat.notices.waitingForCli', params: {} },
      }).catch((error: Error) => logger.warn('Chat run: the waiting notice failed', { runId, error: error.message }));
    }, WAITING_NOTICE_DELAY_MS);
    waitingNotice.unref();

    const model = getModelNameFromModelId({ modelId: aiClient.modelId });
    const outcome = await runWithCliCredential({
      provider,
      source: connectionCredentialSource({ userId, connectionId: aiClient.connectionId }),
      abortSignal: signal,
      timeoutMs: getChatRunTimeoutMs(),
      maxWaitMs: getChatSlotWaitMs(),
      // Called once the global slot is held: the token's clock restarts from here.
      run: async ({ credential, codexHome, signal: runSignal }) => {
        clearTimeout(waitingNotice);
        await markSlotAcquired({ token: chatToken });

        const common = {
          model,
          effort: aiClient.effort,
          prompt,
          url,
          token: chatToken,
          signal: runSignal,
          stop,
          textPolicy,
          persist: persistStep,
        };

        return provider === AI_PROVIDER.codex
          ? runCodexChat({ ...common, codexHome: codexHome! })
          : runClaudeChat({ ...common, credential: credential! });
      },
    });

    stepCount = outcome.stepCount;

    if (outcome.usage) {
      await emit({ type: 'usage', ...outcome.usage });
      trackAiUsage({
        userId,
        feature: AI_FEATURE.chat,
        aiClient,
        usage: { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens },
      });
    }

    if (outcome.status === 'stepLimit') {
      await emit({
        type: 'part.started',
        part: {
          type: 'notice',
          id: randomUUID(),
          key: 'chat.notices.stepLimit',
          params: { limit: CHAT_MAX_STEPS },
        },
      });
    }

    return { status: outcome.status, stepCount };
  } catch (error) {
    if (signal.aborted) return { status: 'aborted', stepCount };
    if (error instanceof CliSlotBusyError) {
      throw new ChatRunFailureError({ code: 'cliBusy', messageKey: 'chat.cliBusy' });
    }
    if ((error as Error | undefined)?.name === 'TimeoutError') {
      throw new ChatRunFailureError({ code: 'timeout', messageKey: 'chat.errors.timeout' });
    }

    throw error;
  } finally {
    clearTimeout(waitingNotice);
    stop.dispose();
    // A call the CLI left open when it was stopped must not stay "running" in the stored message.
    await tracker.closeOpen();

    if (token) {
      await revokeChatBridgeToken({ token }).catch((error: Error) =>
        logger.warn('Chat bridge token revoke failed', { runId, error: error.message }),
      );
    }
  }
};
