import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

import { CHAT_CORE_TOOLS } from '../policies/core-tools';
import type { ChatToolDefinition, ChatToolkit } from '../toolkit/types';
import { createUseCapabilityTool, USE_CAPABILITY_TOOL } from './use-capability';

const UNKNOWN_TOOL_HINT = `Tools that are not in your tool list are called through ${USE_CAPABILITY_TOOL}; find_capabilities searches them.`;

/**
 * The tools a bridge session offers: the core set, the chat-native tools and the dispatcher. The
 * list is the same for the whole session; the rest of the catalog is reached through `use_capability`.
 */
function offeredTools({ toolkit }: { toolkit: ChatToolkit }): Map<string, ChatToolDefinition> {
  const offered = new Map<string, ChatToolDefinition>();

  for (const tool of toolkit.tools) {
    if (tool.kind === 'native' || CHAT_CORE_TOOLS.includes(tool.name)) offered.set(tool.name, tool);
  }
  const dispatcher = createUseCapabilityTool({ toolkit });
  offered.set(dispatcher.name, dispatcher);

  return offered;
}

const failure = ({ text }: { text: string }) => ({ isError: true, content: [{ type: 'text' as const, text }] });

/**
 * The MCP server a CLI run talks to: a low-level `Server` with its own `tools/list` and `tools/call`,
 * not `McpServer.registerTool`, so it advertises the very JSON Schemas the AI SDK path sends (refs
 * accepted in every uuid position) and routes every call through the run's toolkit. The toolkit
 * validates, proposes instead of writing, and holds the per-message limits; this layer adds nothing.
 */
export function createChatMcpServer({ toolkit }: { toolkit: ChatToolkit }): Server {
  const offered = offeredTools({ toolkit });

  const server = new Server({ name: 'moneymatter-chat', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...offered.values()].map(
      ({ name, description, modelSchema }): Tool => ({
        name,
        description,
        inputSchema: modelSchema as Tool['inputSchema'],
      }),
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: input = {} } = request.params;

    const tool = offered.get(name);
    if (!tool) return failure({ text: `Unknown tool "${name}". ${UNKNOWN_TOOL_HINT}` });

    // The same check the AI SDK runs before `execute`, so a bad call costs no tool call.
    const validation = tool.validate({ input });
    if (!validation.success) return failure({ text: validation.error.message });

    const result = await tool.execute({ input: validation.value });
    return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) };
  });

  return server;
}
