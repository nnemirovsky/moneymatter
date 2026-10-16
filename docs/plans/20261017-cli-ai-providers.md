# Subscription AI providers: Claude Code and Codex

## Overview

Add two providers to Settings → AI → "Add AI model": **Claude Code (subscription)** and **Codex (ChatGPT subscription)**. Each lets the instance owner sign in from inside MoneyMatter ("Sign in with Claude" / "Sign in with ChatGPT" opens the real login page), pick a supported model, and then run every AI feature (categorization, statement parser including images and PDFs, investment transactions import, invoice matching, budget suggestions) on their own subscription instead of a per-token API key.

The backend never implements an OAuth client. It drives the unmodified CLIs:

- Claude: `claude setup-token` in a PTY → authorization URL → user pastes the code back → one-year OAuth token → stored encrypted → runs use `CLAUDE_CODE_OAUTH_TOKEN`.
- Codex: `codex login --device-auth` in a private `CODEX_HOME` → verification URL + one-time code → CLI finishes → `auth.json` stored encrypted → runs materialize it into a private `CODEX_HOME`.

Availability: self-hosted instances only (`IS_SELF_HOST=true`), instance admins only (`ADMIN_USERS`). Personal use only, per Anthropic's and OpenAI's subscription terms.

## Context (from discovery)

- Provider enum and connection types: `packages/shared/src/types/ai/settings.ts` (`AI_PROVIDER`, `AINativeProvider = Exclude<AI_PROVIDER, custom>`, `AI_NATIVE_PROVIDERS`, `AIConnectionInfo`, `AIFeatureStatus`, `CreateAIConnectionBody`, `TestAIConnectionBody`). `AI_FEATURE` has `categorization`, `statementParsing`, `investmentTransactionsParsing`, `receiptParsing` (invoice matching uses `receiptParsing`).
- Model factory: `packages/backend/src/services/ai/ai-client-factory.ts` (`ProviderModelSpec` union, `createProviderModel`, `createAIClient`). Resolver: `ai-model-resolver.ts` (`toProviderModelSpec`, `resolveAIConfiguration`); ladder: `resolution-ladder.ts`.
- Validation and model listing: `connection-validation.ts` (`validateConnection`, 15 s probe, `classifyAiCallFailure` verdicts), `list-connection-models.ts`.
- Failure handling: `ai-error-classifiers.ts` (`classifyAiCallFailure`; an `APICallError` without `statusCode` reads as `endpoint-down`), `connection-failure.ts` (`markConnectionRejected`, `markCustomEndpointUnreachable`, `markModelNotServed`), feature switches in `services/ai-categorization/categorization-service.ts` and `services/import-export/core/ai-extraction-failure.ts`. Per-call limits: `ai-call-guards.ts`.
- Public catalog: `model-catalog.ts` (models.dev, keys `provider/model`, `toCatalogKey`), display: `services/user-settings/resolve-feature-model-display.ts`.
- Connections service: `packages/backend/src/services/user-settings/ai-connections.ts` (create/update/test/list/delete, `encryptToken`/`decryptToken` from `@common/utils/encryption`, `keyEncrypted`, `mutateConnections`). Stored shape: `ZodAiConnectionSchema` in `packages/backend/src/models/user-settings.model.ts`. Controllers: `packages/backend/src/controllers/user-settings/ai-connections/*.ts`; routes: `packages/backend/src/routes/user.route.ts` (lines 117–123, `aiConnectionProbeRateLimit` from `middlewares/rate-limit.ts`).
- Gating: `config/is-self-host.ts` (`isSelfHost()`), `middlewares/admin-only.ts` (`adminOnly`, `isAdminUsername`), `middlewares/cloud-only.ts` (template for a `selfHostOnly`). `.env.test` sets `ADMIN_USERS=test1` (the e2e user); `tests/helpers/self-host.ts` has `useSelfHost()`, `tests/helpers/ai-test-env.ts` has `useSelfHostWithoutServerAiKeys()`.
- Multimodal call sites: `services/import-export/statement-parser/ai-extraction.service.ts` (image `file` part; PDFs arrive as text), `services/invoice-matching/extract-invoice.service.ts` (PDF `file` part; custom providers already get text or rendered page PNGs via `renderPdfPages`), `Output.object` in invoice matching, budget plans and landing FAQ.
- Backups: `services/backup/dump-tables.service.ts` strips `keyEncrypted` and marks connections invalid; restored CLI connections need a new sign-in (no change needed).
- Image: `self-hosting/backend/Dockerfile` (multi-stage, `node:24.21.0-alpine`, musl, user `nodejs` 1001, `WORKDIR /app/packages/backend`, only `data/attachments` is a volume). Dev image `docker/dev/backend/Dockerfile` (`node:24.21.0`, Debian). Test runner `docker/test/backend/Dockerfile` (Debian, build tools present).
- Frontend: `packages/frontend/src/pages/settings/subpages/ai/presets.ts` (+ `presets.spec.ts`), `components/ai-connection-dialog.vue`, `ai-connection-row.vue`, `ai-connections-manager.vue`, `shared/model-selector-card.vue` (price per 100 rows), `shared/model-fit.ts`, `shared/credential-status.vue`; API `src/api/ai-settings.ts`; queries `src/composable/data-queries/use-ai-connections.ts`, `use-ai-connection-models.ts`; keys `src/common/const/vue-query.ts`; `config.isSelfHost` in `src/common/config.ts`; `useIsAdmin()` in `src/composable/use-is-admin.ts`.
- Docs: `packages/docs/src/content/docs/ai/` (only `connect-claude-chatgpt-mcp.mdx` today; sidebar autogenerates), `self-hosting/docs/environment-reference.md` (calls `ADMIN_USERS` "mostly a legacy setting").
- Versions: `ai@6.0.300`, `@ai-sdk/provider@3.0.18` installed; local `claude` 2.1.301, `codex` 0.160.1.
- CLI facts (verified): `claude setup-token` "opens the same browser authorization flow as /login, and the token prints to the terminal"; in containers the browser shows a code to paste at `Paste code here if prompted`; token lifetime one year, model requests only; `--bare` ignores `CLAUDE_CODE_OAUTH_TOKEN`; `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` outrank the OAuth token. `claude -p` supports `--json-schema`, `--system-prompt`, `--tools`, `--setting-sources`, `--no-session-persistence`, `--input-format stream-json`. `codex login --device-auth` needs "device code login" enabled in ChatGPT security settings; `cli_auth_credentials_store=file` keeps `auth.json` under `CODEX_HOME`; Codex refreshes tokens during use and rewrites `auth.json`. `codex exec` supports `--json`, `-o`, `--output-schema`, `-i/--image`, `-s read-only`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`, `-C`.

## Development Approach

- Regular approach: code first, then tests, in the same task. Every task ships tests and ends with a gate naming the exact tests.
- Prefix every node/npm command with `export PATH="$(mise where node@24.21.0)/bin:$PATH"`.
- Backend unit: `cd packages/backend && npm run test:unit -- --testPathPattern='<regex>'`.
- Backend e2e (never parallel): `cd packages/backend && lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='<regex>'`.
- Frontend: `cd packages/frontend && npm run test:unit -- --run <path>`.
- Static checks: `npm run typecheck`, `npm run lint`, `npm run format:check` at the root.
- Repo rules apply: object params, kebab-case files, functions not classes, i18n keys for thrown errors, `en` + `uk` together via the `i18n-editor` subagent, no commits or pushes, comments describe current code.

## Testing Strategy

- Fake CLIs: `packages/backend/src/tests/fixtures/ai-cli/fake-claude.mjs` and `fake-codex.mjs` (executable node scripts) mimic `setup-token`, `login --device-auth`, `claude -p … stream-json` and `codex exec --json`. The backend finds CLIs via `AI_CLI_CLAUDE_PATH` / `AI_CLI_CODEX_PATH` (default `claude` / `codex` on `PATH`). A scenario is chosen by the input (a pasted code of `bad-code`, a model named `fake-rate-limit`) or by `MM_FAKE_CLI_SCENARIO`, which the env builder passes to children only when `NODE_ENV=test`.
- Unit (jest): PTY/login orchestration against the fake binaries; provider adapters with mocked `child_process.spawn`; env builder, limiter, codex-home round trip, error mapping, catalog keys.
- E2E (HTTP helpers only, colocated with services): every new endpoint gets happy path, empty state and error cases; connection create/test/delete for both providers; one feature run end to end on a CLI connection.
- Frontend vitest: presets gating, the sign-in state machine composable, billing label formatting.
- Manual: real sign-in on ritchie (Post-Completion).

## Progress Tracking

- Tick `- [ ]` items as they land; add `➕` items for discovered work and `⚠️` for blockers, in place.
- After each gate passes, note the test command result under the task.

## Solution Overview

1. **Thin in-repo providers.** `services/ai/cli/claude-code-language-model.ts` and `codex-language-model.ts` implement `LanguageModelV3` (`doGenerate`; `doStream` wraps `doGenerate` as one text chunk) by spawning the pinned CLI once per call with a scrubbed environment and an empty temp working directory. Failures become `APICallError`s carrying synthetic HTTP statuses (401 auth, 404 model, 429 subscription limit, 503 overloaded), so the existing classifiers and feature switches keep working.
2. **Login orchestration.** `services/ai/cli/login/` runs the CLI login in a `node-pty` PTY, parses the URL/code, and keeps an in-memory session (owner, provider, state, encrypted credential) with a 15-minute TTL.
3. **Storage.** The credential (Claude token or Codex `auth.json`) is encrypted with the existing `encryptToken` into the connection's `keyEncrypted`. Codex runs write `auth.json` into a fresh private `CODEX_HOME` (dir 0700, file 0600), and if Codex refreshed it, the new content is re-encrypted and saved before the directory is removed.
4. **Gating.** `selfHostOnly` + `adminOnly` on the new endpoints; `assertCliAiAllowed({ userId })` on create/update/test of CLI connections and on every run in the resolver.
5. **UI.** Two presets in the Add dialog; in place of API key/base URL fields they show a sign-in panel, a curated model list and a personal-use notice. The connection row shows the credential state, a "Sign in again" action and Disconnect.

## Technical Details

**Shared types** (`packages/shared/src/types/ai/settings.ts`):

- `AI_PROVIDER.claudeCode = 'claude-code'`, `AI_PROVIDER.codex = 'codex'`; `AICliProvider`; `AI_CLI_PROVIDERS`; `AINativeProvider = Exclude<AI_PROVIDER, custom | AICliProvider>` (keeps `NATIVE_PROVIDER_BASE_URLS` and models.dev lookups unchanged).
- `CLI_AI_MODELS: Record<AICliProvider, { id: string; catalogId: string; isDefault?: boolean }[]>`: Claude `sonnet` (default), `opus`, `haiku`, `fable`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`; Codex `gpt-6-astra` (default), `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.3-codex`. Aliases map to a `catalogId` for the capability lookup.
- `AIConnectionInfo.credentialExpiresAt?: string`; `AIFeatureStatus.billing: 'per-token' | 'subscription'`.
- `CreateAIConnectionBody.cliAuthSessionId?`, `UpdateAIConnectionBody.cliAuthSessionId?`, the provider arm of `TestAIConnectionBody` gains `cliAuthSessionId?`.
- `CliAuthSessionInfo { id; provider; status: 'starting' | 'awaiting-user' | 'verifying' | 'succeeded' | 'failed' | 'expired'; authUrl?; userCode?; expiresAt; error? }`, `CliAiAvailability { available; reason?: 'not-self-host' | 'not-admin' | 'admin-not-configured'; providers: { provider; installed; version: string | null }[] }`.

**Stored connection**: `ZodAiConnectionSchema` gains `credentialExpiresAt: z.string().datetime().optional()`. No DB migration (settings JSON).

**Endpoints** (all `selfHostOnly, adminOnly`, under `/user/settings/ai/cli`):
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/availability` | – | `CliAiAvailability` (route is not admin-gated: answers `available:false` with a reason) |
| POST | `/auth-sessions` | `{ provider }` | `CliAuthSessionInfo` once the URL is parsed (≤30 s) |
| GET | `/auth-sessions/:id` | – | `CliAuthSessionInfo` (frontend polls every 2 s) |
| POST | `/auth-sessions/:id/code` | `{ code }` (Claude only, 1–500 chars, printable, no control chars) | `CliAuthSessionInfo` |
| DELETE | `/auth-sessions/:id` | – | 204, kills the PTY |

Create/re-auth reuse the existing `POST /settings/ai/connections` and `PUT /settings/ai/connections/:id` with `cliAuthSessionId` (consumed once; session must be `succeeded`, owned by the caller, same provider). One live session per user per provider (a new start cancels the old one); at most 3 PTYs instance-wide.

**Claude login (PTY)**: `node-pty` spawn of `<claude> setup-token`, `cols: 1000` so nothing wraps, env from the builder with `HOME`/`CLAUDE_CONFIG_DIR` = fresh temp dir and `BROWSER=/bin/true`. Strip ANSI, match the first `https://\S*oauth\S*` URL → `awaiting-user`. On code submit, write `code + '\r'`, state `verifying`, then match `sk-ant-oat\w*-[A-Za-z0-9_-]{20,}` within 60 s → encrypt, `succeeded`, kill PTY, remove temp dir. Any other exit → `failed` with the last 5 screen lines (token pattern redacted). Raw PTY output is never logged.

**Codex login (PTY)**: `<codex> login --device-auth -c cli_auth_credentials_store="file"` with `CODEX_HOME` = fresh 0700 temp dir. Match the first `https://` URL and a code `[A-Z0-9]{4,}-[A-Z0-9]{4,}` → `awaiting-user` with both. Wait for exit (≤15 min): exit 0 and `auth.json` present → read, encrypt, `succeeded`; remove the dir.

**Claude runtime**: `<claude> -p --input-format stream-json --output-format stream-json --verbose --model <m> --system-prompt <system> --tools "" --setting-sources "" --strict-mcp-config --no-session-persistence --max-turns 3 [--json-schema <schema>]`, cwd = empty temp dir, stdin = one `{"type":"user","message":{role,content}}` line with text and base64 `image` blocks. Read the final `{"type":"result"}` event: `structured_output` (JSON-stringified as the text) or `result`, `usage` → `inputTokens/outputTokens`, `is_error` / `api_error_status` → mapped error. Strip `format` keywords from the schema before sending (the AI SDK still validates against the Zod schema).

**Codex runtime**: `<codex> exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -s read-only -c approval_policy="never" -c cli_auth_credentials_store="file" -m <m> -C <tmp> -o <tmp>/last.txt [--output-schema <tmp>/schema.json] [-i <tmp>/img-N.<ext>…] -`, stdin = system prompt + user text (Codex has no system-prompt flag; verify `developer_instructions` in the pinned version and prefer it if present). Text = `last.txt`; usage from `turn.completed`; `error`/`turn.failed` events → mapped error. Schema gets `additionalProperties: false` on every object.

**Environment builder** (`cli-env.ts`): the child env is built from scratch, never spread from `process.env`: `PATH`, `LANG`, `TZ`, `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS` if set, `HOME`, then provider vars (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`; or `CODEX_HOME`, `RUST_LOG=error`). `ANTHROPIC_*`, `OPENAI_*`, DB and app secrets therefore never reach a CLI, so billing can't silently fall back to the operator's API key.

**Limits**: `cli-run-limiter.ts` runs one CLI call per connection at a time and at most `AI_CLI_MAX_CONCURRENT_RUNS` (default 2) instance-wide; waiting honors the call's `abortSignal`. `aiCallGuards` CLI arm: 5-minute signal, `maxRetries: 0`. Validation probe for CLI providers: 90 s. Abort kills the child process group (SIGTERM, SIGKILL after 5 s).

**Error mapping** (`cli-errors.ts`): auth (`401`): "not logged in", "invalid_grant", "OAuth token has expired", `authentication_failed`, exit after a 401; limit (`429`): "usage limit", "rate limit", `usage_limit_reached`, "Claude AI usage limit reached|<epoch>" (reset time parsed into the message); model (`404`, JSON body `model_not_found`): "model … not supported/not found"; spawn `ENOENT` → no status (`endpoint-down`), worded as "CLI not installed in the backend image". `connection-failure.ts` gains subscription copy: `markConnectionRejected` says "Sign in again in Settings → AI" for CLI providers, `describeRateLimited({ aiClient, cause })` names the subscription limit and its reset time, and the `endpoint-down` handling marks a CLI connection invalid with the missing-CLI message.

**Display**: `toCatalogKey` maps `claude-code/<id>` → `anthropic/<catalogId>` and `codex/<id>` → `openai/<catalogId>`; `getModelProfile` forces `pricing: null` for CLI providers; `resolveFeatureStatus` sets `billing: 'subscription'`. Capabilities keep `pdf` because the backend turns PDFs into text or page images for these providers.

## Decisions taken without the owner

1. **Thin in-repo providers instead of the community packages.** Evaluated `ai-sdk-provider-claude-code@3.6.1` and `ai-sdk-provider-codex-cli@1.5.0`, the `ai-sdk-v6` dist-tags; `latest` (4.3.3 / 2.3.0) target `@ai-sdk/provider` v4 = AI SDK v7. Both handle images and structured output, but: the Claude package runs through `@anthropic-ai/claude-agent-sdk@0.3.283`, which bundles a 225 MB native Claude Code 2.1.283 binary (a second copy beside the CLI the image needs for `setup-token`) and talks a stdio control protocol that can't be faked at the process boundary for e2e; it silently drops PDF file parts; its env allowlist forwards every `ANTHROPIC_*` var (an operator `ANTHROPIC_API_KEY` would outrank the OAuth token and bill the API). The Codex package spreads the whole `process.env` (DB credentials, `APPLICATION_JWT_SECRET`) into the child. A ~300-line in-repo adapter per CLI gives full control of env, flags and error mapping, and is testable with fake binaries.
2. **CLI versions**: `@anthropic-ai/claude-code@2.1.292` (current `stable` dist-tag) and `@openai/codex@0.160.1` (the version on the owner's Mac, above the 0.156 floor the community provider documents for current GPT models). Installed globally with `npm install -g` in the production image, not as backend dependencies; `node-pty@1.1.0` is the only new runtime dependency.
3. **PTY for both logins** (`node-pty`): `setup-token` is an Ink TUI that needs a TTY; Codex uses the same runner for uniformity.
4. **Codex credential at rest = encrypted in the DB**, not a volume: `auth.json` is encrypted into `keyEncrypted` like API keys, written to a private temp `CODEX_HOME` only for the length of one run, written back re-encrypted when Codex refreshes it, then deleted. This gives encryption at rest, needs no new compose volume, and is safe because runs per connection are serialized.
5. **Gate** = `isSelfHost() && isAdminUsername(username)`, checked at the endpoints, at create/update/test, and on every run. Self-hosters must set `ADMIN_USERS`; docs and the UI say so. A user removed from `ADMIN_USERS` keeps the connection, but runs refuse with a clear message.
6. **Login sessions live in memory** (single backend process on self-host); a restart drops in-flight sign-ins and the user starts again.
7. **Static curated model list** in shared types plus free-text entry; the create/test probe confirms the model. Neither CLI has a reliable unauthenticated model list (`codex app-server` model listing needs auth and another process).
8. **Cost display**: new `AIFeatureStatus.billing`; the UI shows "Included in your subscription" in place of a per-100-rows price. Usage tokens are still tracked.
9. **Concurrency**: 1 run per connection, 2 per instance (each CLI process takes ~200–400 MB RSS); timeouts 5 min per run, 90 s for the validation probe, no SDK retries.
10. **Subscription errors** surface through the existing classifiers via synthetic HTTP statuses, so no feature switch gains a new case; only the copy differs.
11. **PDFs** to CLI providers go as extracted text or rendered page images (the existing custom-provider branch in `extract-invoice.service.ts`, generalized to "provider can't take PDF file parts").
12. **Hardening**: no tools, no settings/MCP/plugins, no session persistence, empty temp cwd, scrubbed env; Codex runs read-only, ephemeral, ignoring user config and rules.
13. **Disconnect** = delete the connection. Codex: best-effort `codex logout` against a materialized home first, to revoke the tokens. Claude has no CLI revoke, so the confirm dialog links to claude.ai settings for revoking the token.
14. **Claude token expiry**: `credentialExpiresAt = now + 365 days` at sign-in (docs: one-year token). The row shows it and turns into a warning 14 days before.
15. **Restored backups**: CLI connections come back invalid with no key (existing behavior), so the owner signs in again; no special-casing.
16. **Test seam**: CLI paths via `AI_CLI_CLAUDE_PATH`/`AI_CLI_CODEX_PATH`; `MM_FAKE_CLI_SCENARIO` is forwarded to children only under `NODE_ENV=test`.
17. **Popup blockers**: the click handler opens a blank tab synchronously and points it at the URL once the backend returns it; a visible "Open sign-in page" link is always shown as a fallback.
18. **Visibility**: non-admins and cloud never see the two presets; an admin on self-host whose image lacks a CLI sees the preset disabled with the reason.
19. **UI/docs copy**: "For your own personal use with your own subscription, under Anthropic's / OpenAI's terms"; the Codex panel tells the user to turn on device code login in ChatGPT → Settings → Security first.

## What Goes Where

- **Shared** (`packages/shared/src/types/ai/settings.ts`): enum, model list, session/availability types, request fields.
- **Backend** `packages/backend/src/services/ai/cli/`: `cli-binaries.ts`, `cli-env.ts`, `cli-run-limiter.ts`, `cli-workdir.ts`, `codex-home.ts`, `cli-errors.ts`, `claude-code-language-model.ts`, `codex-language-model.ts`, `cli-access.ts`, `login/pty-session.ts`, `login/claude-setup-token-flow.ts`, `login/codex-device-auth-flow.ts`, `login/cli-auth-sessions.ts`. Endpoints: `controllers/user-settings/ai-cli/*.ts`, `services/user-settings/ai-cli-auth.ts`, routes in `routes/user.route.ts`, `middlewares/self-host-only.ts`.
- **Tests**: `src/tests/fixtures/ai-cli/fake-{claude,codex}.mjs`, `src/tests/helpers/ai-cli.ts`, unit files beside sources, e2e beside services.
- **Frontend** `packages/frontend/src/pages/settings/subpages/ai/`: presets, dialog, new `components/cli-sign-in-panel.vue`, `composables/use-cli-sign-in.ts`, row, model card; `src/api/ai-settings.ts`; `src/common/const/vue-query.ts`.
- **Image/docs**: `self-hosting/backend/Dockerfile`, `docker/dev/backend/Dockerfile`, `self-hosting/docs/environment-reference.md`, `packages/docs/src/content/docs/ai/use-your-ai-subscription.mdx`.

## Implementation Steps

### Task 1: Install the CLIs and PTY dependency

**Files:** `self-hosting/backend/Dockerfile`, `docker/dev/backend/Dockerfile`, `packages/backend/package.json`, `package-lock.json`, `packages/backend/src/services/ai/cli/pty-smoke.unit.ts`

- [ ] Add `node-pty@1.1.0` (exact) to backend dependencies; `npm install` from the root.
- [ ] Production stage: `apk add --no-cache libgcc libstdc++ ripgrep` (Claude Code's documented Alpine needs) before `npm ci`, so `node-pty` compiles while `python3 make g++` are still present; then `npm install -g @anthropic-ai/claude-code@2.1.292 @openai/codex@0.160.1 && npm cache clean --force`; `ENV USE_BUILTIN_RIPGREP=0`. Pass version `ARG`s so bumps are one-line.
- [ ] Confirm npm picked the `linux-*-musl` Claude binary on Alpine; if not, install `@anthropic-ai/claude-code-linux-x64-musl`/`-arm64-musl` at the same version for the build platform (`TARGETARCH`).
- [ ] Add `RUN claude --version && codex --version` as a build-time check; record the image size delta in this plan.
- [ ] Dev image: the same global install (Debian, glibc).
- [ ] Write `pty-smoke.unit.ts`: spawn `node -e "process.stdout.write('ok')"` through `node-pty` and read `ok`.
- [ ] Gate: `npm run test:unit -- --testPathPattern='pty-smoke'`; `docker build -f self-hosting/backend/Dockerfile .` for the build platform succeeds and `docker run --rm --entrypoint sh <img> -c 'claude --version; codex --version; node -e "require(\"node-pty\")"'` prints both versions.

### Task 2: Shared types, provider enum and access gate

**Files:** `packages/shared/src/types/ai/settings.ts`, `packages/backend/src/models/user-settings.model.ts`, `packages/backend/src/services/ai/cli/cli-access.ts`, `packages/backend/src/middlewares/self-host-only.ts`, every exhaustive switch `tsc` flags (`ai-client-factory.ts`, `list-connection-models.ts`, `connection-validation.ts`, frontend `presets.ts`), `cli-access.unit.ts`, `settings.ts` type tests

- [ ] Add the enum values, `AICliProvider`, `AI_CLI_PROVIDERS`, narrowed `AINativeProvider`, `CLI_AI_MODELS`, `CliAuthSessionInfo`, `CliAiAvailability`, the `cliAuthSessionId` request fields, `credentialExpiresAt`, `billing`.
- [ ] Add a `credentialExpiresAt` optional field to `ZodAiConnectionSchema`.
- [ ] Write `cli-access.ts`: `getCliAiAccess({ userId })` → `{ allowed, reason }` (loads the username, uses `isSelfHost()` + `isAdminUsername`), `assertCliAiAllowed({ userId })` throwing `NotAllowedError` with i18n key `ai.cliProvidersNotAllowed`.
- [ ] Write `selfHostOnly` middleware (404 off self-host, mirror of `cloudOnly`).
- [ ] Temporary `throw new Error('not wired')` arms where `tsc` demands, replaced in Tasks 4 and 7.
- [ ] Unit tests: `cli-access.unit.ts` (cloud → `not-self-host`, self-host non-admin → `not-admin`, empty `ADMIN_USERS` → `admin-not-configured`, admin → allowed); an `Expect<Equals<…>>` assertion that `AINativeProvider` excludes the CLI providers.
- [ ] Gate: `npm run typecheck`; `npm run test:unit -- --testPathPattern='cli-access'`.

### Task 3: CLI runtime foundation

**Files:** `services/ai/cli/{cli-binaries,cli-env,cli-run-limiter,cli-workdir,codex-home}.ts` and `.unit.ts` siblings

- [ ] `cli-binaries.ts`: resolve paths from `AI_CLI_CLAUDE_PATH`/`AI_CLI_CODEX_PATH`; `getCliVersion({ provider })` runs `--version` once, caches it for 10 min, null on ENOENT.
- [ ] `cli-env.ts`: `buildClaudeEnv({ token?, home })`, `buildCodexEnv({ codexHome })` per Technical Details; `MM_FAKE_CLI_SCENARIO` passthrough only when `NODE_ENV === 'test'`.
- [ ] `cli-workdir.ts`: `withTempDir({ prefix, run })` makes a 0700 dir under `os.tmpdir()`, always removes it.
- [ ] `cli-run-limiter.ts`: `runWithCliSlot({ connectionKey, abortSignal, run })`, per-key FIFO mutex plus global cap from `AI_CLI_MAX_CONCURRENT_RUNS`; an aborted waiter leaves the queue.
- [ ] `codex-home.ts`: `withCodexHome({ authJson, onRefreshed, run })` writes `auth.json` 0600 and `config.toml` (`cli_auth_credentials_store = "file"`), runs, compares a sha256 of `auth.json` before/after, and calls `onRefreshed({ authJson })` when it changed.
- [ ] Unit tests: env never contains `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`APPLICATION_JWT_SECRET` set in `process.env`; limiter serializes per key, caps globally, honors abort; codex-home sets the file modes, detects a rewrite and cleans up after a throwing `run`; workdir is removed on error.
- [ ] Gate: `npm run test:unit -- --testPathPattern='services/ai/cli/(cli-env|cli-run-limiter|cli-workdir|codex-home|cli-binaries)'`.

### Task 4: Claude Code and Codex language models

**Files:** `services/ai/cli/{claude-code-language-model,codex-language-model,cli-errors,cli-process}.ts`, `.unit.ts` siblings, `src/tests/fixtures/ai-cli/{fake-claude,fake-codex}.mjs`, `services/ai/ai-client-factory.ts`

- [ ] `cli-process.ts`: spawn with `detached: true`, stdin write, line-buffered stdout, bounded stderr tail (8 KB), abort → kill the process group.
- [ ] `cli-errors.ts`: map exit/stream errors to `APICallError` (url `cli://claude-code` / `cli://codex`, synthetic `statusCode`, JSON `responseBody`), per Technical Details.
- [ ] Claude model: build the args and the stream-json user message (text + base64 image parts; non-image file parts are rejected with a clear `UnsupportedFunctionalityError`), strip schema `format`s, parse the `result` event, map usage and `finishReason` (`error_max_turns` → `other`).
- [ ] Codex model: temp files for the schema/images/last message, parse the JSONL events, map usage; a `usage_limit_exceeded` / `usage_limit_reached` signal becomes a 429 error, never `finishReason: 'length'` (which would read as a truncated answer).
- [ ] Both run inside `runWithCliSlot` keyed by connection id; Codex also inside `withCodexHome`.
- [ ] Extend `ProviderModelSpec` with `{ provider: AICliProvider; model; credential; connectionKey; onCredentialRefreshed? }` and the `createProviderModel` arm.
- [ ] Fake CLIs: `-p` mode echoes a deterministic answer (or `structured_output` built from the `--json-schema` required keys), emits usage, and fails per scenario (auth, limit, model-not-found, hang); `exec --json` mirrors this and can rewrite `auth.json` to simulate a refresh.
- [ ] Unit tests (mocked `spawn` for args/env assertions, fake binaries for parsing): args contain `--tools ""`, `--no-session-persistence`, never `--bare`; image parts arrive as base64; structured output round-trips through `generateText({ output: Output.object })`; each error scenario yields the expected `classifyAiCallFailure` kind (`auth`, `rate-limited`, `model-not-found`, `endpoint-down` on ENOENT); abort kills the child; the Codex refresh triggers `onCredentialRefreshed`.
- [ ] Gate: `npm run test:unit -- --testPathPattern='services/ai/cli/(claude-code-language-model|codex-language-model|cli-errors|cli-process)|ai-client-factory'`.

### Task 5: PTY login flows and the session registry

**Files:** `services/ai/cli/login/{pty-session,claude-setup-token-flow,codex-device-auth-flow,cli-auth-sessions}.ts`, `.unit.ts` siblings, fake CLIs (login modes)

- [ ] `pty-session.ts`: `node-pty` spawn, ANSI-stripped rolling buffer, `waitFor({ pattern, timeoutMs })`, `write`, `kill`, `exited` promise; redacts the token pattern from any captured text.
- [ ] Claude flow per Technical Details; the code is sanitized (printable ASCII, trimmed) before writing.
- [ ] Codex flow per Technical Details; reads `auth.json`, then removes the temp home.
- [ ] `cli-auth-sessions.ts`: `startSession`, `getSession`, `submitCode`, `cancelSession`, `consumeCredential({ userId, sessionId, provider })` (one-shot), `replaceSessionCredential` for refresh during a pre-save probe; TTL sweep timer (`unref`), limits from Technical Details.
- [ ] Fake CLIs: `setup-token` prints a banner, an authorize URL and `Paste code here if prompted >`, then the token on a valid code, an error on `bad-code`; `login --device-auth` prints the URL and code, then writes `auth.json` and exits 0 (or exits 1 under the `denied` scenario).
- [ ] Unit tests: happy paths for both flows; bad code → `failed` with a redacted message; no URL within the timeout → `failed`; cancel kills the PTY; TTL expiry; a second start for the same user/provider cancels the first; a foreign user can't read or consume; consume twice fails.
- [ ] Gate: `npm run test:unit -- --testPathPattern='services/ai/cli/login/'`.

### Task 6: Sign-in and availability endpoints

**Files:** `controllers/user-settings/ai-cli/{get-availability,start-auth-session,get-auth-session,submit-auth-code,cancel-auth-session,index}.ts`, `services/user-settings/ai-cli-auth.ts`, `routes/user.route.ts`, `src/tests/helpers/ai-cli.ts`, `src/tests/helpers/index.ts`, `services/user-settings/ai-cli-auth.e2e.ts`, backend i18n `en`/`uk`

- [ ] Routes per the endpoint table; start and code submit behind `aiConnectionProbeRateLimit`; Zod schemas (`provider` in `AI_CLI_PROVIDERS`, `code` length/charset).
- [ ] Service maps the registry to `CliAuthSessionInfo` (never the credential) and computes availability (access + installed versions).
- [ ] Test helpers: `getCliAvailability`, `startCliAuthSession`, `getCliAuthSession`, `submitCliAuthCode`, `cancelCliAuthSession`, `waitForCliAuthSession({ id, status })`, `useFakeAiClis()` (sets the path env vars to the fixtures).
- [ ] E2E: availability on cloud (`available:false`, `not-self-host`), self-host admin (`available:true`, both installed), CLIs missing (paths to a nonexistent file → `installed:false`); Claude happy path (start → URL → code → `succeeded`); Codex happy path (start → URL + code → `succeeded`); empty state (`GET` an unknown session id → 404); errors: bad code → `failed`, non-admin → 401, cloud → 404, code on a Codex session → 422, cancel then get → 404.
- [ ] Gate: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='user-settings/ai-cli-auth.e2e'`.

### Task 7: Wire CLI providers into connections, resolution and display

**Files:** `services/user-settings/ai-connections.ts`, `services/ai/{connection-validation,list-connection-models,ai-model-resolver,model-catalog,ai-call-guards}.ts`, `services/user-settings/resolve-feature-model-display.ts`, controllers `create-connection.ts`/`update-connection.ts`/`test-connection.ts`, `services/user-settings/ai-connections-cli.e2e.ts`, unit siblings

- [ ] Create: CLI provider requires `cliAuthSessionId` (refuses `apiKey`/`baseUrl`/`keyFromConnectionId`), calls `assertCliAiAllowed`, probes with the session credential, stores `keyEncrypted` and `credentialExpiresAt` (Claude).
- [ ] Update: `cliAuthSessionId` replaces the credential (re-auth) after a probe and resets the status to valid; a model change re-probes with the stored credential.
- [ ] Test: provider arm accepts `cliAuthSessionId`; `connectionId` arm uses the stored credential and records the verdict as today.
- [ ] `listAvailableModels` returns `CLI_AI_MODELS` ids for CLI providers without any network call.
- [ ] Validation: CLI arm with the 90 s timeout and the existing verdict mapping (`rate-limited` still counts as valid).
- [ ] Resolver `toProviderModelSpec`: CLI arm (decrypt, `connectionKey = connection.id`, Codex `onCredentialRefreshed` → new `replaceConnectionCredential({ userId, connectionId, keyEncrypted })` through `mutateConnections`); `assertCliAiAllowed` failure → mark invalid with `ai.cliProvidersNotAllowed` copy and skip.
- [ ] Delete: Codex best-effort `codex logout` under `withCodexHome` (5 s timeout, errors only logged).
- [ ] `aiCallGuards` CLI arm; `model-catalog.ts` key mapping and `pricing: null`; `resolveFeatureStatus` `billing`.
- [ ] Unit tests: `toCatalogKey` for both providers and aliases; `aiCallGuards` CLI arm; `resolveFeatureStatus` billing; resolver CLI arm (gated user excluded).
- [ ] E2E `ai-connections-cli.e2e.ts`: create Claude and Codex connections from succeeded sessions (happy path, info has no key material and has `credentialExpiresAt` for Claude); list models returns the curated ids; empty state (GET connections before any create → `[]`); errors: missing/unknown/consumed/foreign session id → 422, `apiKey` with a CLI provider → 422, probe hitting `fake-rate-limit` model still saves, probe on an `auth` scenario → 422; re-auth via PUT; Codex refresh during a run updates the stored ciphertext (read via `readStoredConnections`); delete removes the connection; non-admin create → the `NotAllowedError` status (`ERROR_CODES.NotAllowed`).
- [ ] Gate: `npm run test:unit -- --testPathPattern='model-catalog|ai-call-guards|resolve-feature-model-display|ai-model-resolver'`; `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='user-settings/(ai-connections-cli|ai-connections|ai-connection-models|ai-connection-resolution|ai-feature-settings).e2e'`.

### Task 8: Feature integration and subscription error copy

**Files:** `services/invoice-matching/extract-invoice.service.ts`, `services/ai/connection-failure.ts`, `services/ai-categorization/categorization-service.ts`, `services/import-export/core/ai-extraction-failure.ts`, unit/e2e siblings (`connection-failure.unit.ts`, `services/ai/cli-feature-runs.e2e.ts` or beside the feature services)

- [ ] Invoice PDFs: replace the `provider === custom` check with `providerTakesPdfFileParts({ provider })` (false for custom and CLI providers).
- [ ] `connection-failure.ts`: CLI copy for `markConnectionRejected`; `describeRateLimited({ aiClient, cause })` with the reset time; `markCustomEndpointUnreachable` generalized (rename to `markEndpointUnreachable`) so a missing CLI flags the connection with the "not installed" copy.
- [ ] Use `describeRateLimited` in both feature switches.
- [ ] Unit tests: copy per provider; reset time formatting; the PDF predicate.
- [ ] E2E (through endpoints, fake CLIs): categorization trigger on a Claude connection categorizes; statement parser image import on a Codex connection extracts rows; invoice extraction of a fixture PDF on a Claude connection succeeds; a `fake-rate-limit` connection returns the subscription-limit message and stays valid; an `auth` scenario marks the connection invalid with the sign-in-again copy.
- [ ] Gate: `npm run test:unit -- --testPathPattern='connection-failure|extract-invoice'`; `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(cli-feature-runs|invoice-matching/.*|ai-categorization/trigger-categorization|statement-parser/.*).e2e'`.

### Task 9: Frontend data layer and presets

**Files:** `packages/frontend/src/api/ai-settings.ts`, `src/common/const/vue-query.ts`, `src/composable/data-queries/use-cli-ai-availability.ts`, `src/pages/settings/subpages/ai/presets.ts`, `presets.spec.ts`, `src/pages/settings/subpages/ai/composables/use-cli-sign-in.ts` + `.spec.ts`

- [ ] API functions for the five endpoints; `cliAuthSessionId` on create/update/test bodies.
- [ ] Cache key `aiCliAvailability`; query hook enabled only when `config.isSelfHost && isAdmin`.
- [ ] Presets `claudeCode` and `codex` with `authKind: 'subscription'`, `signInLabelKey`, `keyRequired: false`; `getVisiblePresets({ availability })` hides them unless available and marks them disabled when the CLI is missing.
- [ ] `use-cli-sign-in.ts`: state machine (`idle → starting → awaiting-user → verifying → succeeded | failed | expired`), 2 s polling while awaiting/verifying, stops on unmount, the pre-opened tab handling, `submitCode`, `cancel`, `reset`.
- [ ] Vitest: preset visibility matrix (cloud, self-host non-admin, admin available, admin with a missing CLI); `findPresetForConnection` for the new providers; the composable transitions, poll stop on terminal states and unmount, cancel on reset.
- [ ] Gate: `npm run test:unit -- --run src/pages/settings/subpages/ai/presets.spec.ts src/pages/settings/subpages/ai/composables/use-cli-sign-in.spec.ts`.

### Task 10: Frontend sign-in UI, connection status and model card

**Files:** `components/ai-connection-dialog.vue`, new `components/cli-sign-in-panel.vue`, `components/ai-connection-row.vue`, `components/shared/model-selector-card.vue`, `components/shared/credential-status.vue`, `components/shared/feature-model-options.ts` (+ spec), frontend i18n chunks `en`/`uk` (via `i18n-editor`)

- [ ] Dialog: for subscription presets hide base URL and API key; render `cli-sign-in-panel` (Claude: button → tab → code `InputField` with placeholder → submit; Codex: button → large copyable user code + "Open sign-in page" link + the device-code settings hint; both: status line, retry, cancel); the model field gets `CLI_AI_MODELS` suggestions with the default prefilled; Save/Test send `cliAuthSessionId`; Save is disabled until `succeeded`; personal-use `Callout`.
- [ ] Edit mode of a CLI connection: name/model editable, "Sign in again" runs the panel and saves with `cliAuthSessionId`.
- [ ] Row: subscription badge, `credentialExpiresAt` (warning within 14 days), invalid status with "Sign in again"; the delete confirm (`ResponsiveAlertDialog`, `destructive`) adds the Claude revoke hint.
- [ ] Model card: `billing === 'subscription'` shows "Included in your subscription" in place of the price; the key-source badge reads "Subscription".
- [ ] Container queries for layout, `Button` variants and color tokens per `frontend-rules`; no raw `<button>`.
- [ ] Vitest: billing label formatting in `feature-model-options.spec.ts` (or a new pure helper with its own spec); `npm run lint` passes the i18n key check.
- [ ] Gate: `npm run test:unit -- --run src/pages/settings/subpages/ai/`; `npm run typecheck`; `npm run lint`.

### Task 11: Verify acceptance criteria

- [ ] Both presets appear only for an admin on self-host; cloud and non-admin users never see them (manual in the dev app + availability e2e).
- [ ] Sign-in flows work end to end against the fake CLIs in the dev app (`AI_CLI_*_PATH` pointed at the fixtures); the UI opens the URL in a new tab and shows the code entry / device code.
- [ ] All AI features run on a CLI connection (Task 8 e2e), PDFs and images included.
- [ ] Subscription limit and expired-token errors show the right copy; a missing CLI disables the preset.
- [ ] No key material in any response, log line or PTY failure message (grep the test logs for `sk-ant-oat` and `refresh_token`).
- [ ] The production image builds for amd64 and arm64 (`docker buildx build --platform linux/amd64,linux/arm64 -f self-hosting/backend/Dockerfile .`), and the size delta is recorded.
- [ ] Gate: full `npm run test:unit` (backend), `npm run test:unit -- --run` (frontend), `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ai-cli|ai-connection|ai-feature|cli-feature-runs|invoice-matching|ai-categorization|statement-parser)'`, root `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run knip`.

### Task 12: Update documentation

**Files:** `packages/docs/src/content/docs/ai/use-your-ai-subscription.mdx`, `packages/docs/src/content/docs/settings/general-settings.mdx` (AI map line), `packages/docs/src/content/docs/getting-started/self-hosting.mdx`, `self-hosting/docs/environment-reference.md`, `self-hosting/README.md` if it lists AI options

- [ ] New docs page (follow the `user-docs` skill; screenshots of the dialog and sign-in panel using the throwaway docs user with mocked availability): what it is, self-host + admin requirement, setting `ADMIN_USERS`, Claude flow (code paste), Codex flow (device code; enable it in ChatGPT security settings), choosing models, subscription limits, re-sign-in and yearly Claude expiry, disconnect/revoke, the personal-use terms notice.
- [ ] Environment reference: rewrite `ADMIN_USERS` (now gates subscription AI); add `AI_CLI_CLAUDE_PATH`, `AI_CLI_CODEX_PATH`, `AI_CLI_MAX_CONCURRENT_RUNS`; note the image size increase.
- [ ] Gate: `cd packages/docs && npm run build` succeeds; links in the new page resolve.

## Post-Completion

- **Owner sign-in on ritchie**: build the image there (or pull the branch build), set `ADMIN_USERS=<your username>`, restart the backend, open Settings → AI → Add AI model → "Claude Code (subscription)", sign in, paste the code, save with `sonnet`; repeat for "Codex (ChatGPT subscription)" after turning on device code login in ChatGPT security settings.
- **Record the real CLI transcripts**: if a login fails, the session error shows the last screen lines; compare them with the fake CLIs' output and adjust the URL/code/token patterns (the only parts of the flow inferred from docs rather than observed).
- **Manual feature checks** on real subscriptions: categorize a small batch, import one image statement, one PDF invoice, one investment import; confirm the usage shows on claude.ai / ChatGPT usage pages and that no API-key billing occurs.
- **Watch** the first subscription-limit hit and the first Codex token refresh (stored ciphertext changes, next run still works).
- **Version bumps**: bump the two Dockerfile `ARG`s together with a rerun of Task 11's gate; refresh `CLI_AI_MODELS` when the CLIs add models.
