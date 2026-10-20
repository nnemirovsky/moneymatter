import { CHAT_TOKEN_ENV } from './cli-chat-bridge';

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

/** Test-only variables the fake CLIs read; never forwarded outside `NODE_ENV=test`. */
const FAKE_CLI_ENV_VARS = ['MM_FAKE_CLI_SCENARIO', 'MM_FAKE_CLI_RESPONSE_FILE', 'MM_FAKE_CLI_STATE_DIR'] as const;

/** `USE_BUILTIN_RIPGREP` lets the Alpine image point Claude at its system ripgrep (the vendored one is glibc-only). */
const OPTIONAL_PASSTHROUGH_VARS = [
  'LANG',
  'TZ',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'USE_BUILTIN_RIPGREP',
] as const;

/**
 * The child environment is assembled from scratch instead of spread from `process.env`, so an
 * operator's `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` can't outrank the subscription credential and
 * app secrets (database, JWT) never reach the CLI process.
 */
function buildBaseEnv({ home }: { home: string }): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH || DEFAULT_PATH, HOME: home };

  for (const name of OPTIONAL_PASSTHROUGH_VARS) {
    const value = process.env[name];
    if (value) env[name] = value;
  }

  if (process.env.NODE_ENV === 'test') {
    for (const name of FAKE_CLI_ENV_VARS) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
  }

  return env;
}

/**
 * `home` doubles as `CLAUDE_CONFIG_DIR`: a private directory per invocation. `chatToken` is the bridge
 * token of a chat run, handed over only here (the run's MCP config names the variable, not the value).
 * Tool search stays off for a chat run, so every bridge tool is in the model's list from the first step.
 */
export function buildClaudeEnv({
  token,
  home,
  chatToken,
}: {
  token?: string;
  home: string;
  chatToken?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    ...buildBaseEnv({ home }),
    CLAUDE_CONFIG_DIR: home,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };

  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;

  if (chatToken) {
    env[CHAT_TOKEN_ENV] = chatToken;
    env.ENABLE_TOOL_SEARCH = 'false';
  }

  return env;
}

export function buildCodexEnv({
  codexHome,
  chatToken,
}: {
  codexHome: string;
  /** The bridge token of a chat run; `bearer_token_env_var` names the variable that carries it. */
  chatToken?: string;
}): Record<string, string> {
  return {
    ...buildBaseEnv({ home: codexHome }),
    CODEX_HOME: codexHome,
    RUST_LOG: 'error',
    ...(chatToken ? { [CHAT_TOKEN_ENV]: chatToken } : {}),
  };
}

/**
 * The app's global `ProcessEnv` type requires `NODE_ENV`, which a scrubbed child environment
 * deliberately doesn't carry; this is the one place that gap is bridged for `child_process`.
 */
export const toSpawnEnv = ({ env }: { env: Record<string, string> }) => env as unknown as NodeJS.ProcessEnv;
