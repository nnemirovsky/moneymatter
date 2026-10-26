import { type AiEffort, CHAT_MAX_STEPS } from '@bt/shared/types';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CLAUDE_HARDENING_ARGS, CLAUDE_STREAM_ARGS, createToolGuard } from './claude-code-language-model';
import { CHAT_MCP_SERVER, CHAT_TOKEN_ENV } from './cli-chat-bridge';
import { claudeEffortArgs } from './cli-effort-args';

/** Claude Code names an MCP tool `mcp__<server>__<tool>`. */
const CHAT_TOOL_PREFIX = `mcp__${CHAT_MCP_SERVER}__`;

/**
 * The argv of a Claude Code chat run: the shared stream flags and tool hardening, unchanged, plus
 * the chat additions: partial messages for live text, the one MCP server, permission to call its
 * tools without a prompt, and the step cap. The token is not here: the MCP config names the
 * environment variable that carries it.
 */
export function buildClaudeChatArgs({
  model,
  effort,
  system,
  mcpConfigPath,
}: {
  model: string;
  effort?: AiEffort | null;
  system: string;
  mcpConfigPath: string;
}): string[] {
  return [
    ...CLAUDE_STREAM_ARGS,
    '--include-partial-messages',
    '--model',
    model,
    ...claudeEffortArgs({ effort }),
    '--system-prompt',
    system,
    ...CLAUDE_HARDENING_ARGS,
    '--mcp-config',
    mcpConfigPath,
    '--allowedTools',
    `mcp__${CHAT_MCP_SERVER}`,
    '--max-turns',
    String(CHAT_MAX_STEPS),
  ];
}

/**
 * Writes the run's MCP config (0600) into `dir`. The `Authorization` header holds `${MM_CHAT_TOKEN}`
 * for the CLI to expand from its environment, so the token itself never reaches disk or argv.
 */
export async function writeClaudeMcpConfig({ dir, url }: { dir: string; url: string }): Promise<string> {
  const file = path.join(dir, 'mcp.json');
  const config = {
    mcpServers: {
      [CHAT_MCP_SERVER]: { type: 'http', url, headers: { Authorization: `Bearer \${${CHAT_TOKEN_ENV}}` } },
    },
  };

  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  // The mode of a file that already existed, or a restrictive umask, must not decide who can read it.
  await chmod(file, 0o600);

  return file;
}

const isChatTool = ({ name, type }: { name: string; type: string }) =>
  type === 'tool_use' && name.startsWith(CHAT_TOOL_PREFIX);

/** The feature-run tool guard with the chat's one exception: calls to its own MCP server. */
export const createClaudeChatToolGuard = () =>
  createToolGuard({ isAllowedTool: isChatTool, structuredOutput: 'never' });
