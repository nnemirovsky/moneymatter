import { CHAT_MCP_SERVER, CHAT_TOKEN_ENV } from './cli-chat-bridge';
import {
  type CodexItem,
  CODEX_HARDENING_ARGS,
  guardCodexItem,
  isCodexAnswerItem,
  toTomlString,
} from './codex-language-model';

/** How long Codex waits for one bridge tool call. */
const TOOL_TIMEOUT_SEC = 60;

/**
 * The argv of a Codex chat run: the shared hardening list, unchanged, plus the model, the work dir,
 * the one MCP server (its URL, the environment variable that carries the token, a per-call timeout),
 * the system prompt and the images. The token is not here.
 */
export function buildCodexChatArgs({
  model,
  workdir,
  url,
  imagePaths,
  developerInstructions,
}: {
  model: string;
  workdir: string;
  url: string;
  imagePaths: string[];
  developerInstructions: string | undefined;
}): string[] {
  const server = `mcp_servers.${CHAT_MCP_SERVER}`;
  const args = [
    ...CODEX_HARDENING_ARGS,
    '-m',
    model,
    '-C',
    workdir,
    '-c',
    `${server}.url=${toTomlString({ value: url })}`,
    '-c',
    `${server}.bearer_token_env_var=${toTomlString({ value: CHAT_TOKEN_ENV })}`,
    '-c',
    `${server}.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`,
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
