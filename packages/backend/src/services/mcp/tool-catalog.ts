import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import type { McpAuthInfo } from './auth';
import { registerAllTools } from './server';
import { READ_TOOL_NAME } from './tool-classification';

/** What a tool handler reads from the MCP SDK's `extra`: only the auth info. */
export interface ToolInvokeExtra {
  authInfo: McpAuthInfo;
}

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  /** The tool's input as a plain zod shape, or `null` for a tool registered without an `inputSchema`. */
  inputShape: z.ZodRawShape | null;
  /** `read` for the names `READ_TOOL_NAME` matches, `write` for every other tool. */
  access: 'read' | 'write';
  /**
   * Calls the registered handler with the right arity: `handler(extra)` for a tool without input,
   * `handler(args, extra)` for the rest. The caller owns the guards' input, `extra`; the handler
   * still runs its own scope, feature, lock and rate-limit checks.
   */
  invoke: (params: { args?: unknown; extra: ToolInvokeExtra }) => Promise<ToolCallResult>;
}

type RegisteredHandler = (...params: unknown[]) => Promise<ToolCallResult>;

interface RegisteredToolConfig {
  description?: string;
  inputSchema?: z.ZodRawShape;
}

let catalog: readonly ToolCatalogEntry[] | null = null;

function buildEntry({
  name,
  config,
  handler,
}: {
  name: string;
  config: RegisteredToolConfig;
  handler: RegisteredHandler;
}): ToolCatalogEntry {
  const inputShape = config.inputSchema ?? null;

  return Object.freeze({
    name,
    description: config.description ?? '',
    inputShape,
    access: READ_TOOL_NAME.test(name) ? ('read' as const) : ('write' as const),
    invoke: ({ args, extra }: { args?: unknown; extra: ToolInvokeExtra }) =>
      inputShape === null ? handler(extra) : handler(args ?? {}, extra),
  });
}

/**
 * Every MCP tool with its handler, built once. It runs `registerAllTools` against a capture shim
 * that records each `registerTool` call, so the chat uses the handlers the MCP server uses and a
 * new tool needs no second registration. The SDK's private tool map is not read.
 */
export function getToolCatalog(): readonly ToolCatalogEntry[] {
  if (catalog) return catalog;

  const entries: ToolCatalogEntry[] = [];
  const shim = {
    registerTool: (name: string, config: RegisteredToolConfig, handler: RegisteredHandler) => {
      entries.push(buildEntry({ name, config, handler }));
    },
  } as unknown as McpServer;

  registerAllTools(shim);
  catalog = Object.freeze(entries);
  return catalog;
}
