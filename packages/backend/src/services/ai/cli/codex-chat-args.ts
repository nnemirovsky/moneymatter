import type { AiEffort } from '@bt/shared/types';

import { CHAT_MCP_SERVER, CHAT_TOKEN_ENV } from './cli-chat-bridge';
import { codexEffortArgs } from './cli-effort-args';
import {
  type CodexItem,
  CODEX_CHAT_HARDENING_ARGS,
  guardCodexItem,
  isCodexAnswerItem,
  toTomlString,
} from './codex-language-model';

/** How long Codex waits for one bridge tool call. */
const TOOL_TIMEOUT_SEC = 60;

/**
 * Under `approval_policy="never"` `codex exec` fails every MCP call that needs approval, and a tool
 * without a read-only annotation needs it. The bridge's tools only read or propose, and the user
 * approves each change on its card, so the server's calls go through unprompted.
 */
const TOOLS_APPROVAL_MODE = 'approve';

/**
 * The argv of a Codex chat run: the shared hardening list (less `code_mode_host`, which the bridge's tools need), plus the model, the work dir,
 * the one MCP server (its URL, the environment variable that carries the token, a per-call timeout, auto-approved calls),
 * the system prompt and the images. The token is not here.
 */
export function buildCodexChatArgs({
  model,
  effort,
  workdir,
  url,
  imagePaths,
  developerInstructions,
}: {
  model: string;
  effort?: AiEffort | null;
  workdir: string;
  url: string;
  imagePaths: string[];
  developerInstructions: string | undefined;
}): string[] {
  const server = `mcp_servers.${CHAT_MCP_SERVER}`;
  const args = [
    ...CODEX_CHAT_HARDENING_ARGS,
    '-m',
    model,
    ...codexEffortArgs({ effort }),
    '-C',
    workdir,
    '-c',
    `${server}.url=${toTomlString({ value: url })}`,
    '-c',
    `${server}.bearer_token_env_var=${toTomlString({ value: CHAT_TOKEN_ENV })}`,
    '-c',
    `${server}.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`,
    '-c',
    `${server}.default_tools_approval_mode=${toTomlString({ value: TOOLS_APPROVAL_MODE })}`,
  ];

  if (developerInstructions) {
    args.push('-c', `developer_instructions=${toTomlString({ value: developerInstructions })}`);
  }

  for (const imagePath of imagePaths) args.push('-i', imagePath);

  // `-i` takes a list of values, so `--` keeps the stdin marker from being read as another image.
  args.push('--', '-');

  return args;
}

const isChatItem = ({ item }: { item: CodexItem }) =>
  isCodexAnswerItem({ item }) || (item.type === 'mcp_tool_call' && item.server === CHAT_MCP_SERVER);

/** The feature-run item guard with the chat's one exception: calls to its own MCP server. */
export function guardCodexChatItem({ item }: { item: CodexItem | undefined }): void {
  guardCodexItem({ item, isAllowedItem: isChatItem });
}
