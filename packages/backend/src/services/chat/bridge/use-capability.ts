import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { CHAT_EXCLUDED_TOOLS } from '../policies/excluded';
import { CHAT_META_FIELD } from '../toolkit/model-schema';
import { defineNativeTool } from '../toolkit/native-tool';
import { toolFailure } from '../toolkit/result-text';
import type { ChatToolDefinition, ChatToolkit } from '../toolkit/types';

export const USE_CAPABILITY_TOOL = 'use_capability';

/**
 * The dispatcher for the long tail. A tool list is fixed when an MCP session starts, and CLIs differ
 * in whether they notice a changed one, so the tools `find_capabilities` finds are called through
 * this one instead. It checks the arguments against the named tool's own schema and runs the
 * toolkit's own definition of it: a write proposes a card, a read runs with the read-only scope, and
 * the per-message limits count the named tool.
 */
export function createUseCapabilityTool({ toolkit }: { toolkit: ChatToolkit }): ChatToolDefinition {
  const inner = defineNativeTool({
    name: USE_CAPABILITY_TOOL,
    description:
      'Call a tool that is not in your tool list. Find it with find_capabilities first, then pass its name and its arguments here. Changes still become cards for the user to approve.',
    shape: {
      name: z.string().trim().min(1).max(100).describe('The exact name of the tool, as find_capabilities returned it'),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The tool's arguments; omit for a tool without input"),
      meta: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('The optional _chat object of a tool that changes data: uncertain, replaces, sourceCallIds'),
    },
    run: async ({ args, callId }) => {
      const { name } = args;

      if (Object.hasOwn(CHAT_EXCLUDED_TOOLS, name)) {
        return toolFailure({ text: `"${name}" is not available in the chat.` });
      }

      const target = toolkit.getTool({ name });
      if (!target) {
        return toolFailure({ text: `Unknown tool "${name}". Search for it with find_capabilities.` });
      }
      if (target.kind === 'native') {
        return toolFailure({
          text: `"${name}" is in your tool list: call it by its own name, not through ${USE_CAPABILITY_TOOL}.`,
        });
      }

      const input =
        target.kind === 'write' && args.meta ? { ...args.args, [CHAT_META_FIELD]: args.meta } : (args.args ?? {});
      const validation = target.validate({ input });
      if (!validation.success) return toolFailure({ text: validation.error.message });

      return target.execute({ input: validation.value, callId });
    },
  });

  return { ...inner, execute: ({ input, callId = randomUUID() }) => inner.execute({ input, callId }) };
}
