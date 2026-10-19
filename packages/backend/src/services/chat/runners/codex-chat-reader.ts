import type { CodexEvent } from '@services/ai/cli/codex-language-model';
import { randomUUID } from 'node:crypto';

import type { ChatTextPolicy } from '../prompt/text-policy';

/**
 * Turns the `--json` events of a Codex chat run into what the run records: each finished agent
 * message goes to the text policy (Codex prints a message whole, not in pieces), and each finished
 * agent message or MCP call counts as a step. Tool activity is not read here: the toolkit reports
 * its own calls.
 */
export function createCodexChatReader({
  textPolicy,
  persist,
}: {
  textPolicy: ChatTextPolicy;
  persist: (params: { stepCount: number }) => Promise<void>;
}) {
  let steps = 0;

  return {
    handle: async ({ event }: { event: CodexEvent }): Promise<void> => {
      if (event.type !== 'item.completed' || !event.item) return;

      const { item } = event;

      if (item.type === 'agent_message' && typeof item.text === 'string') {
        await textPolicy.delta({ partId: randomUUID(), delta: item.text });
      } else if (item.type !== 'mcp_tool_call') {
        return;
      }

      steps += 1;
      await persist({ stepCount: steps });
    },
    stepCount: () => steps,
  };
}
