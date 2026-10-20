import { AI_PROVIDER } from '@bt/shared/types';
import { getCliBinaryPath } from '@services/ai/cli/cli-binaries';
import { buildCodexEnv } from '@services/ai/cli/cli-env';
import { runCliProcess } from '@services/ai/cli/cli-process';
import { type CliPrompt, toUsageCounts } from '@services/ai/cli/cli-prompt';
import { withTempDir } from '@services/ai/cli/cli-workdir';
import { buildCodexChatArgs, guardCodexChatItem } from '@services/ai/cli/codex-chat-args';
import {
  assertCodexTurnCompleted,
  type CodexEvent,
  createCodexTurnState,
  MAX_DEVELOPER_INSTRUCTIONS_CHARS,
  recordCodexTurnEvent,
  toUsage,
  writeCodexPromptImages,
} from '@services/ai/cli/codex-language-model';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { ChatTextPolicy } from '../prompt/text-policy';
import type { ClarificationStop } from './clarification-stop';
import { createCodexChatReader } from './codex-chat-reader';
import { createEventQueue } from './event-queue';
import type { CliChatOutcome } from './types';

const PROVIDER = AI_PROVIDER.codex;

/**
 * Runs one chat turn on `codex exec`: spawns it in a private temp dir with the chat arguments (the
 * bridge as its one MCP server, the token read from its environment) and reads its `--json` items.
 * Any item but an answer or a call to the bridge stops the run. Returns once the process has ended;
 * when the model asked the user a question, `stop` ends it early and that counts as a normal end.
 */
export async function runCodexChat({
  model,
  codexHome,
  prompt,
  url,
  token,
  signal,
  stop,
  textPolicy,
  persist,
}: {
  model: string;
  codexHome: string;
  prompt: CliPrompt;
  url: string;
  token: string;
  signal: AbortSignal;
  stop: ClarificationStop;
  textPolicy: ChatTextPolicy;
  persist: (params: { stepCount: number }) => Promise<void>;
}): Promise<CliChatOutcome> {
  return withTempDir({
    prefix: 'mm-codex-chat',
    run: async ({ dir }) => {
      const workdir = path.join(dir, 'work');
      const ioDir = path.join(dir, 'io');

      await Promise.all([workdir, ioDir].map((target) => mkdir(target, { mode: 0o700 })));

      const { imagePaths, textParts } = await writeCodexPromptImages({ prompt, ioDir });
      const systemFitsArgv = prompt.system.length <= MAX_DEVELOPER_INSTRUCTIONS_CHARS;
      const stdinParts = systemFitsArgv ? textParts : [prompt.system, ...textParts].filter(Boolean);

      // `codex exec -` refuses an empty prompt, which an image-only message would otherwise send.
      if (stdinParts.length === 0) stdinParts.push('Use the attached image(s) to answer.');

      const state = createCodexTurnState();
      const reader = createCodexChatReader({ textPolicy, persist });
      const queue = createEventQueue();

      try {
        const processResult = await runCliProcess({
          provider: PROVIDER,
          command: getCliBinaryPath({ provider: PROVIDER }),
          args: buildCodexChatArgs({
            model,
            workdir,
            url,
            imagePaths,
            developerInstructions: systemFitsArgv && prompt.system ? prompt.system : undefined,
          }),
          env: buildCodexEnv({ codexHome, chatToken: token }),
          cwd: workdir,
          stdin: stdinParts.join('\n\n'),
          signal: AbortSignal.any([signal, stop.signal]),
          onStdoutLine: ({ line }) => {
            let event: CodexEvent | null;

            try {
              event = JSON.parse(line);
            } catch {
              return;
            }

            if (!event || typeof event !== 'object') return;

            if (event.type?.startsWith('item.')) guardCodexChatItem({ item: event.item });

            stop.noteOutput();
            recordCodexTurnEvent({ state, event });
            queue.push(() => reader.handle({ event }));
          },
        });

        await queue.drain();
        assertCodexTurnCompleted({ state, exitCode: processResult.exitCode, stderrTail: processResult.stderrTail });

        return {
          status: 'complete',
          stepCount: reader.stepCount(),
          usage: toUsageCounts({ usage: toUsage({ usage: state.usage }) }),
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
