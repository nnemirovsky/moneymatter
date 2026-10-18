import { z } from 'zod';

import type { ToolCatalogEntry } from '../../mcp/tool-catalog';
import { THIRD_PARTY_READ_TOOLS } from '../policies/explicit';
import { describeInputError } from '../proposals/placeholders';
import { capForModel, compactArgs, errorMessage, toolFailure, toolSuccess } from './result-text';
import type { ChatToolContext, ChatToolResult } from './types';

/**
 * Runs a catalog read for the model. The tool's own schema and validators run first (the SDK would
 * have run them for an MCP client), then the handler, with the read-only `extra`. The whole result
 * stays in the run for later analysis; the model sees a capped copy, and the read becomes a source
 * of every card the run proposes afterwards.
 */
export async function runCatalogRead({
  ctx,
  entry,
  input,
  callId,
}: {
  ctx: ChatToolContext;
  entry: ToolCatalogEntry;
  input: unknown;
  callId: string;
}): Promise<ChatToolResult> {
  let args: unknown;
  try {
    args = entry.inputShape === null ? undefined : z.object(entry.inputShape).parse(input ?? {});
    entry.validateArgs({ args });
  } catch (error) {
    return toolFailure({ text: describeInputError({ error }) });
  }

  if (THIRD_PARTY_READ_TOOLS.includes(entry.name)) {
    const taken = ctx.state.limits.take({ kind: 'thirdPartyReads' });
    if (!taken.ok) {
      await ctx.notice({ key: taken.noticeKey, params: { limit: taken.limit } });
      return toolFailure({ text: taken.message });
    }
  }

  try {
    const result = await entry.invoke({ args, extra: await ctx.getExtra() });
    const fullText = result.content.map((block) => block.text).join('\n');

    ctx.state.reads.set(callId, { callId, toolName: entry.name, args: input, fullText });
    ctx.state.sources.push({ type: 'toolCall', callId, toolName: entry.name, args: compactArgs({ args: input }) });

    const text = capForModel({ text: fullText });
    return toolSuccess({ text: ctx.run.wrapUntrusted?.({ kind: 'toolResult', text }) ?? text });
  } catch (error) {
    return toolFailure({ text: errorMessage({ error }) });
  }
}
