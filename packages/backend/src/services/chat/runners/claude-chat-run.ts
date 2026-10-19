import { AI_PROVIDER } from '@bt/shared/types';
import {
  buildClaudeChatArgs,
  createClaudeChatToolGuard,
  writeClaudeMcpConfig,
} from '@services/ai/cli/claude-chat-args';
import {
  assertClaudeResultSucceeded,
  buildClaudeStdinMessage,
  toUsage,
} from '@services/ai/cli/claude-code-language-model';
import { getCliBinaryPath } from '@services/ai/cli/cli-binaries';
import { buildClaudeEnv } from '@services/ai/cli/cli-env';
import { mapCliFailure } from '@services/ai/cli/cli-errors';
import { runCliProcess } from '@services/ai/cli/cli-process';
import { type CliPrompt, toUsageCounts } from '@services/ai/cli/cli-prompt';
import { withTempDir } from '@services/ai/cli/cli-workdir';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { ChatTextPolicy } from '../prompt/text-policy';
import type { ClarificationStop } from './clarification-stop';
import { type ClaudeChatEvent, createClaudeChatReader } from './claude-chat-reader';
import { createEventQueue } from './event-queue';
import type { CliChatOutcome } from './types';

const PROVIDER = AI_PROVIDER.claudeCode;

/**
 * Runs one chat turn on the Claude Code CLI: spawns it in a private temp dir with the chat
 * arguments, the MCP config pointing at the bridge and the token in its environment, and reads its
 * stream. Any tool but the bridge's own stops the run. Returns once the process has ended; when the
 * model asked the user a question, `stop` ends it early and that counts as a normal end.
 */
export async function runClaudeChat({
  model,
  credential,
  prompt,
  url,
  token,
  signal,
  stop,
  textPolicy,
  persist,
}: {
  model: string;
  credential: string;
  prompt: CliPrompt;
  url: string;
  token: string;
  signal: AbortSignal;
  stop: ClarificationStop;
  textPolicy: ChatTextPolicy;
  persist: (params: { stepCount: number }) => Promise<void>;
}): Promise<CliChatOutcome> {
  return withTempDir({
    prefix: 'mm-claude-chat',
    run: async ({ dir }) => {
      const home = path.join(dir, 'home');
      const cwd = path.join(dir, 'work');
      const ioDir = path.join(dir, 'io');

      await Promise.all([home, cwd, ioDir].map((target) => mkdir(target, { mode: 0o700 })));

      const mcpConfigPath = await writeClaudeMcpConfig({ dir: ioDir, url });
      const guardTools = createClaudeChatToolGuard();
      const reader = createClaudeChatReader({ textPolicy, persist });
      const queue = createEventQueue();

      try {
        const processResult = await runCliProcess({
          provider: PROVIDER,
          command: getCliBinaryPath({ provider: PROVIDER }),
          args: buildClaudeChatArgs({ model, system: prompt.system, mcpConfigPath }),
          env: buildClaudeEnv({ token: credential, home, chatToken: token }),
          cwd,
          stdin: buildClaudeStdinMessage({ prompt }),
          signal: AbortSignal.any([signal, stop.signal]),
          onStdoutLine: ({ line }) => {
            let event: ClaudeChatEvent | null;

            try {
              event = JSON.parse(line);
            } catch {
              return;
            }

            if (!event || typeof event !== 'object') return;

            guardTools({ event });
            stop.noteOutput();
            queue.push(() => reader.handle({ event }));
          },
        });

        await queue.drain();

        const result = reader.result();

        if (!result) {
          throw mapCliFailure({
            provider: PROVIDER,
            text: processResult.stderrTail,
            exitCode: processResult.exitCode,
          });
        }

        const { hitMaxTurns } = assertClaudeResultSucceeded({ event: result });

        return {
          status: hitMaxTurns ? 'stepLimit' : 'complete',
          stepCount: reader.stepCount(),
          usage: toUsageCounts({ usage: toUsage({ usage: result.usage }) }),
        };
      } catch (error) {
        // The model asked the user a question and the CLI was ended on purpose; the text read so far stands.
        if (stop.fired() && !signal.aborted) {
          await queue.drain().catch(() => undefined);

          return { status: 'complete', stepCount: reader.stepCount() };
        }

        throw error;
      } finally {
        // Handlers still queued must not write after the run's end.
        await queue.drain().catch(() => undefined);
      }
    },
  });
}
