# MCP coverage: reach parity with the REST API

## Overview

The MCP server (`packages/backend/src/services/mcp/`) exposes 103 tools. The REST API on `dev` has 401 routes in 46 router files (plus the OAuth metadata routes, which register on `app` directly). The route audit below maps every route: 103 have an MCP tool, and 298 have none.

This plan closes the gap:

1. **175 routes get a tool:** 147 new tools, plus extensions of 5 existing ones (`update_payee`, `search_transactions`, `get_tags`, `get_transaction_groups`, `get_balance_history`). Planned transactions also get a `confirm_planned_transaction` tool, which has no route of its own (the web app confirms through `PUT /transactions/:id`).
2. **123 routes stay out, each with a reason:** auth and billing flows, admin and test-only routes, webhooks and transports, bank-consent and live bank calls, file uploads and downloads, the import wizards, sharing writes, and the app's own AI configuration. See "Excluded routes" under Technical Details.
3. **The Apple Pay ingest feature** (`feat/apple-pay-ingest`, in progress) gets about 10 tools on its own branch once its plan is finished. That group is deferred (⏸).
4. **Groundwork found during the audit.** MCP write tools skip four things the REST middleware does:
   - the base-currency lock (`checkBaseCurrencyLock`, 423 while a base-currency change runs);
   - the plan feature gates (`requireFeature`);
   - the REST rate limiters on routes that fetch from shared or external resources (rate-source save and test);
   - checks that live only in some controllers;
   - nothing checks that a tool file is actually registered in `server.ts`.

   MCP also gets one guard wrong in the other direction: `requireScope` rejects every read-only user, while REST lets them through on a few routes (`READ_ONLY_ROUTES`).

   Task 3 adds the missing guards and a registration drift test, and brings the `add-mcp-tool` skill up to date. The skill's template still omits `requireScope`, which every write tool calls.

Every tool is a thin wrapper over the service its REST route already uses. Parity with REST is the rule: the same validation, rate limits, read-only and demo handling, base-currency lock and feature gates. When a controller holds logic that a tool needs (validation rules, or the settings, decimals, service and serializer orchestration behind a report), the plan moves that logic into a service and has both callers use it, so REST and MCP cannot drift. Nothing is copied.

When this plan is done, the server has about 250 tools (about 260 with Apple Pay). **That count relies on clients loading tools lazily** (Claude Code does, through tool search), so only the tool names and the tools the model asks for enter its context. Task 28 measures the size of the `tools/list` payload, enforces a 300,000-byte budget before the final merge to `dev`, and applies the trimming and `?tools=core` mitigations if the payload is over it, because a client that loads every tool up front may cap the count or the context it takes (Post-Completion).

## Context (from discovery)

- **MCP server:**
  - `server.ts` (`createMcpServer`, version `1.0.0`) registers 103 tools from `tools/*.ts`; the venture tools are re-exported through `tools/venture-tools.ts`. There is one prompt, `prompts/financial-data-guide.ts`.
  - Helpers live in `tools/helpers.ts`: `getUserId`, `requireScope` (it also rejects demo and read-only users), `jsonContent`, `assertOriginalCurrencyArgs`.
  - Output is slimmed by `serializers.ts` (`slimAccountsForMcp`, …).
- **Auth and scopes:**
  - The `/mcp` route gate (`routes/mcp.route.ts`, `mcp-scope-gate.e2e.ts`) requires `finance:read` for every call.
  - Read tools (`^(get|list|search|preview)_`) call no scope helper. Write tools call `requireScope({ extra, scope: 'finance:write' })`. Tools that permanently delete call it with `'finance:delete'`.
  - Two read-named tools sit on REST routes that carry `checkBaseCurrencyLock` (see below), so after Tasks 3 and 8 they call the lock check without a scope. No MCP tool calls it today.
  - `profile:read` covers name, email and base currency; no new tool needs it.
  - `routes/mcp.route.ts` wraps the transport in `runWithBalanceRevalueBatch`, so tools need no batch of their own.
- **The `add-mcp-tool` skill** (`.claude/skills/add-mcp-tool/SKILL.md`) gives this checklist for each tool:
  1. a kebab-case file with a `register<Pascal>` function, a snake_case tool name, a module-scope `inputSchema` plain object, `getUserId` then `trackMcpToolUsed`, and `jsonContent`;
  2. registration in `server.ts`;
  3. an entry in `server-card.json`;
  4. a row in `connect-moneymatter/SKILL.md`;
  5. that file's sha256 in `agent-skills/index.json`.

  Its drift gate is `npm run test:unit -- --testPathPattern='mcp/(server-card-drift|agent-skills-drift)'`, and it says not to add per-tool e2e tests.
  - **Gaps in the skill:** it omits `requireScope` and `tool-scopes-drift.unit.ts` (every non-read tool must call `requireScope`; `delete_*` tools and the hand-kept `DESTRUCTIVE_TOOLS` list must use `finance:delete`).

- **Drift tests (`services/mcp/`):**
  - `server-card-drift.unit.ts`: tool names in `tools/*.ts` equal `server-card.json`; prompts; the version equals `server.json` and `server.ts`.
  - `agent-skills-drift.unit.ts`: the SKILL.md sha256.
  - `tool-scopes-drift.unit.ts`.
  - None of them checks that a tool is registered in `server.ts`, so a forgotten `registerX(server)` passes.
- **Testing MCP tools:**
  - The MCP SDK is mocked in jest (`tests/mocks/mcp-sdk/server-mcp.ts`), and e2e tests may only call HTTP endpoints, so tools cannot be called end to end.
  - The pattern that works is `tools/transaction-amount-inputs.unit.ts`: a fake server whose `registerTool` captures the config and handler, with the services `jest.mock`ed.
  - The MCP e2e suites are `services/mcp/connected-apps.e2e.ts` and `services/mcp/mcp-scope-gate.e2e.ts`.
- **Metafiles that list the tools:**
  - `packages/frontend/public/.well-known/mcp/server-card.json` (103 tools);
  - `packages/frontend/public/skills/connect-moneymatter/SKILL.md`, whose "Available tools" table lacks the payee and venture tools today;
  - `packages/frontend/public/.well-known/agent-skills/index.json` (sha256);
  - `server.json` (version only).
- **Docs:**
  - `packages/docs/src/content/docs/ai/connect-claude-chatgpt-mcp.mdx` ("What you can ask", permissions table, link to the server card);
  - the prompt `prompts/financial-data-guide.ts`, which says the budget plan is "not available through these tools";
  - `packages/landing/src/components/mcp-section.astro`, which shows example tool names (unchanged).
- **What MCP writes skip, compared to REST middleware** (from the controller survey):
  - **`checkBaseCurrencyLock`** guards almost every REST write, through `isBaseCurrencyChangeLocked({ userId })` in `@services/currencies/base-currency-lock`. No MCP tool calls it. The lock follows the route, not the tool's name: two read-named tools sit on POST routes that carry it, `POST /transactions/transfer-recommendations/bulk-scan` (`list_transfer_suggestions`) and `POST /automations/preview` (`preview_transaction_automation`). REST refuses both with 423 during a base-currency change, so the tools do too.
  - **`requireFeature`** (`middlewares/entitlements.ts`): `budget_plan` on budget-plan writes, `attachments` on attachment delete, `fire_planner` when a settings patch carries `fire`. `services/mcp/auth.ts` loads `getEntitlementsByUserId` but keeps only `readOnly`.
  - **`blockDemoUsers` and `enforceReadOnly`**: `requireScope` rejects every demo user and every read-only user, which is stricter than REST in one place. `enforceReadOnly` lets a read-only user through on `READ_ONLY_ROUTES` (`middlewares/entitlements.ts`), so onboarding and the inbox keep working:
    - `POST /user/currencies/base` (the first base currency; the route also carries `checkBaseCurrencyLock`);
    - `POST /notifications/read-all` and `POST /notifications/:id/read`;
    - `PUT` and `PATCH /user/settings`;
    - the rest of the set (data export, account delete, billing, auth, admin and test prefixes) has no tool.

    None of those routes carries `blockDemoUsers`. MCP must allow exactly this set to read-only users, no more and no less: `requireScope` gets an `allowReadOnly` option (Task 3) that the tools on those routes pass (`mark_notifications_read`, `update_user_settings`, the first-base branch of `change_base_currency`). `dismiss_notification` and the other-base branch of `change_base_currency` stay blocked for read-only users, as their routes are. For demo users, `allowReadOnly` tools follow their routes (no `blockDemoUsers`, so demo is accepted); every other write tool keeps `requireScope`'s existing demo rejection, which this plan does not loosen.

  - **Rate limiters.** `PUT /user/currencies/:code/rate-source` and `POST …/rate-source/test` are wrapped in `rateSourceSaveRateLimit` and `rateSourceTestRateLimit` (20 per minute per user, `middlewares/rate-limit.ts`). A save fetches from CoinGecko (one shared key for the instance) or from the user's URL and re-values every saved row of the currency; a test fetches the user's URL. The MCP tools apply the same budgets through the same `RateLimitService` and the same keys. Task 2 adds the shared per-user limiter and applies it in the two tools on their own branch, so the upstream-bound branches never ship them unlimited; Task 3 only audits the rest. The other limiters sit on routes with no tool (`attachmentUploadRateLimit` guards the byte upload; `create_attachment_upload_url` only issues the token URL).

- **Controller-only logic a tool would otherwise copy:**
  - account update checks (`currentBalance` only on system accounts; no move into or out of the `vehicle` category);
  - refund recommendations, transfer recommendations, transfer bulk scan and dismissal (all inline in `controllers/transactions.controller/`);
  - the holding creation from a search result;
  - the rate-source save follow-ups (`backfillCoingeckoRates`, `fetchHttpRateAfterSave`);
  - the change-base supported-currency check;
  - the exchange-rate pair rules of `PUT /user/currency/rates` (every pair needs its opposite in the same call, no pair with the same base and quote, `rate > 0`, `.strict()`), which only the controller's local zod schema enforces, and the opposite-pair rule of the delete route;
  - the budget-plan goal `superRefine`;
  - the import-batch delete fallback to a queued job;
  - the loan view assembly (`projectLoan` + `countLoanPayments` + `serializeLoan`);
  - the settings + decimals + service + serializer orchestration of every stats report, which Task 15 moves into report services instead of copying into each tool. (On `dev` the tracker reads and budget-plan reads hold none: each controller is a service call plus, for trackers, a serializer, so Tasks 13 and 20 add no service for them.)
- **Planned transactions:**
  - The web app confirms a plan with `PUT /transactions/:id` `{ isPlanned: false }`, adding `time: now` when the plan is still in the future (`upcoming-section.vue`).
  - The service refuses it on bank-connected accounts (`plannedUnflipOnConnectedAccount`).
  - On `dev`, confirming also settles the linked subscription period (`42141245`).
  - `update_transaction` has no `isPlanned`.
  - `search_transactions` has no `isPlanned` filter, and its `endDate` defaults to now, so future plans are hidden.
- **`dev` moved after this worktree was cut** (`90bf0925` to `17e13dd7`, the per-currency-precision merge):
  - Stats, tracker and budget-plan engines now take base or plan `decimals` (`getBaseCurrencyDecimals`), and their serializers take `{ …, decimals }`.
  - Five existing stats tools were updated there.
  - New stats tools get the decimals handling by calling the report services that Task 15 extracts from the stats controller on `dev` (which Task 3's merge brings in), not by copying it. Tracker and plan tools call the services that already return `decimals`.
- **Bugs and gaps noticed, outside this plan's scope:**
  - `GET /transactions/:id/refunds` validates `query.transactionId` and ignores `:id`.
  - `get_balance_history` omits `includeCreditLimit` in its combined branch (fixed in Task 15, test first).
- **Branches and worktrees** (state on 2026-10-17):

  | Tools for                                      | Branch                       | Worktree                                                                                       |
  | ---------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
  | custom currencies (CRUD, decimals, logo)       | `feat/custom-currencies`     | `/Users/nemirovsky/Developer/moneymatter-currencies`                                           |
  | rate sources, rate history, dated manual rates | `feat/currency-rate-sources` | main checkout `/Users/nemirovsky/Developer/moneymatter`, after `git switch`                    |
  | Apple Pay ingest tokens, card mappings         | `feat/apple-pay-ingest`      | `/Users/nemirovsky/Developer/moneymatter-applepay`, only after the Apple Pay plan finishes (⏸) |
  | everything else                                | `feat/mcp-coverage`          | `/Users/nemirovsky/Developer/moneymatter-mcp`                                                  |
  - `feat/custom-currencies` is an ancestor of `feat/currency-rate-sources`, and both are fully merged into `dev`, with nothing ahead. Their MCP files equal `dev`'s.
  - `feat/apple-pay-ingest` is 5 commits ahead. It touches `services/mcp/auth.ts` (moves `hashToken` to `@common/lib/hash-token`). So far it has only `GET|POST /user/settings/ingest-tokens` and `DELETE /user/settings/ingest-tokens/:id`; revoke is a hard delete.
  - `moneymatter-currencies` has `fix/cloudflare-access-cookie` checked out with **uncommitted changes** (`setup-middleware.ts`, `tests/helpers/mcp.ts`).
  - The main checkout is on `dev`. Its tree was clean at the last check, but an earlier check today found staged work.
  - `dev` is checked out only in the main checkout, so every merge into `dev` runs there.

- **Conventions (repo `CLAUDE.md`):**
  - Object params and kebab-case files.
  - e2e only through HTTP helpers, run through `test-runner` and never in parallel.
  - Money in decimals over the API.
  - i18n through `i18n-editor` (en + uk). No new UI strings are expected; error messages reuse existing keys.
  - Stop and ask after 1–2 failed fix attempts.

## Development Approach

- **Branch and worktree per task:**
  - Every task names its `**Branch:**` and its `**Worktree:**`, and the tasks are grouped by branch. Work in that worktree, switching it to the branch first where the task says so. Create no new branches and no new worktrees.
  - A merge step closes each group and names where it runs.
  - Before any `git switch`, the worktree must be clean. If it is not (someone else's work in progress), stop and ask the owner; never stash or commit someone else's changes.
- **Order:**
  1. Group B: `feat/custom-currencies`, merged into `feat/currency-rate-sources`.
  2. Group C: `feat/currency-rate-sources`, merged into `dev`.
  3. Group A: `feat/mcp-coverage`. It starts by merging `dev`, so it carries the currency tools and dev's decimals changes, then is merged into `dev`.
  4. Group D: `feat/apple-pay-ingest` ⏸, run whenever the Apple Pay plan is done; it starts by merging `dev`.
  5. Final group on `feat/mcp-coverage`: Verify and Docs, merged into `dev`. It does not wait for Group D.

  The currency branches are upstream PR candidates, so `dev` is never merged into them. They get their tools first, and the tools ship with REST's guards from the start: Task 1 adds `assertBaseCurrencyUnlocked` and applies it to the custom-currency writes, and Task 2 adds the shared rate limiter and applies the lock and the limits to the rate-source and rate tools. Task 3 then covers every other existing write tool.

- **Testing approach:** regular, code first and tests in the same task, with two test-first exceptions. Each tool is a thin wrapper, and the risk sits in argument mapping, scopes and guards, which the unit tests cover.
  - **Moves are proven by REST e2e, written first.** Where a task moves controller logic into a service, the existing REST e2e suites of that route stay green without edits to their expectations, and that is the proof the move kept behaviour. Before the move, check that an e2e case exercises each moved check. A check with none gets an e2e case first, run green against the unmoved code; the move then keeps it green. The tool unit tests mock the services, so they cannot see these checks.
  - **Bug fixes are test-first.** A failing tool unit test that reproduces the bug comes before the fix (Task 15, `get_balance_history`).
- **Gates name exactly which tests must pass:**
  - Unit: `cd packages/backend && npm run test:unit -- --testPathPattern='services/mcp/'`. It covers the drift suites and every new tool unit test.
  - e2e: one batched run per gate, `cd packages/backend && lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='...'`. It runs through `test-runner`, never in parallel, and never the full suite. Every pattern includes `services/mcp/(connected-apps|mcp-scope-gate)`.
  - Then backend typecheck, lint and oxfmt.
- **One area per task, 4–8 tools.** Follow the `add-mcp-tool` skill for every tool, as updated in Task 3.
- **Mirror the REST route** for each tool:
  - the same service;
  - the same validation, enforced on both paths: the rules live in a shared schema or in the service, never only in a controller (reuse the controller's zod schema or fields where they are exported, or move them);
  - the same lock, feature gate, rate limit, and read-only and demo handling;
  - the same serializer, slimmed for MCP where the output is large.
- Complete each task fully before the next. **Keep this plan current** when scope changes.
- **Commits:** as the exec flow makes them, one per task; no pushes.

## Testing Strategy

- **Backend unit** (`npm run test:unit` in `packages/backend`): one `tools/<area>-tools.unit.ts` per task, built on Task 3's `captureTools`. For every new tool:
  - its input schema accepts a valid input and rejects an invalid one (a wrong enum, a missing id). Refinements (a mutually exclusive pair, an either-or) are enforced in the handler by a shared validator, so the test asserts that the **tool** rejects them, not the schema;
  - a write tool throws without its scope, throws while the base-currency lock is set (unless exempt), and throws without the feature when it has a gate. A tool that wraps a rate-limited REST route throws when the limiter says no. A tool on a `READ_ONLY_ROUTES` route passes for a read-only user, and every other write tool throws for one. In each refusal the service mock is not called;
  - the handler calls the service with `userId` and the mapped arguments, and returns `jsonContent` of the result;
  - a read tool works with no scope helper, except the lock-carrying reads, which throw while the lock is set;
  - conditional behaviour, such as `change_base_currency` with and without a base currency, or `ignore_payee_name` with `force`.
- **Drift and registration** (unit, every gate): `server-card-drift`, `agent-skills-drift`, `tool-scopes-drift` (extended in Task 3), and `server-registration-drift` (new in Task 3).
- **Backend e2e:** the MCP suites plus the REST suites of the routes each task wraps. These guard every service the task touches, and any logic it moves out of a controller. Moved checks that no e2e case covered get one before the move (see "Testing approach").
- **No frontend changes.** The docs site build runs in Task 29.

## Progress Tracking

- Mark completed items `[x]` immediately.
- Prefix newly discovered tasks with ➕ and blockers with ⚠️.
- Keep this plan in sync with the actual work.

## Solution Overview

- **Tool shape.** Each tool is one file in `tools/`, following the skill's template, with three changes after Task 3:
  - write tools call `requireScope` (with `allowReadOnly` on the `READ_ONLY_ROUTES` tools), then `await assertBaseCurrencyUnlocked({ userId })`, then (when gated) `requireFeatureAccess({ extra, feature })`, then (when their route is rate-limited) `await enforceUserRateLimit(…)`, before `trackMcpToolUsed`;
  - errors are thrown as `Error`s with the same i18n message the REST route returns;
  - output goes through the route's serializer, and lists through an MCP slim helper in `serializers.ts` when the REST payload carries UI-only fields.
- **Consolidation.** Routes that differ only by an id or a filter share one tool:
  - `get_transactions` takes ids or a transfer id;
  - `get_refunds` lists, or reads one pair, or reads one transaction's refunds;
  - `get_user_currencies` returns currencies, base and pair rates;
  - `get_notifications` returns the list, one item and the unread count.

  This keeps the tool count near one per action, not one per route.

- **Planned transactions** get `confirm_planned_transaction` and an `isPlanned` filter on `search_transactions`. `update_transaction` stays without `isPlanned`, so a plan is confirmed only through one tool with one clear contract.
- **Guards.** `assertBaseCurrencyUnlocked` arrives in Task 1 and `enforceUserRateLimit` in Task 2 (each with the tools of that branch, which are upstream PR candidates); Task 3 adds `requireFeatureAccess` and `requireScope`'s `allowReadOnly` option to `tools/helpers.ts` and applies the lock check to every other existing write tool. The base-currency lock follows the REST route, not the scope: `tool-scopes-drift.unit.ts` fails for any write tool without it unless the tool is listed in `LOCK_EXEMPT_TOOLS` (whose REST route has no lock: the change branch of `change_base_currency`, notification reads, settings patch, `test_currency_rate_source` and others), and for any tool in `LOCK_GUARDED_READ_TOOLS` (read-named tools whose route carries the lock) that does not call it.
- **Excluded routes** are listed with a reason under Technical Details. They do not get tools in this plan.

## Technical Details

### Tool conventions

- **Names:**
  - read tools start with `get_`, `list_`, `search_` or `preview_`, and nothing else does;
  - `delete_*` tools require `finance:delete`;
  - a tool whose delete path is optional (`ignore_payee_name` with `force`; `revert_subscription_period` when the period's transaction is app-created) is the exception: `finance:write` normally, plus `finance:delete` on the delete path, listed in `CONDITIONAL_DELETE_TOOLS` instead of `DESTRUCTIVE_TOOLS`;
  - other tools that permanently remove data (`bulk_delete_*`, `revoke_ingest_token`, `dismiss_card_payment_request` if it deletes) also require `finance:delete` and are added to `DESTRUCTIVE_TOOLS`. A soft delete that a restore tool undoes is a `finance:write` tool: `remove_duplicate_transactions` and `merge_duplicate_transactions` (merged rows get `deletedAt` and `mergedIntoId`, and `restore_removed_transactions` clears both).
- **Refined inputs:** the SDK's `inputSchema` is a plain shape of Zod fields, so a rule that spans fields (an either-or, a mutually exclusive pair, a `superRefine`) cannot sit in it. The tool exposes the shared schema's `.shape` as `inputSchema` and runs the full shared schema or validator in its handler, on the schema's own fields only: when the tool adds ids beside a strict body schema, destructure them off first (`const { planId, lineId, ...body } = args; schema.parse(body)`), or the strict parse rejects the ids as unrecognized keys. An `assert…Args` helper like `assertOriginalCurrencyArgs` works the same way. REST and MCP then enforce one rule set. The unit test asserts the tool rejects, not the shape.
- **Shared logic:** controller logic a tool needs (validation, orchestration) moves into a service or shared schema that the controller and the tool both call. The tool never re-implements it.
- **Ids:**
  - `recordId()` from `@common/lib/zod/custom-types` for record ids;
  - money as decimal numbers (investment amounts as the decimal strings their REST schemas use);
  - dates as ISO strings converted with `new Date()` where the service wants a `Date`.
- **Pagination caps:** reuse the REST limits (for example notifications 1–100, batches 1–100, budget category transactions 1–100). `get_transactions` caps `ids` at 50, the limit of `getTransactionsByIds` (`MAX_IDS`).
- **Deliberate deviations from REST (MCP only):** a REST route that is too dangerous for an AI client to call with a forgotten argument is tightened in the tool, never in the shared service. `bulk_delete_transactions` refuses empty filters (`filters: {}` or only no-op values), which REST accepts and which delete everything the caller owns; it needs explicit `transactionIds` or at least one narrowing filter. Each such deviation is stated in the tool's description and has a unit test.
- **Write guard order:** `getUserId` → `requireScope` (`allowReadOnly: true` only for a `READ_ONLY_ROUTES` tool) → `assertBaseCurrencyUnlocked` (unless exempt) → `requireFeatureAccess` (when gated) → `enforceUserRateLimit` (when the REST route is rate-limited) → `trackMcpToolUsed` → service.
- **Lock-carrying reads:** a read-named tool whose REST route carries `checkBaseCurrencyLock` calls `getUserId` → `assertBaseCurrencyUnlocked` → `trackMcpToolUsed` → service, and is listed in `LOCK_GUARDED_READ_TOOLS`.
- **The four metafiles** each tool touches (skill steps 2–5):
  - `services/mcp/server.ts` (import and `register…(server)` under the right comment group);
  - `server-card.json`;
  - the `connect-moneymatter/SKILL.md` row, which states the scope as the existing rows do;
  - the sha256 in `agent-skills/index.json`, recomputed with `shasum -a 256` after the last SKILL.md edit of the task.
- **Version:** additive tools keep `serverInfo.version` `1.0.0` (skill rule), in `server.ts`, `server-card.json` and `server.json`.
- **Merge conflicts:**
  - in `server.ts`, `server-card.json` and SKILL.md, keep both sides;
  - in `agent-skills/index.json`, recompute the sha256 after resolving SKILL.md;
  - then run the drift suites.

### Helpers added in Tasks 1–3

- `assertBaseCurrencyUnlocked({ userId })` (Task 1, so the upstream-bound currency branches ship with the lock):
  - `isBaseCurrencyChangeLocked`; throws `t({ key: 'currencies.baseCurrencyChangeInProgress' })`;
  - fails closed with `t({ key: 'common.serviceTemporarilyUnavailable' })` when Redis throws, as the middleware does.
- `requireFeatureAccess({ extra, feature })` (Task 3): reads `extra.authInfo.extra.features`, the way `requireScope` reads `readOnly`, and throws the same message as `requireFeature`'s 402 when the feature is missing. It makes no entitlement call of its own: `verifyAccessToken` in `services/mcp/auth.ts` already calls `getEntitlementsByUserId` on every MCP request and keeps only `readOnly`, so Task 3 keeps `features` (`Entitlements.features`, active feature trials already merged in) beside it in `McpAuthInfo.extra`. A missing `features` array counts as no features, so a gate never passes on an auth payload that failed to carry it.
- `requireScope({ extra, scope, allowReadOnly = false })` (Task 3): with `allowReadOnly: true` it skips the read-only rejection and the demo rejection, and still checks the scope. Only the tools on `READ_ONLY_ROUTES` routes pass it.
- `enforceUserRateLimit({ userId, limit })` (Task 2, for the same reason): calls `RateLimitService.checkRateLimit` with `limit.key({ userId })`, `limit.windowSeconds` and `limit.maxAttempts`; throws `t({ key: 'middleware.tooManyRequests' })` when refused, and lets the call through when Redis is down, as the REST middleware does for these routes. The budgets are shared constants (`RATE_SOURCE_SAVE_LIMIT`, `RATE_SOURCE_TEST_LIMIT`, in `services/common/user-rate-limits.ts`) that `middlewares/rate-limit.ts` also reads, so the two paths cannot drift and share one counter per user.
- `packages/backend/src/tests/helpers/mcp-tools.ts` (the project's helper directory; a new unit-only module, because the existing `tests/helpers/mcp.ts` imports `@root/app`, supertest and the auth pool, which a unit test must not load):
  - `captureTools({ register })` returns `[{ name, config, handler }]`;
  - `makeExtra({ userId, scopes, readOnly = false, role, features = [] })` builds the `extra` that `getUserId`, `requireScope` and `requireFeatureAccess` read, so a gated-tool test passes `features` and mocks no entitlement service.
  - Unit tests import it as `@tests/helpers/mcp-tools`.

### Route audit

Legend:

- ✅ covered by an existing tool;
- ➕ T*n* gets a tool in Task _n_ (E = extends an existing tool);
- ⛔ excluded, with a reason key from "Excluded routes".

Paths are relative to each mount; Apple Pay routes are in Group D.

**`/accounts`** (9: ✅ 2, ➕ 6, ⛔ 1)

| Route                        | Status | Tool / reason                                          |
| ---------------------------- | ------ | ------------------------------------------------------ |
| GET /                        | ✅     | `get_accounts`                                         |
| GET /:id                     | ➕ T4  | `get_account`                                          |
| GET /:id/transaction-count   | ➕ T4  | `get_account` (`transactionCount`)                     |
| POST /                       | ➕ T4  | `create_account`                                       |
| PUT /:id                     | ➕ T4  | `update_account` (status stays with `archive_account`) |
| DELETE /:id                  | ➕ T4  | `delete_account`                                       |
| POST /:id/unlink             | ➕ T4  | `unlink_account_from_bank_connection`                  |
| POST /:id/link               | ⛔     | bank                                                   |
| POST /:id/balance-adjustment | ✅     | `adjust_account_balance`                               |

**`/account-group`** (`account-groups.ts`, 8: ➕ 8)

| Route                                 | Status | Tool                             |
| ------------------------------------- | ------ | -------------------------------- |
| POST /                                | ➕ T5  | `create_account_group`           |
| GET /                                 | ➕ T5  | `get_account_groups`             |
| PUT /:groupId                         | ➕ T5  | `update_account_group`           |
| DELETE /:groupId                      | ➕ T5  | `delete_account_group`           |
| POST /:groupId/add-account/:accountId | ➕ T5  | `add_account_to_group`           |
| DELETE /:groupId/accounts             | ➕ T5  | `remove_accounts_from_group`     |
| PUT /:groupId/move                    | ➕ T5  | `move_account_group`             |
| GET /:groupId/accounts                | ➕ T5  | `get_account_groups` (`groupId`) |

**`/transactions`** (38: ✅ 13, ➕ 22, ⛔ 3)

| Route                                      | Status | Tool / reason                                                                 |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------------- |
| POST /:transactionId/attachments           | ✅     | `create_attachment_upload_url` (token URL)                                    |
| GET /refund                                | ➕ T8  | `get_refunds` (pair)                                                          |
| GET /refunds                               | ➕ T8  | `get_refunds`                                                                 |
| GET /refund-recommendations                | ➕ T8  | `get_refund_recommendations`                                                  |
| GET /planned-summary                       | ➕ T7  | `get_planned_summary`                                                         |
| GET /summary                               | ➕ T7  | `get_transactions_summary`                                                    |
| GET /transfer-recommendations              | ➕ T8  | `get_transfer_recommendations`                                                |
| POST /transfer-recommendations/bulk-scan   | ➕ T8  | `list_transfer_suggestions`                                                   |
| POST /transfer-recommendations/dismiss     | ➕ T8  | `dismiss_transfer_suggestion`                                                 |
| POST /refund                               | ✅     | `link_refund`                                                                 |
| POST /match-invoice                        | ⛔     | file                                                                          |
| POST /match-invoice/candidates             | ⛔     | file (second step of the upload flow)                                         |
| DELETE /refund                             | ✅     | `unlink_refund`                                                               |
| GET /reconciliation/history                | ➕ T9  | `get_reconciliation_history`                                                  |
| GET /reconciliation/stuck-pending          | ➕ T9  | `list_stuck_pending_transactions`                                             |
| POST /reconciliation/remove                | ➕ T9  | `remove_duplicate_transactions`                                               |
| POST /reconciliation/merge                 | ➕ T9  | `merge_duplicate_transactions`                                                |
| POST /reconciliation/restore               | ➕ T9  | `restore_removed_transactions`                                                |
| POST /reconciliation/keep-as-booked        | ➕ T9  | `keep_pending_as_booked`                                                      |
| POST /reconciliation/stuck-pending/check   | ⛔     | bank                                                                          |
| DELETE /splits/:splitId                    | ✅     | `delete_split`                                                                |
| POST /:transactionId/link-to-portfolio     | ✅     | `link_transaction_to_portfolio`                                               |
| POST /:transactionId/unlink-from-portfolio | ✅     | `unlink_transaction_from_portfolio`                                           |
| GET /:transactionId/portfolio-link         | ➕ T7  | `get_transaction_links`                                                       |
| GET /:transactionId/venture-link           | ➕ T7  | `get_transaction_links`                                                       |
| GET /:transactionId/attachments            | ➕ T7  | `list_transaction_attachments`                                                |
| GET /                                      | ✅     | `search_transactions` (E T7: `isPlanned`)                                     |
| GET /by-ids                                | ➕ T7  | `get_transactions`                                                            |
| GET /:id                                   | ➕ T7  | `get_transactions`                                                            |
| GET /:id/refunds                           | ➕ T8  | `get_refunds` (`transactionId`)                                               |
| GET /transfer/:transferId                  | ➕ T7  | `get_transactions` (`transferId`)                                             |
| POST /                                     | ✅     | `create_transaction`                                                          |
| PUT /unlink                                | ✅     | `unlink_transfer`                                                             |
| PUT /link                                  | ✅     | `link_transfer` (one pair per call)                                           |
| PUT /bulk                                  | ✅     | `bulk_update_transactions`                                                    |
| POST /bulk-delete                          | ➕ T7  | `bulk_delete_transactions`                                                    |
| PUT /:id                                   | ✅     | `update_transaction`; `isPlanned: false` → `confirm_planned_transaction` (T7) |
| DELETE /:id                                | ✅     | `delete_transaction`                                                          |

**`/attachments`** (2: ➕ 1, ⛔ 1): GET /:id/file ⛔ file; DELETE /:id ➕ T7 `delete_attachment`.

**`/categories`** (5: ✅ 4, ➕ 1): GET / ✅ `get_categories`; POST / ✅ `create_category`; PUT /:id ✅ `update_category`; DELETE /:id ✅ `delete_category`; GET /:id/transaction-count ➕ T12 `get_category_transaction_count`.

**`/tags`** (12: ✅ 6, ➕ 6)

| Route                        | Status | Tool                                                     |
| ---------------------------- | ------ | -------------------------------------------------------- |
| GET /                        | ✅     | `get_tags`                                               |
| GET /:id                     | ➕ T12 | `get_tags` (E: `tagId`)                                  |
| POST /                       | ✅     | `create_tag`                                             |
| PUT /:id                     | ✅     | `update_tag`                                             |
| DELETE /:id                  | ✅     | `delete_tag`                                             |
| POST /:id/transactions       | ✅     | `assign_tags_to_transaction`, `bulk_update_transactions` |
| DELETE /:id/transactions     | ✅     | `remove_tags_from_transaction`                           |
| GET /:tagId/reminders        | ➕ T13 | `get_tag_reminders`                                      |
| GET /:tagId/reminders/:id    | ➕ T13 | `get_tag_reminders`                                      |
| POST /:tagId/reminders       | ➕ T13 | `create_tag_reminder`                                    |
| PUT /:tagId/reminders/:id    | ➕ T13 | `update_tag_reminder`                                    |
| DELETE /:tagId/reminders/:id | ➕ T13 | `delete_tag_reminder`                                    |

**`/tag-reminders`** (1: ➕ 1): GET / ➕ T13 `get_tag_reminders`.

**`/payees`** (16: ✅ 7, ➕ 8, ⛔ 1)

| Route                           | Status | Tool / reason                                              |
| ------------------------------- | ------ | ---------------------------------------------------------- |
| GET /                           | ✅     | `get_payees`                                               |
| POST /                          | ✅     | `create_payee`                                             |
| GET /lookup                     | ✅     | `get_payees` (same id and name list)                       |
| PATCH /bulk-categorization-mode | ➕ T11 | `set_payees_categorization_mode`                           |
| POST /bulk-delete               | ➕ T11 | `bulk_delete_payees`                                       |
| GET /ignored-names              | ➕ T11 | `get_ignored_payee_names`                                  |
| POST /ignored-names             | ➕ T11 | `ignore_payee_name`                                        |
| DELETE /ignored-names/:id       | ➕ T11 | `unignore_payee_name`                                      |
| GET /:id                        | ✅     | `get_payee`                                                |
| PATCH /:id                      | ✅     | `update_payee` (E T11: mode, default tags, location, logo) |
| DELETE /:id                     | ✅     | `delete_payee`                                             |
| POST /:id/merge                 | ✅     | `merge_payees`                                             |
| POST /:id/apply-tags            | ➕ T11 | `apply_payee_tags_to_transactions`                         |
| POST /:id/aliases               | ➕ T11 | `create_payee_alias`                                       |
| DELETE /:id/aliases/:aliasId    | ➕ T11 | `delete_payee_alias`                                       |
| POST /:id/reset-logo            | ⛔     | cosmetic                                                   |

**`/budgets`** (trackers; 11: ✅ 8, ➕ 3)

- ✅: GET / `get_budgets`; GET /:id/spending-stats `get_budget_spending_stats`; POST / `create_budget`; PUT /:id `update_budget`; PATCH /:id/archive `archive_budget`; DELETE /:id `delete_budget`; POST /:id/transactions `add_transactions_to_budget`; DELETE /:id/transactions `remove_transactions_from_budget`.
- ➕ T13: GET /:id `get_budget`; GET /:id/stats `get_budget`; GET /:id/category-transactions `get_budget_transactions`.

**`/budget-plans`** (26: ➕ 26)

| Route                                                   | Status | Tool                                           |
| ------------------------------------------------------- | ------ | ---------------------------------------------- |
| GET /                                                   | ➕ T20 | `list_budget_plans`                            |
| GET /suggestion-context                                 | ➕ T20 | `get_budget_plan_suggestion_context`           |
| GET /:planId                                            | ➕ T20 | `list_budget_plans` (`planId`)                 |
| GET /:planId/trends                                     | ➕ T20 | `get_budget_plan_trends`                       |
| GET /:planId/periods                                    | ➕ T20 | `list_budget_plan_periods`                     |
| GET /:planId/periods/:periodId                          | ➕ T20 | `get_budget_plan_period`                       |
| GET /:planId/periods/:periodId/scheduled                | ➕ T20 | `get_budget_plan_scheduled`                    |
| POST /                                                  | ➕ T21 | `create_budget_plan`                           |
| PATCH /:planId                                          | ➕ T21 | `update_budget_plan`                           |
| DELETE /:planId                                         | ➕ T21 | `delete_budget_plan`                           |
| POST /:planId/restore                                   | ➕ T21 | `restore_budget_plan`                          |
| PUT /:planId/accounts                                   | ➕ T21 | `set_budget_plan_accounts`                     |
| POST /:planId/groups                                    | ➕ T21 | `create_budget_plan_group`                     |
| PATCH /:planId/groups/:groupId                          | ➕ T21 | `update_budget_plan_group`                     |
| DELETE /:planId/groups/:groupId                         | ➕ T21 | `delete_budget_plan_group`                     |
| PUT /:planId/layout                                     | ➕ T22 | `set_budget_plan_layout`                       |
| POST /:planId/lines                                     | ➕ T22 | `create_budget_plan_line`                      |
| POST /:planId/suggested-lines                           | ➕ T22 | `add_suggested_budget_plan_lines`              |
| PATCH /:planId/lines/:lineId                            | ➕ T22 | `update_budget_plan_line`                      |
| DELETE /:planId/lines/:lineId                           | ➕ T22 | `delete_budget_plan_line`                      |
| POST /:planId/lines/:lineId/archive                     | ➕ T22 | `archive_budget_plan_line`                     |
| POST /:planId/lines/:lineId/restore                     | ➕ T22 | `archive_budget_plan_line` (`archived: false`) |
| PUT /:planId/lines/:lineId/goal                         | ➕ T23 | `set_budget_plan_line_goal`                    |
| DELETE /:planId/lines/:lineId/goal                      | ➕ T23 | `delete_budget_plan_line_goal`                 |
| POST /:planId/lines/:lineId/goal/snooze                 | ➕ T23 | `snooze_budget_plan_line_goal`                 |
| PUT /:planId/periods/:periodId/lines/:lineId/assignment | ➕ T23 | `set_budget_plan_assignment`                   |

**`/subscriptions`** (22: ✅ 13, ➕ 8, ⛔ 1)

- ✅:
  - GET / `get_subscriptions`; GET /summary `get_subscriptions_summary`; GET /upcoming `get_upcoming_subscription_payments`;
  - GET /detect-candidates `detect_subscription_candidates`; GET /candidates `list_subscription_candidates`; POST /candidates/:id/dismiss `dismiss_subscription_candidate`;
  - GET /:id `get_subscription_by_id`; POST / `create_subscription`; PUT /:id `update_subscription`; DELETE /:id `delete_subscription`; PATCH /:id/toggle-active `toggle_subscription_active`;
  - POST /:id/transactions `link_transactions_to_subscription`; DELETE /:id/transactions `unlink_transactions_from_subscription`.
- ➕ T10:
  - POST /candidates/:id/accept `accept_subscription_candidate`;
  - GET /:id/suggest-matches `list_subscription_match_suggestions`;
  - GET /:id/pay-preview `preview_subscription_payment`;
  - GET /:id/periods `get_subscription_periods`;
  - POST /:id/periods/:periodId/pay `pay_subscription_period`;
  - POST …/skip `skip_subscription_period`;
  - POST …/unlink `unlink_subscription_period_transaction`;
  - POST …/revert `revert_subscription_period`.
- ⛔: POST /:id/reset-logo (cosmetic).

**`/automations`** (7: ✅ 6, ➕ 1)

- ✅: GET / `get_transaction_automations`; POST / `create_transaction_automation`; PUT /reorder `reorder_transaction_automations`; POST /preview `preview_transaction_automation`; PATCH /:id `update_transaction_automation`; DELETE /:id `delete_transaction_automation`.
- ➕ T12: POST /:id/apply `apply_transaction_automation`.

**`/transaction-groups`** (7: ✅ 6, ➕ 1)

- ✅: GET / `get_transaction_groups`; POST / `create_transaction_group`; PUT /:id `update_transaction_group`; DELETE /:id `delete_transaction_group`; POST /:id/transactions `add_transactions_to_group`; DELETE /:id/transactions `remove_transactions_from_group`.
- ➕ T12: GET /:id `get_transaction_groups` (E: `groupId`).

**`/transaction-templates`** (4: ➕ 4): GET / `get_transaction_templates`, POST / `create_transaction_template`, PUT /:id `update_transaction_template`, DELETE /:id `delete_transaction_template` (all T12).

**`/stats`** (13: ✅ 5, ➕ 8)

- ✅: GET /balance-history `get_balance_history`; /combined-balance-history `get_balance_history` (E T15: `includeCreditLimit`); /expenses-amount-for-period `get_expenses_for_period`; /spendings-by-categories `get_spending_by_categories`; /cash-flow `get_cash_flow`.
- ➕ T15: /total-balance `get_total_balance`; /net-worth-drivers `get_net_worth_drivers`; /net-worth-history `get_net_worth_history`; /investment-contributions `get_investment_contributions`; /venture-contributions `get_venture_contributions`; /pivot `get_pivot_report`; /cumulative `get_cumulative_stats`; /earliest-transaction-date `get_earliest_transaction_date`.

**`/investments`** (35: ✅ 16, ➕ 11, ⛔ 8)

| Route                                                  | Status | Tool / reason                        |
| ------------------------------------------------------ | ------ | ------------------------------------ |
| GET /portfolios                                        | ✅     | `get_portfolios`                     |
| GET /portfolios/annualized-returns                     | ➕ T16 | `get_portfolios_overview`            |
| GET /portfolios/summaries                              | ➕ T16 | `get_portfolios_overview`            |
| GET /portfolios/:id                                    | ➕ T16 | `get_portfolio`                      |
| GET /portfolios/:id/balance                            | ✅     | `get_portfolio_balances`             |
| GET /portfolios/:id/summary                            | ✅     | `get_portfolio_summary`              |
| PUT /portfolios/:id/balance                            | ⛔     | internal (test and dev seeding only) |
| POST /portfolios/:id/cash-transaction                  | ✅     | `create_portfolio_cash_transaction`  |
| POST /portfolios/:id/transfer                          | ➕ T16 | `transfer_between_portfolios`        |
| POST /portfolios/:id/exchange-currency                 | ➕ T16 | `exchange_portfolio_currency`        |
| POST /portfolios/:id/transfer/from-account             | ✅     | `transfer_account_to_portfolio`      |
| POST /portfolios/:id/transfer/to-account               | ✅     | `transfer_portfolio_to_account`      |
| GET /portfolios/:id/transfers                          | ✅     | `list_portfolio_transfers`           |
| PATCH /portfolios/:id/transfers/:transferId/adjustment | ➕ T16 | `set_portfolio_transfer_adjustment`  |
| DELETE /portfolios/:id/transfers/:transferId           | ➕ T16 | `delete_portfolio_transfer`          |
| PUT /portfolios/:id                                    | ✅     | `update_portfolio`                   |
| DELETE /portfolios/:id                                 | ✅     | `delete_portfolio`                   |
| POST /portfolios/:id/restore                           | ➕ T16 | `restore_portfolio`                  |
| POST /portfolios                                       | ✅     | `create_portfolio`                   |
| POST /sync/securities-prices                           | ⛔     | admin                                |
| GET /prices                                            | ➕ T17 | `get_security_prices`                |
| GET /securities                                        | ⛔     | redundant (`search_securities`)      |
| GET /securities/search                                 | ✅     | `search_securities`                  |
| POST /securities/price-upload-info                     | ⛔     | admin                                |
| POST /securities/prices/bulk-upload                    | ⛔     | admin                                |
| GET /portfolios/:portfolioId/holdings                  | ✅     | `get_portfolio_holdings`             |
| POST /holding                                          | ➕ T17 | `create_holding`                     |
| DELETE /holding                                        | ➕ T17 | `delete_holding`                     |
| GET /transactions                                      | ✅     | `get_investment_transactions`        |
| POST /transaction                                      | ✅     | `create_investment_transaction`      |
| DELETE /transaction/:transactionId                     | ✅     | `delete_investment_transaction`      |
| PUT /transaction/:transactionId                        | ✅     | `update_investment_transaction`      |
| POST /transactions-import/estimate-cost                | ⛔     | import                               |
| POST /transactions-import/extract                      | ⛔     | import                               |
| POST /transactions-import/execute                      | ⛔     | import                               |

**`/venture`** (19: ✅ 16, ➕ 3)

- ✅ (`list_`, `get_`, `create_`, `update_`, `delete_` tools):
  - `/platforms` (5 routes);
  - `/deals` (6 routes, including `/deals/:id/metrics` → `get_venture_deal_metrics`);
  - `/deals/:dealId/events` (2 routes) and `/events/:id` (3 routes).
- ➕ T17:
  - POST /events/:id/links `link_transactions_to_venture_event`;
  - PUT /events/:id/links `replace_venture_event_links`;
  - DELETE /events/:id/links/:linkId `delete_venture_event_link`.

**`/loans`** (9: ➕ 9, all T18)

- GET / and GET /:id: `get_loans`;
- GET /:id/balance-history: `get_loan_balance_history`;
- POST /: `create_loan`;
- PATCH /:id: `update_loan`;
- DELETE /:id: `delete_loan`;
- POST /:id/events: `add_loan_note`;
- POST /:id/link-payments: `link_loan_payments`;
- POST /:id/unlink-payment: `unlink_loan_payment`.

**`/vehicles`** (5: ➕ 5, all T19): GET / and GET /:id `get_vehicles`; POST / `create_vehicle`; PATCH /:id `update_vehicle`; DELETE /:id `delete_vehicle`.

**`/notifications`** (7: ➕ 6, ⛔ 1)

- ➕ T14: GET /, GET /unread-count and GET /:id `get_notifications`; POST /:id/read and POST /read-all `mark_notifications_read`; POST /:id/dismiss `dismiss_notification`.
- ⛔: POST / (internal: background services create notifications; the route exists for tests).

**`/user`** (58: ✅ 1, ➕ 22, ⛔ 35)

| Route                                         | Status | Tool / reason                                       |
| --------------------------------------------- | ------ | --------------------------------------------------- |
| GET /                                         | ✅     | `get_user_profile`                                  |
| POST /feature-trials/:feature                 | ⛔     | account                                             |
| PUT /update                                   | ⛔     | account (identity fields; no `profile:write` scope) |
| DELETE /delete                                | ⛔     | account                                             |
| POST /wipe-data                               | ⛔     | account                                             |
| POST /data-export                             | ⛔     | file                                                |
| POST /backup                                  | ⛔     | file                                                |
| POST /backup/restore                          | ⛔     | file                                                |
| GET /backup/restore/status                    | ⛔     | file                                                |
| GET /backup/restore/status/:jobId             | ⛔     | file                                                |
| GET /currencies                               | ➕ T6  | `get_user_currencies`                               |
| GET /currencies/base                          | ➕ T6  | `get_user_currencies`                               |
| GET /currencies/rates                         | ➕ T6  | `get_user_currencies`                               |
| POST /currencies                              | ➕ T6  | `add_user_currencies`                               |
| GET /currencies/custom                        | ➕ T1  | `list_custom_currencies`                            |
| GET /currencies/coingecko/search              | ➕ T2  | `search_coingecko_coins`                            |
| POST /currencies/custom                       | ➕ T1  | `create_custom_currency`                            |
| PUT /currencies/custom/:code                  | ➕ T1  | `update_custom_currency`                            |
| DELETE /currencies/custom/:code               | ➕ T1  | `delete_custom_currency`                            |
| POST /currencies/base                         | ➕ T6  | `change_base_currency` (first base)                 |
| PUT /currencies/:code/rate-source             | ➕ T2  | `set_currency_rate_source`                          |
| GET /currencies/:code/rate-history            | ➕ T2  | `get_currency_rate_history`                         |
| POST /currencies/:code/rate-source/test       | ➕ T2  | `test_currency_rate_source`                         |
| POST /currencies/change-base                  | ➕ T6  | `change_base_currency`                              |
| GET /currencies/change-base/status            | ➕ T6  | `get_base_currency_change_status`                   |
| PUT /currency                                 | ➕ T6  | `update_user_currency`                              |
| PUT /currency/rates                           | ➕ T2  | `set_exchange_rates`                                |
| DELETE /currency                              | ➕ T6  | `delete_user_currency`                              |
| DELETE /currency/rates                        | ➕ T2  | `delete_exchange_rates`                             |
| GET /settings                                 | ➕ T14 | `get_user_settings`                                 |
| PUT /settings                                 | ➕ T14 | `update_user_settings` (patch semantics)            |
| PATCH /settings                               | ➕ T14 | `update_user_settings`                              |
| GET /settings/onboarding                      | ⛔     | ui                                                  |
| PUT /settings/onboarding                      | ⛔     | ui                                                  |
| /settings/ai/connections (7 routes)           | ⛔     | ai                                                  |
| GET /settings/ai/cli/availability             | ⛔     | ai                                                  |
| /settings/ai/cli/auth-sessions (4 routes)     | ⛔     | ai (also admin and self-host only; PTY sign-in)     |
| /settings/ai/features (4 routes)              | ⛔     | ai                                                  |
| /settings/ai/custom-instructions (2 routes)   | ⛔     | ai                                                  |
| /ai/categorization/\* (4 routes)              | ⛔     | ai                                                  |
| GET /settings/mcp/connected-apps              | ⛔     | auth (the OAuth grants themselves)                  |
| DELETE /settings/mcp/connected-apps/:clientId | ⛔     | auth                                                |

**Currencies and rates outside `/user`** (3: ➕ 3)

- GET `/models/currencies` ➕ T6 `list_supported_currencies`;
- GET `/currencies/rates/pair` and GET `/currencies/rates/:date` (`exchange-rates.ts`) ➕ T6 `get_exchange_rate`.

**`/share`** (13: ➕ 4, ⛔ 9)

- ➕ T24: GET /invitations/sent and /invitations/received `list_share_invitations`; GET /resources/:type/:id/members `list_share_members`; GET /shared-with-me `list_shared_with_me`.
- ⛔ share: POST /invitations; POST /invitations/:token/accept; POST /invitations/:token/decline; POST /invitations/:id/resend; DELETE /invitations/:id; POST /invitations/:id/back-invite; PATCH and DELETE /resources/:type/:id/members/:userId; POST /shared-with-me/:type/:id/leave.

**`/bank-data-providers`** (21: ➕ 5, ⛔ 16)

- ➕ T24:
  - GET /connections and GET /connections/:connectionId → `list_bank_connections`;
  - GET /connections/:connectionId/sync-job-progress, GET /active-sync-jobs and GET /sync/status → `get_bank_sync_status`.
- ⛔ bank:
  - GET / (supported providers; only useful for connecting);
  - POST /:providerType/connect, DELETE /connections/:id, POST …/reauthorize, PATCH /connections/:id (name and credential refresh);
  - GET …/available-accounts, POST …/sync-selected-accounts, POST …/sync-transactions, POST …/sync;
  - POST …/reconcile-duplicates (part of every sync; manual review is T9), POST …/load-transactions-for-period;
  - GET /sync/check (can start a sync), POST /sync/trigger;
  - POST /enablebanking/countries and /banks (take the user's Enable Banking app key), POST /enablebanking/oauth-callback.

**`/import`** (29: ➕ 3, ⛔ 26)

- ➕ T25: GET /batches-history `list_import_batches`; DELETE /batch/:batchId `delete_import_batch`; GET /batch-delete/status `get_import_batch_delete_status`.
- ⛔ import: csv (5 routes), text-source (5), ynab (3), budget-bakers-wallet (4), ms-money (4), ofx (4), ai-map-categories (1).

**Other mounts** (⛔ all):

| Mount                            | Routes                               | Reason                                      |
| -------------------------------- | ------------------------------------ | ------------------------------------------- |
| `/auth` (better-auth-extensions) | signups-open, features, set-password | auth                                        |
| `/billing`                       | checkout, portal                     | account                                     |
| `/admin`                         | PATCH /users/:id/plan                | admin                                       |
| `/brand-logos`                   | GET /search                          | cosmetic                                    |
| `/resource-leases`               | POST /refresh                        | import (keeps an ms-money/ofx upload alive) |
| `/client-logs`                   | POST /                               | transport (frontend telemetry)              |
| `/sse`                           | GET /events                          | transport                                   |
| `/mcp`                           | POST, GET, DELETE /                  | transport (the MCP endpoint itself)         |
| `/webhooks`                      | POST /github, POST /billing          | transport                                   |
| `/github`, `/landing`, `/demo`   | GET /activity, POST /faq/ask, POST / | transport (public landing and demo)         |
| `/tests`                         | 3 routes                             | internal (mounted only in test)             |

OAuth metadata (`oauth-metadata.route.ts`) registers `app.get` routes outside the router count and is auth.

**Totals** (401 routes):

| Group            | Routes                                  |
| ---------------- | --------------------------------------- |
| ✅ covered today | 103                                     |
| ➕ planned       | 175 (Group B 4, Group C 6, Group A 165) |
| ⛔ excluded      | 123                                     |

Recount from the tables:

- ⛔: accounts 1, attachments 1, transactions 3, payees 1, subscriptions 1, investments 8, notifications 1, user 35, share 9, bank 16, import 26, other mounts 21.

  That sums to 123. "Other mounts" are auth 3, billing 2, admin 1, brand-logos 1, resource-leases 1, client-logs 1, sse 1, mcp 3, webhooks 2, github, landing and demo 3, tests 3.

Without a tool today: 298 routes, of which 175 get one and 123 stay out.

Planned new tools: 147 on the path to `dev` (B 4, C 6, A 137), plus about 10 in Group D. The server grows from 103 to about 250 tools.

### Excluded routes (reasons)

| Key       | Routes                                                                                                                                                                                                                           | Why no tool                                                                                                                                                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth      | `/auth/*`, OAuth metadata, `/user/settings/mcp/connected-apps*`                                                                                                                                                                  | Sign-in, password and OAuth-grant management. An MCP client must not manage its own grants; revoking stays in Settings.                                                                                                                                                           |
| account   | billing checkout and portal, feature trials, profile update, user delete, data wipe                                                                                                                                              | Account lifecycle and payment redirects. There is no `profile:write` scope, and deleting or wiping the account must stay a deliberate in-app action.                                                                                                                              |
| admin     | `/admin/*`, securities price sync, upload info and bulk upload                                                                                                                                                                   | Operator-only routes behind `adminOnly`.                                                                                                                                                                                                                                          |
| internal  | `/tests/*`, `POST /notifications`, `PUT /investments/portfolios/:id/balance`                                                                                                                                                     | Test-only or test seeding routes, or a route background jobs use.                                                                                                                                                                                                                 |
| transport | `/mcp`, `/sse`, `/webhooks/*`, `/client-logs`, `/github`, `/landing`, `/demo`                                                                                                                                                    | Transports, signed webhooks, telemetry and public pages.                                                                                                                                                                                                                          |
| bank      | connect, reauthorize, OAuth callback, Enable Banking country and bank lists, available accounts, account link, every sync and load action, stuck-pending check, disconnect, connection edit, reconcile-duplicates, provider list | These need the bank's consent flow or a live bank call, which needs the user present (PSU headers). Unattended calls can burn the bank's daily limit (about 4 per day for Enable Banking). Some take the user's provider secrets. Read-only connection and sync status is in T24. |
| file      | attachment download, data export, backups and restore, invoice matching                                                                                                                                                          | These move file bytes. An MCP client cannot stream them, and base64 through the model context is costly and leaks documents into transcripts. Uploads already use `create_attachment_upload_url`.                                                                                 |
| import    | csv, text-source, ynab, budget-bakers-wallet, ms-money, ofx, investment statement import, ai-map-categories, resource leases                                                                                                     | These are interactive wizards (parse, map, review duplicates, execute) built around a file. Some spend the server's AI on extraction. An agent records rows through `create_transaction` / `create_investment_transaction`, and can undo an import through T25.                   |
| share     | invitation create, accept, decline, resend, cancel, back-invite; member update and revoke; leave                                                                                                                                 | They grant or revoke another person's access to financial data, and send email. That stays a deliberate in-app action. The reads are in T24.                                                                                                                                      |
| ai        | `/user/settings/ai/*`, `/user/ai/categorization/*`                                                                                                                                                                               | They configure the app's own AI providers (API keys, models, CLI sign-in) and its built-in categorizer. Keys must not pass through a third-party client, and the client categorizes through `bulk_update_transactions`.                                                           |
| ui        | onboarding checklist                                                                                                                                                                                                             | UI state with no data meaning.                                                                                                                                                                                                                                                    |
| cosmetic  | logo search, payee and subscription logo reset                                                                                                                                                                                   | Visual pickers an agent cannot see. Logo fields stay settable through the update tools.                                                                                                                                                                                           |
| redundant | `GET /investments/securities`                                                                                                                                                                                                    | The full global securities list. `search_securities` covers lookup.                                                                                                                                                                                                               |

**Apple Pay (Group D) exclusions:**

- token minting (`POST /user/settings/ingest-tokens`) and the setup code: they return a long-lived secret into a third-party transcript;
- access headers: secrets;
- `POST /api/v1/ingest/card-payment`: a machine endpoint behind ingest-token auth; `create_transaction` covers manual entry.

## What Goes Where

- **Implementation Steps:** all tool code, service extractions, unit tests, metafiles, the skill update and docs, in this repo on the branch each task names, with merges into `dev`.
- **Post-Completion:** the deployment and a live smoke test against the ritchie instance, and the tool-count decision.

## Implementation Steps

### Group B: `feat/custom-currencies`

### Task 1: Custom currency tools

**Branch:** `feat/custom-currencies`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-currencies`. Run `git switch feat/custom-currencies` first.

- That worktree has `fix/cloudflare-access-cookie` checked out with uncommitted changes. Switch only once `git status` is clean; otherwise stop and ask the owner.
- The main checkout cannot take this branch while the worktree holds it.

**Files:**

- Create: `packages/backend/src/services/mcp/tools/{list-custom-currencies,create-custom-currency,update-custom-currency,delete-custom-currency}.ts`, `packages/backend/src/services/mcp/tools/custom-currency-tools.unit.ts`
- Modify: `tools/helpers.ts` and `tools/helpers.unit.ts` (the lock helper), the four metafiles, `tool-scopes-drift.unit.ts` (no list change expected)

- [x] read first: the `add-mcp-tool` skill, `controllers/currencies/custom-currencies.ts`, `services/currencies/custom-currencies.service.ts` on this branch, and `tools/transaction-amount-inputs.unit.ts` for the capture pattern. `tests/helpers/mcp-tools.ts` (Task 3) does not exist on this branch, so use a local capture helper in the test file.
- [x] `assertBaseCurrencyUnlocked({ userId })` in `tools/helpers.ts` (Technical Details, "Helpers added in Tasks 1–3"), with the `helpers.unit.ts` cases: lock set → throws; Redis error → throws the unavailable message; unlocked → passes. The three custom-currency writes call it right after `requireScope`, as their REST routes carry `checkBaseCurrencyLock`. This branch is an upstream PR candidate, so its tools must not ship without the lock.
- [x] `list_custom_currencies` (read): `listCustomCurrencies({ userId })`; code, name, symbol, decimals and logo as the REST list returns them.
- [x] `create_custom_currency` (`finance:write`):
  - `code`, `name`, `decimals` (int in the REST bounds), `symbol?`, using the controller's strict schema (export it if it is local);
  - an ISO code or a duplicate gives the REST error message;
  - the description says custom currencies are per user and need a rate source for base-currency values.
- [x] `update_custom_currency` (`finance:write`):
  - `code`, plus optional `name`, `decimals`, `symbol` (null clears) and `logoUrl` (null clears) if the branch's schema has it;
  - the description says a decimals change is refused while the user has rows in the currency.
- [x] `delete_custom_currency` (`finance:delete`): `code`; refused while in use, as REST does.
- [x] unit test `custom-currency-tools.unit.ts`: the schema cases (an invalid code, decimals out of range); the scope and refusal for each write tool; each write tool throwing while the lock is set with its service mock not called; service args; read output passthrough.
- [x] metafiles: register in `server.ts` under a new `// Currencies` group, then the `server-card.json` entries, the SKILL.md rows and the sha256.
- [x] gate:
  - unit: `npm run test:unit -- --testPathPattern='services/mcp/'`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/currencies/(custom-currencies|custom-currency-isolation|custom-currency-transactions)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - backend typecheck, lint, oxfmt.

**Merge:** once Task 1 passes, merge `feat/custom-currencies` into `feat/currency-rate-sources`. Run it in the main checkout: `git switch feat/currency-rate-sources` (only with a clean tree), then `git merge feat/custom-currencies`. `feat/currency-rate-sources` already contains the rest of `feat/custom-currencies` and has not changed the MCP files since, so no conflicts are expected. Then run Task 1's unit gate there.

### Group C: `feat/currency-rate-sources`

### Task 2: Rate source, rate history and dated rate tools

**Branch:** `feat/currency-rate-sources`

**Worktree:** the main checkout `/Users/nemirovsky/Developer/moneymatter`, on this branch (`git switch feat/currency-rate-sources` first if it is not, with a clean tree)

**Files:**

- Create:
  - `packages/backend/src/services/common/user-rate-limits.ts` (the shared limits);
  - `packages/backend/src/services/mcp/tools/{search-coingecko-coins,get-currency-rate-history,set-currency-rate-source,test-currency-rate-source,set-exchange-rates,delete-exchange-rates}.ts`;
  - `tools/rate-source-tools.unit.ts`;
  - `packages/backend/src/services/currencies/rate-sources/save-rate-source.service.ts`;
  - `packages/backend/src/services/user-exchange-rate/exchange-rate-pair-rules.ts` (the shared pair rules).
- Modify: `controllers/currencies/rate-source.ts` (calls the new service), `controllers/currencies/edit-currency-exchange-rate.ts` and `controllers/user.controller.ts` (both rely on the shared rules; the opposite-pair check for rate removal leaves the controller), `services/user-exchange-rate/update-exchange-rates.service.ts` and `remove-exchange-rates.service.ts` (enforce the rules), `services/user-exchange-rate/update-exchange-rates.service.e2e.ts` (new removal case), `services/currencies/rate-sources/rate-source.e2e.ts` (new test-limiter case), `middlewares/rate-limit.ts` (reads the shared limits), `tools/helpers.ts` and `tools/helpers.unit.ts` (the limiter helper), the four metafiles, `tool-scopes-drift.unit.ts` (`DESTRUCTIVE_TOOLS` unchanged: `delete_exchange_rates` is covered by its prefix; `test_currency_rate_source` is lock-exempt, as its route has no lock; Task 3 lists it in `LOCK_EXEMPT_TOOLS`)

- [x] read first: `controllers/currencies/rate-source.ts`, `controllers/currencies/rate-history.ts`, `controllers/currencies/edit-currency-exchange-rate.ts`, `removeUserCurrencyExchangeRate` in `controllers/user.controller.ts`, `services/currencies/rate-sources/index.ts` (the `updateRateSourceBodySchema` union), `middlewares/rate-limit.ts` (`rateSourceSaveRateLimit`, `rateSourceTestRateLimit`)
- [x] e2e first, before the move (test-first): `update-exchange-rates.service.e2e.ts` already covers the edit rules ("rejects an unknown code, an identical base/quote pair and a missing inverse pair") but no case sends a one-sided removal, because every delete call sends both directions. Add a REST case: `DELETE /user/currency/rates` with a single pair returns 422 with the opposite-pair message. Run it green against the unmoved controller.
- [x] `exchange-rate-pair-rules.ts`: move the rules out of the controllers into one module that the services call.
  - edit: `baseCode !== quoteCode` and every pair has its opposite in the same call (`rate > 0` and the strict pair object stay in the body shape, which the controller and the tool's schema both declare);
  - remove: every pair has its opposite;
  - `editUserExchangeRates` and `removeUserExchangeRates` enforce them and throw `ValidationError` with the controllers' current messages;
  - the controllers keep only the shape of the body, so REST status codes and messages are unchanged;
  - the MCP tools get the rules by calling the services.
- [x] `save-rate-source.service.ts`:
  - `saveCurrencyRateSource({ userId, code, body })` runs `setCurrencyRateSource`, then the follow-ups the controller runs today: the CoinGecko backfill after commit, or the HTTP first fetch;
  - the controller calls it;
  - the REST behaviour is unchanged.
- [x] e2e first, before the middleware change (test-first): `rate-source.e2e.ts` has a 429 case only for the save limiter ("limits how often a user saves a source", 21 PUTs). Add a case for `POST /user/currencies/:code/rate-source/test`: 20 calls succeed and the 21st returns 429. Run it green against the unmoved middleware.
- [x] per-user limiter shared with REST, so this branch ships the tools with REST's limits:
  - `services/common/user-rate-limits.ts` exports `RATE_SOURCE_SAVE_LIMIT` and `RATE_SOURCE_TEST_LIMIT` (`prefix`, `windowSeconds: 60`, `maxAttempts: 20`, key `${prefix}:user:${userId}`, the keys REST uses today: `rate-source-save`, `rate-source-test`);
  - `middlewares/rate-limit.ts` builds `rateSourceSaveRateLimit` and `rateSourceTestRateLimit` from them, so the budgets are defined once and the middleware and the tools share one counter per user;
  - `enforceUserRateLimit({ userId, limit })` in `tools/helpers.ts` (Technical Details) wraps `RateLimitService.checkRateLimit`;
  - unit cases in `helpers.unit.ts`: refused → throws the `middleware.tooManyRequests` message; allowed → passes; Redis down → passes.
- [x] `search_coingecko_coins` (read): `query` (1–100) → `searchCoingeckoCoins`. A missing `COINGECKO_API_KEY` gives the REST "not available" message.
- [x] `get_currency_rate_history` (read): `code`, `limit` (1–100, default 30), `offset` → `listCurrencyRateHistory`.
- [x] `set_currency_rate_source` (`finance:write`): `code` plus the `updateRateSourceBodySchema` fields (`rateSource`, `config`, `logoUrl?` for CoinGecko). Calls `saveCurrencyRateSource`. Header values for the HTTP source are accepted but never echoed (the service already returns only `headerNames`). Its REST route carries `checkBaseCurrencyLock` and is rate-limited (20 per minute per user), so the tool calls `assertBaseCurrencyUnlocked` (from Task 1, merged into this branch) and `enforceUserRateLimit` with `RATE_SOURCE_SAVE_LIMIT`, so an agent cannot repeat CoinGecko backfills, outbound fetches and full re-valuations without bound.
- [x] `test_currency_rate_source` (`finance:write`, a preview that saves nothing; its route has no lock, so it is lock-exempt): `code`, `config`, `date?` → `testHttpRateSource`. Returns `{ ok, … }` as REST does. It calls `enforceUserRateLimit` with `RATE_SOURCE_TEST_LIMIT` (it fetches a URL the user typed) and no lock check.
- [x] `set_exchange_rates` (`finance:write`, `assertBaseCurrencyUnlocked`, as `PUT /user/currency/rates` carries the lock):
  - `pairs[]` of `{ baseCode, quoteCode, rate > 0, effectiveDate? }` (a strict pair object) → `editUserExchangeRates`, which enforces the shared pair rules, so a one-sided or same-code call is refused exactly as REST refuses it;
  - the description says each pair needs its opposite in the same call, and `effectiveDate` applies only to custom currencies.
- [x] `delete_exchange_rates` (`finance:delete`, `assertBaseCurrencyUnlocked`, as its route carries the lock): `pairs[]` of `{ baseCode, quoteCode, effectiveDate? }`. No `effectiveDate` removes all of a pair's rates. Calls `removeUserExchangeRates`, which enforces the opposite pair itself.
- [x] unit test `rate-source-tools.unit.ts`: the schema union (each source, an invalid config), scopes, service args, and that `set_currency_rate_source` calls `saveCurrencyRateSource`. The pair rules are covered at the service level: unit cases in `exchange-rate-pair-rules` (or the service's unit file) reject a one-sided pair and a same-code pair for edit, and a one-sided pair for remove; the tool's schema cases cover a non-positive rate and an unknown key. Rate-source unit cases: `set_currency_rate_source` and `test_currency_rate_source` throw when their limiter refuses (service mock not called) and use their own limit; the middleware and the tools read the same constants; `set_currency_rate_source`, `set_exchange_rates` and `delete_exchange_rates` throw while the lock is set, and `test_currency_rate_source` does not check it.
- [x] metafiles under the `// Currencies` group.
- [x] gate: (done on `feat/currency-rate-sources`: 308 unit tests, 196 e2e tests, the e2e pattern also ran `routes/base-currency-guard-coverage`)
  - unit: `npm run test:unit -- --testPathPattern='services/(mcp/|currencies/rate-sources/|user-exchange-rate/)'`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/currencies/rate-sources/(rate-history|rate-source|http-rate-source|coingecko-rate-source)|services/user-exchange-rate/(dated-user-exchange-rates|update-exchange-rates)|services/mcp/(connected-apps|mcp-scope-gate)'` (the new removal case is in `update-exchange-rates`);
  - backend typecheck, lint, oxfmt.

**Merge:** once Task 2 passes, merge `feat/currency-rate-sources` into `dev` in the main checkout: `git switch dev`, then `git merge feat/currency-rate-sources`. Done: merged cleanly into `dev` (a531e9bb) with no conflicts; the unit gate (308 tests) and backend typecheck pass on `dev`. The batched e2e run on `dev` was not repeated.

- `dev`'s MCP files changed only in five stats tools, which this group does not touch, so a conflict there is unexpected. If one appears, follow "Merge conflicts" in Technical Details.
- Run Task 1's and Task 2's unit and e2e patterns as one batched run on `dev`.
- Leave the main checkout on `dev`.

### Group A: `feat/mcp-coverage`

### Task 3: Groundwork: write guards, registration drift and the skill

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `packages/backend/src/tests/helpers/mcp-tools.ts`, `packages/backend/src/services/mcp/server-registration-drift.unit.ts`, `packages/backend/src/services/mcp/tools/write-guards.unit.ts`, `packages/backend/src/services/mcp/auth.unit.ts` (added: covers the `features` field)
- Modify: `tools/custom-currency-tools.unit.ts`, `tools/rate-source-tools.unit.ts`, `tools/transaction-amount-inputs.unit.ts`, `tools/helpers.ts`, `tools/helpers.unit.ts`, `services/mcp/auth.ts`, `tool-scopes-drift.unit.ts`, every existing write tool in `tools/`, `tools/preview-transaction-automation.ts`, `.claude/skills/add-mcp-tool/SKILL.md`

- [x] `git merge dev`. It brings Groups B and C and dev's decimals changes to five stats tools. Resolve per "Merge conflicts" if needed, then run the drift suites. (Done: merged with no conflicts, c5097f07.)
- [x] `requireFeatureAccess` in `tools/helpers.ts` (Technical Details, "Helpers added in Tasks 1–3"; `assertBaseCurrencyUnlocked` and `enforceUserRateLimit` arrived with Tasks 1 and 2). Unit cases in `helpers.unit.ts` cover: feature missing → throws; feature present → passes; `features` absent from the auth payload → throws.
- [x] `services/mcp/auth.ts`: add `features: Feature[]` to `McpAuthInfo.extra` and fill it from the `getEntitlementsByUserId` result that already supplies `readOnly` (no second call). Extend the existing auth unit or e2e coverage (`mcp-scope-gate`/`connected-apps` suites build `authInfo`) if it asserts the `extra` shape. `feat/apple-pay-ingest` also edits this file (the `hashToken` move), so Task 26's merge keeps both changes.
- [x] `requireScope` gets `allowReadOnly` (default false). Unit cases in `helpers.unit.ts`:
  - default: read-only user throws, demo user throws (unchanged);
  - `allowReadOnly: true`: a read-only user passes, a demo user passes, a missing scope still throws.
- [x] rate-limit audit: no other route that gets a tool carries a limiter (`attachmentUploadRateLimit` guards the byte upload, not `create_attachment_upload_url`). Re-check with `grep -n RateLimit routes/*.ts` and record any new find here; a new find gets `enforceUserRateLimit` and shared limit constants like Task 2's. The two rate-source tools already carry their limits from Task 2. Audit result: no new find. Every other limiter (`routes/*.ts` and `routes/import-export/*.ts`) sits on a route that is excluded or has no tool: brand-logo search, demo start, billing, client logs, landing FAQ, price sync and bulk upload (admin), resource-lease refresh, share invitation sends, attachment byte upload, the CSV, OFX, YNAB, MS Money and Wallet import wizards, AI connection probes, data export, backup and restore, Stripe webhook.
- [x] `tests/helpers/mcp-tools.ts` with `captureTools` and `makeExtra`. Import it in unit tests as `@tests/helpers/mcp-tools`.
- [x] migrate the hand-rolled fake servers onto it, so no copy survives: after `git merge dev`, switch `tools/custom-currency-tools.unit.ts` (Task 1), `tools/rate-source-tools.unit.ts` (Task 2) and `tools/transaction-amount-inputs.unit.ts` (its `inputSchemaOf`) to `captureTools` and `makeExtra`. Their assertions stay as they are; run the unit gate to confirm.
- [x] call `await assertBaseCurrencyUnlocked({ userId })` right after `requireScope` in every existing write tool whose REST counterpart carries `checkBaseCurrencyLock`. The Group B and C tools (Tasks 1 and 2) already do; confirm them and add the rest.
  - Check each route in `routes/*.ts`. A tool whose route has no lock (for example `test_currency_rate_source`, `detect_subscription_candidates`, a GET in REST, and `create_attachment_upload_url` if its upload route has none) goes into `LOCK_EXEMPT_TOOLS`, with a comment naming the route. Done: 66 existing write tools now call the lock; the three exempt ones are `create_attachment_upload_url` (its upload route has no lock), `detect_subscription_candidates` and `test_currency_rate_source`. Tasks 4 and later add their own exempt tools to the list.
- [x] the lock-carrying reads: the lock follows the REST route, so call `assertBaseCurrencyUnlocked` in the existing `preview_transaction_automation` (`POST /automations/preview`) and list it in `LOCK_GUARDED_READ_TOOLS` with the route in a comment. Task 8 adds `list_transfer_suggestions` (`POST /transactions/transfer-recommendations/bulk-scan`) to the same list. Re-check `routes/*.ts` for any other `checkBaseCurrencyLock` on a route that a read-named tool wraps, and add it.
- [x] `tool-scopes-drift.unit.ts`:
  - new case "every tool that checks a scope also checks the base-currency lock, unless listed in `LOCK_EXEMPT_TOOLS`";
  - a case "every tool in `LOCK_GUARDED_READ_TOOLS` calls `assertBaseCurrencyUnlocked`". This case keys on the route mapping, not on `requireScope`, which read tools never call;
  - a case that every `LOCK_EXEMPT_TOOLS` and `LOCK_GUARDED_READ_TOOLS` entry exists, and that no tool is in both;
  - a case that every tool calling `allowReadOnly: true` is in a hand-kept `READ_ONLY_ROUTE_TOOLS` list (`mark_notifications_read`, `update_user_settings`, `change_base_currency`), each with the `READ_ONLY_ROUTES` entry in a comment, so the exemption cannot spread;
  - export nothing new.
- [x] `server-registration-drift.unit.ts`: every `export function register\w+` in `tools/*.ts` (and `venture-tools.ts` re-exports) is imported and called as `register…(server)` exactly once in `server.ts`, and `server.ts` calls nothing that is not exported.
- [x] `write-guards.unit.ts`: with `captureTools`, `archive_account`, `delete_tag` and `create_transaction` throw while the lock is set, and their service mocks are not called. Each also throws for a demo user and for a read-only user. `preview_transaction_automation` throws while the lock is set.
- [x] update `.claude/skills/add-mcp-tool/SKILL.md`:
  - the template with `requireScope`, `assertBaseCurrencyUnlocked`, `requireFeatureAccess` and `enforceUserRateLimit`;
  - the naming and scope rules (Technical Details, "Tool conventions"), including `allowReadOnly` for `READ_ONLY_ROUTES` tools;
  - `DESTRUCTIVE_TOOLS`, `CONDITIONAL_DELETE_TOOLS`, `LOCK_EXEMPT_TOOLS`, `LOCK_GUARDED_READ_TOOLS` and `READ_ONLY_ROUTE_TOOLS`;
  - "mirror the REST route: same service, validation, lock, feature gate, rate limit and read-only handling; move controller-only logic into a service or shared schema instead of copying it";
  - refined inputs: expose the shared schema's `.shape` and enforce refinements in the handler (Technical Details, "Refined inputs");
  - the unit test pattern with `captureTools` from `@tests/helpers/mcp-tools`;
  - the drift suites (four) and the gate pattern `services/mcp/`;
  - replace "do not add e2e tests" with: the gate runs the MCP e2e suites plus the REST suites of the wrapped routes, and a check moved out of a controller gets an e2e case first.
- [x] gate (done: 141 unit tests in 11 suites, 28 e2e tests in 4 suites, backend typecheck, lint and oxfmt clean):
  - unit: `npm run test:unit -- --testPathPattern='services/mcp/'`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='routes/base-currency-guard-coverage|services/currencies/change-base-currency-status|services/mcp/(connected-apps|mcp-scope-gate)'` (the rate-source limiter cases moved to Task 2);
  - backend typecheck, lint, oxfmt.

### Task 4: Account tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-account,create-account,update-account,delete-account,unlink-account-from-bank-connection}.ts`, `tools/account-tools.unit.ts`, `tools/account-output.ts` (shared account presenter), `controllers/accounts/account-body.schema.ts`, `services/accounts/assert-account-update-allowed.ts`
- Modify: `services/accounts.service.ts` (or a new `services/accounts/assert-account-update-allowed.ts`), `controllers/accounts.controller.ts`, the four metafiles

- [x] read first: `controllers/accounts.controller.ts` (`getAccountById`, `createAccount`, `updateAccount`, `deleteAccount`), `controllers/accounts/unlink-from-bunk-connection.ts`, `services/accounts/transaction-count.ts`, `serializers.ts#slimAccountsForMcp`
- [x] move the controller-only update checks into the service path, used by REST and MCP alike (`services/accounts/assert-account-update-allowed.ts`; the body schemas moved to `controllers/accounts/account-body.schema.ts`, so REST and MCP accept the same input):
  - `currentBalance` only on system accounts;
  - no move into or out of the `vehicle` category.
  - e2e coverage check: `accounts.controller.e2e.ts` had the `currentBalance` refusal and the move into vehicle, but no case for a move out of vehicle. Added "rejects moving a vehicle account out of the vehicle category" first and ran it green against the unmoved controller (37 passed), then moved.
- [x] `get_account` (read): `accountId` → `getAccountById`, `attachAccountCurrencyMeta`, `serializeAccount`, slimmed, plus `transactionCount` from `getAccountTransactionCount`. Not found gives a clear error.
- [x] `create_account` (`finance:write`):
  - `name`, `currencyCode`, `accountCategory` (`ACCOUNT_CATEGORIES`, default `general`), `initialBalance`, `creditLimit` (≥ 0), logo fields (`logoFieldsShape`);
  - `type` is always `system`;
  - amounts through `Money.fromDecimal` as the controller does.
- [x] `update_account` (`finance:write`): `accountId`, plus optional `name`, `accountCategory`, `creditLimit`, `excludeFromStats`, `currentBalance`, `initialBalance` and logo fields. `status` stays with `archive_account`, and the description says so.
- [x] `delete_account` (`finance:delete`): `accountId`, `removePortfolioTransfers?` → `deleteAccountById`.
- [x] `unlink_account_from_bank_connection` (`finance:write`): `accountId` → `unlinkAccountFromBankConnection`. The description says the account becomes manual and keeps its history.
- [x] unit test `account-tools.unit.ts`, covering the moved checks through `update_account`.
- [x] metafiles under `// Profile & accounts` (`server.ts`, `server-card.json`, SKILL.md rows, sha256). `slimAccountDetailForMcp` added to `serializers.ts` with its unit test.
- [x] gate:
  - unit: `npm run test:unit -- --testPathPattern='services/mcp/'`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='controllers/accounts.controller|services/accounts/(archive-account|delete-account|transaction-count|balance-adjustment|account-brand-logos)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - backend typecheck, lint, oxfmt.

### Task 5: Account group tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `controllers/account-groups/account-group-body.schema.ts` (shared create and update bodies), `tools/account-group-output.ts` (presenter), `tools/{get-account-groups,create-account-group,update-account-group,delete-account-group,add-account-to-group,remove-accounts-from-group,move-account-group}.ts`, `tools/account-group-tools.unit.ts`
- Modify: `controllers/account-groups/{create-account-group,update-group}.ts` (use the shared schema), `services/mcp/serializers.ts` (`slimAccountGroupsForMcp`, `slimAccountGroupForMcp`) and its unit test, the four metafiles

- [x] read first: `routes/account-groups.ts`, `controllers/account-groups/*`, `services/account-groups/*`, `serializeAccountGroups`
- [x] `get_account_groups` (read): `includeArchived?`, `accountIds?` → `getAccountGroups`. With `groupId` it returns that group's accounts (`getAccountsInGroup`). Serialized as REST does, then slimmed: a flat list where every group has `parentGroupId`, a `path` of names from the top ("Savings > Emergency"; a leading "…" means an ancestor is missing from the list because `accountIds` filtered it out), `childGroups` stubs (id, name) and slimmed accounts. With `groupId` it returns `{ groupId, accountIds }`; combining `groupId` with a list filter is refused instead of ignoring the filter.
- [x] `create_account_group` (`finance:write`): `name`, `parentGroupId?` (nullable), logo fields.
- [x] `update_account_group` (`finance:write`): `groupId` plus the same fields, optional. It returns the single group, not REST's one-element array.
- [x] `delete_account_group` (`finance:delete`): `groupId`.
- [x] `add_account_to_group` (`finance:write`): `groupId`, `accountId`.
- [x] `remove_accounts_from_group` (`finance:write`): `groupId`, `accountIds[]`.
- [x] `move_account_group` (`finance:write`): `groupId`, `newParentGroupId` (null for top level) → `moveAccountGroup`. A zero update count means not found. The description says it moves a group, not an account.
- [x] unit test `account-group-tools.unit.ts`.
- [x] metafiles under a new `// Account groups` group.
- [x] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/account-groups/(account-groups|account-group-membership)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 6: Currency settings and exchange rate tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create:
  - `tools/{get-user-currencies,list-supported-currencies,get-exchange-rate,add-user-currencies,update-user-currency,delete-user-currency,change-base-currency,get-base-currency-change-status}.ts`;
  - `tools/currency-settings-tools.unit.ts`;
  - `services/currencies/start-base-currency-change.service.ts`.
- Modify: `controllers/currencies/change-base-currency.controller.ts`, `services/currencies/change-base-currency.service.e2e.ts` (new unsupported-currency case), the four metafiles, `tool-scopes-drift.unit.ts` (`LOCK_EXEMPT_TOOLS`: `change_base_currency`, which is exempt only in its change branch; `READ_ONLY_ROUTE_TOOLS`: `change_base_currency`, for its first-base branch)

- [x] read first: `controllers/user.controller.ts` (the currency handlers), `controllers/currencies/add-user-currencies.ts`, `change-base-currency.controller.ts`, `change-base-currency-status.controller.ts`, `controllers/exchange-rates/{pair-rate,rates-for-date}.controller.ts`, `controllers/currencies.controller.ts`
- [x] e2e first, before the move (test-first): no e2e case asserts the `currencies.notSupportedForBaseCurrency` refusal (the existing "rejects a trivially-invalid change" case covers only a same-currency change). Add a REST case to `change-base-currency.service.e2e.ts`: `POST /user/currencies/change-base` with an ISO code the registry does not support for historical data returns 422 with that message and takes no lock. Pick the code from `exchangeRateProviderRegistry.getSupportedCurrenciesForHistoricalData()`. Run it green against the unmoved controller. Done: the case is "rejects an ISO code without historical rate coverage with the supported list, and takes no lock"; it passed against the unmoved controller (8 passed), then stayed green after the move.
- [x] `start-base-currency-change.service.ts`: move the controller's `isCurrencySupportedForHistoricalData` check and `enqueueBaseCurrencyChange` behind one function. The controller calls it. (Also moved the add, edit and delete user-currency bodies into `controllers/currencies/user-currency-body.schema.ts`, so REST and the tools accept the same input.)
- [x] `get_user_currencies` (read): `getUserCurrencies`, `getUserBaseCurrency` and `getUserExchangeRates` in one result, with custom-currency metadata as the REST list returns it.
- [x] `list_supported_currencies` (read): `getAllSystemCurrencies()`.
- [x] `get_exchange_rate` (read): `date` (YYYY-MM-DD), `from?`, `to?`.
  - With both codes: `assertCurrencyCodesVisible`, then `getExchangeRate({ requireUserConnection: false })`. `ExchangeRateUnavailableError` becomes a clear "no rate" error.
  - With neither: `getExchangeRatesForDate`, the global rates.
  - One code alone is a schema error.
- [x] `add_user_currencies` (`finance:write`): `currencies[]` of `{ currencyCode, exchangeRate?, liveRateUpdate? }`.
- [x] `update_user_currency` (`finance:write`): `currencyCode`, `exchangeRate?`, `liveRateUpdate?` → `editUserCurrency`.
- [x] `delete_user_currency` (`finance:delete`): `currencyCode` → `deleteUserCurrency`.
- [x] `change_base_currency` (`finance:write`): `newCurrencyCode` (ISO). The two branches follow two different REST routes, so their guards differ. Resolve the branch first (a read of the user's base currency), then guard:
  - A user without a base (`POST /user/currencies/base`, which is in `READ_ONLY_ROUTES` and carries `checkBaseCurrencyLock`): `requireScope` with `allowReadOnly: true`, then `assertBaseCurrencyUnlocked`, then `setBaseUserCurrency`. A read-only user can set the first base, as REST allows for onboarding.
  - Otherwise (`POST /user/currencies/change-base`, not in `READ_ONLY_ROUTES`, no lock because the enqueue owns its own NX lock): plain `requireScope` (a read-only user is refused), no lock check, then the new service, which returns `{ jobId, state }`.
  - The description warns that the change recalculates all history and blocks other edits until it finishes. It points to `get_base_currency_change_status`.
- [x] `get_base_currency_change_status` (read): `getBaseCurrencyChangeStatus`.
- [x] unit test `currency-settings-tools.unit.ts`: the `get_exchange_rate` modes, both `change_base_currency` branches, and per branch the guards: first base passes for a read-only user and throws while the lock is set; change-base throws for a read-only user and does not check the lock.
- [x] metafiles under `// Currencies`.
- [x] gate (done: 260 unit tests in 14 suites, 57 e2e tests in 8 suites, backend typecheck, lint and oxfmt clean):
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/currencies/(add-user-currency|change-base-currency\.service|change-base-currency-status|currency-code-validation)|services/user-exchange-rate/(get-exchange-rate-pair|get-user-exchange-rates)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 7: Transaction reads, planned confirmation, bulk delete and attachments

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-transactions,get-transactions-summary,get-planned-summary,confirm-planned-transaction,bulk-delete-transactions,get-transaction-links,list-transaction-attachments,delete-attachment}.ts`, `tools/transaction-read-tools.unit.ts`, `services/payees/get-payee-names.ts`
- Modify:
  - `tools/search-transactions.ts` (`isPlanned` and `payeeIds` filters; the description explains `endDate` for future plans);
  - `services/mcp/serializers.ts` and `tools/get-transaction-groups.ts` (transactions carry their payee, see below);
  - `controllers/transactions.controller/transaction-filters.ts` (export the filter fields and `toServiceFilters` if they are local);
  - the four metafiles;
  - `tool-scopes-drift.unit.ts`: `DESTRUCTIVE_TOOLS` gets `bulk_delete_transactions`; `LOCK_EXEMPT_TOOLS` gets `delete_attachment` (its REST route has no lock).

- [x] read first: `controllers/transactions.controller.ts` (`getTransactionById`, `getTransactionsByTransferId`), `get-transactions-by-ids.ts`, `get-transactions-summary.ts` and `get-planned-summary.ts` on `dev` (summary sums in base minor units), `bulk-delete.ts`, `update-transaction.ts`, `services/transactions/update-transaction.ts` (planned guards), `frontend/src/pages/records/components/upcoming-section.vue`, `controllers/attachments.controller.ts`
- [x] `get_transactions` (read):
  - `ids` (1–50, the service's `MAX_IDS`) or `transferId`, and `includeSplits?`;
  - `getTransactionsByIds`, `getTransactionById` or `getTransactionsByTransferId`;
  - serialized like `search_transactions`;
  - exactly one of `ids` and `transferId`.
- [x] `get_transactions_summary` (read): the transaction filter fields (dates, types, account, category, tag and payee ids, the amount range, `isPlanned`, …) through `toServiceFilters` → `getTransactionsSummary`.
- [x] `get_planned_summary` (read): `getPlannedSummary({ userId })`.
- [x] `confirm_planned_transaction` (`finance:write`):
  - `transactionId`, `time?` → `updateTransaction({ isPlanned: false, time })`;
  - when `time` is absent and the plan is in the future, it sets now, as the web app does;
  - the service's refusal on bank-connected accounts passes through with its message;
  - the description says bank plans are confirmed by sync, and that confirming settles a linked subscription period.
- [x] `search_transactions`: optional `isPlanned` boolean passed to `getTransactions`, and an optional `payeeIds` array (`recordId()` items) passed to `getTransactions` as `payeeIds` (the query already filters on it). A live check of the deployed server showed that the merchant appears only in a transaction's note, because `slimTransactionsForMcp` drops the payee.
- [x] payee on every MCP transaction:
  - `services/payees/get-payee-names.ts`: `getPayeeNames({ userId, payeeIds })` returns `Map<id, name>` in one query, scoped to the caller as `get_payees` is;
  - `slimTransactionsForMcp` takes the map and adds `payeeId` and `payee: { id, name }` (`null` when the transaction has no payee or the payee is not the caller's);
  - `search_transactions`, `get_transactions` and `get_transaction_groups` fetch the names for the page of results and pass them in, so no tool serializes a transaction without its payee;
  - the descriptions say the result carries the payee, and that `payeeIds` filters by it (`get_payees` resolves a name to an id);
  - tests: `serializers.unit.ts` (payee present, absent, unknown id), `transaction-read-tools.unit.ts` (`search_transactions` passes `payeeIds` to `getTransactions` and returns `payee`; `get_transactions` returns `payee`), and a unit case for `getPayeeNames` (one query, other users' payees excluded).
- [x] `bulk_delete_transactions` (`finance:delete`): `transactionIds` or `filters` (+ `excludedIds`), not both → `resolveBulkTargetIds` + `bulkDelete`. The service's refusals (bank rows, the max count) pass through.
- [x] `get_transaction_links` (read): `transactionId` → `{ portfolioLink, ventureLink }` from `getTransactionPortfolioLink` and `getTransactionVentureLink`.
- [x] `list_transaction_attachments` (read): `transactionId` → `listAttachments`.
- [x] `delete_attachment` (`finance:delete`, lock-exempt, `requireFeatureAccess` `attachments`): `attachmentId` → `deleteAttachment`.
- [x] unit test `transaction-read-tools.unit.ts`: the `get_transactions` modes, the confirm time rule (past plan keeps its time, future plan gets now), the bulk-delete either-or, the attachment feature gate, the `isPlanned` passthrough.
- [x] metafiles under `// Transactions`.
- [x] gate (unit `services/mcp/` + payees: 16 suites, 312 tests; e2e: 10 suites, 141 tests; typecheck, lint, oxfmt clean):
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/transactions/(bulk-delete|planned-summary|planned-transactions)|controllers/transactions.controller/update-transaction|services/attachments/attachments|services/subscriptions/subscription-planned-rows|services/investments/portfolios/transfers/transaction-portfolio-link|services/venture/linking/get-transaction-venture-link|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 8: Refund and transfer recommendation tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create:
  - `tools/{get-refunds,get-refund-recommendations,get-transfer-recommendations,list-transfer-suggestions,dismiss-transfer-suggestion}.ts`, `tools/refund-transfer-tools.unit.ts`;
  - `services/tx-refunds/get-refund-recommendations.service.ts`;
  - `services/transactions/transactions-linking/{get-transfer-recommendations,bulk-scan-transfer-recommendations,dismiss-transfer-suggestion}.service.ts`;
  - `services/transactions/transactions-linking/recommendation-schemas.ts` (the REST query and body schemas that the controllers and the tools share), `tools/recommendation-input.ts`, `tools/refund-output.ts`.
- Modify:
  - `services/mcp/serializers.ts` (+ `serializers.unit.ts`): the slim transaction carries `transferId`;
  - `tools/bulk-delete-transactions.ts`, `tools/transaction-filter-input.ts` (+ `transaction-read-tools.unit.ts`): empty filters are refused;
  - `controllers/transactions.controller/refunds/get-refund-recommendations.ts`, `controllers/transactions.controller/transfer-linking/{get-transfer-recommendations,bulk-scan-transfer-recommendations,dismiss-transfer-suggestion}.ts` (they call the new services), the four metafiles, `tool-scopes-drift.unit.ts` (`LOCK_GUARDED_READ_TOOLS`: `list_transfer_suggestions`, whose route `POST /transactions/transfer-recommendations/bulk-scan` carries `checkBaseCurrencyLock`)

- [x] read first: those four controllers, `transfer-linking/constants.ts`, `services/tx-refunds/*`, `@models/transfer-suggestion-dismissals.model`
- [x] e2e coverage check before the move: confirm each of the four routes has an e2e case for the logic that moves (windows, limits, scoring, sorting, the ownership check). The gate patterns below already name the refund-recommendation, transfer-recommendation, bulk-scan and dismiss suites; if a moved behaviour (for example the ownership check, or the dismissal filter on a scan) has no case, add one to those suites first and run it green against the unmoved controller.
  - Existing cases covered the windows, limits, scoring, sorting, the dismissal filter on a scan and an unknown id.
  - Four cases had none and were added first, green against the unmoved controllers: the refund 6-month window; another user's transaction or account (refund and transfer recommendations return `[]`); `includeOutOfWallet` on a scan; a dismissal with one unknown or foreign transaction (422).
- [x] move the inline logic of the four controllers into the four services unchanged: windows, limits, scoring, sorting, the ownership check. The controllers keep only validation and the response.
- [x] `get_refunds` (read): one tool with three modes.
  - `transactionId` → `getRefundsForTransactionById`;
  - `originalTxId` + `refundTxId` → `getRefund`;
  - otherwise `page`, `limit`, `categoryId?`, `accountId?`, `transactionType?` → `getRefundTransactions`.
- [x] `get_refund_recommendations` (read): `transactionId`, or `transactionType` + `originAmount` + `accountId`, as REST refines.
- [x] `get_transfer_recommendations` (read): the same two input shapes.
- [x] `list_transfer_suggestions` (read-named, lock-carrying): `from`, `to`, `limit` (≤ 50, default 20), `offset`, `includeOutOfWallet` → the bulk-scan service. Its REST route is a POST with `checkBaseCurrencyLock`, so the tool calls `getUserId` → `assertBaseCurrencyUnlocked` (no scope) and is listed in `LOCK_GUARDED_READ_TOOLS`. While moving the service, confirm it writes nothing; if it does, rename the tool to a write name and give it `finance:write`.
- [x] `dismiss_transfer_suggestion` (`finance:write`): `expenseTransactionId`, `incomeTransactionId`.
- [x] ➕ `transferId` on the slim transaction (follow-up from Task 7):
  - `slimTransactionsForMcp` dropped `transferId`, so an agent could not use `get_transactions`' transferId mode or see which rows are paired transfers, and this task is about transfers;
  - it now carries `transferId` (`transferNature` was already there); the `serializers.unit.ts` case that asserted the omission now asserts the field, and `transaction-read-tools.unit.ts` covers both legs of a transfer.
- [x] ➕ `bulk_delete_transactions` refuses an unfiltered delete (follow-up from Task 7):
  - REST accepts `filters: {}` and deletes everything the caller owns; for an AI client that is one forgotten argument away from wiping the account, so the tool requires explicit `transactionIds` or at least one narrowing filter and otherwise refuses with a clear message before resolving anything;
  - a filter narrows unless it is absent, an empty list, `false` or the `all` operation (`hasNarrowingFilter`); a deliberate, documented MCP-only deviation from REST (see Tool conventions);
  - unit tests: empty filters, all-empty lists, exclude flags off, `all` operations (each also with `excludedIds`) are refused; a date bound, an account, a note search, a type, a flag on and `only` still delete.
- [x] unit test `refund-transfer-tools.unit.ts`: the `get_refunds` modes, the recommendation input refinements (enforced in the handler by the shared validator), dismissal args, and `list_transfer_suggestions` throwing while the lock is set.
- [x] metafiles under `// Transactions`.
- [x] gate (unit `services/mcp/` + payees: 20 suites, 400 tests; e2e: 9 suites, 106 tests + 1 todo; typecheck, lint, oxfmt clean):
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='controllers/transactions.controller/(refunds/get-refund-recommendations|transfer-linking/(get-transfer-recommendations|bulk-scan-transfer-recommendations|link-transactions))|services/tx-refunds/(create-single-refund|refund-links)|services/transactions/splits/splits-refunds|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 9: Reconciliation tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-reconciliation-history,list-stuck-pending-transactions,remove-duplicate-transactions,restore-removed-transactions,merge-duplicate-transactions,keep-pending-as-booked}.ts`, `tools/reconciliation-tools.unit.ts`
- Create also: `controllers/transactions.controller/reconciliation-schemas.ts` (the REST body schemas that the controller and the tools share)
- Modify: `controllers/transactions.controller/reconciliation.ts` (uses the shared schemas), the four metafiles, `tool-scopes-drift.unit.ts` (no list change: `merge_duplicate_transactions` is `finance:write`, not destructive)

- [x] read first: `controllers/transactions.controller/reconciliation.ts`, `services/transactions/reconciliation/*`, `reconciliation.e2e.ts`
- [x] `get_reconciliation_history` (read): `getReconciliationHistory`, rows slimmed with their payee; optional `limit` (default 50, max 200) keeps the newest events and the result carries `total`.
- [x] `list_stuck_pending_transactions` (read): `getStuckPending`, returns `{ pending: [{ transaction, candidate, pendingDays }] }` with slim rows; `canCheckWithBank` is left out because the bank-check route has no tool.
- [x] `remove_duplicate_transactions` (`finance:write`): `transactionIds` (REST bounds) → `removeTransactions`. The description says removed rows can be restored.
- [x] `restore_removed_transactions` (`finance:write`): `restoreTransactions`.
- [x] `merge_duplicate_transactions` (`finance:write`): `transactionIds` (REST min and max), `survivorId` → `mergeTransactions`.
  - Decision: `finance:write`, not `DESTRUCTIVE_TOOLS`. `mergeTransactions` soft-deletes the merged rows (`deletedAt` and `mergedIntoId`) and `restoreTransactions` clears both, so `restore_removed_transactions` undoes a merge. This matches Technical Details, "Tool conventions".
  - The description says merged rows are restorable, and that a restored row comes back without the budget, group and subscription links the merge moved to the survivor (`restoreTransactions` clears the two columns and moves no link back).
- [x] `keep_pending_as_booked` (`finance:write`): `transactionIds` → `keepAsBooked`.
- [x] unit test `reconciliation-tools.unit.ts`.
- [x] metafiles under a new `// Reconciliation` group.
- [x] gate (unit `services/mcp/` + payees: 21 suites, 443 tests; e2e: 4 suites, 80 tests; typecheck, lint, oxfmt clean):
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/transactions/reconciliation/(reconciliation|notify-stuck-pending)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 10: Subscription period and candidate tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{accept-subscription-candidate,list-subscription-match-suggestions,get-subscription-periods,preview-subscription-payment,pay-subscription-period,skip-subscription-period,unlink-subscription-period-transaction,revert-subscription-period}.ts`, `tools/subscription-period-tools.unit.ts`
- Modify: `services/subscriptions/revert-period.ts` (the `assertCanDeleteTransaction` callback and the period row lock), the four metafiles, `tool-scopes-drift.unit.ts` (`CONDITIONAL_DELETE_TOOLS` gets `revert_subscription_period`)

- [x] read first: `controllers/subscriptions/{accept-candidate,suggest-matches,get-pay-preview,get-periods,mark-period-paid,skip-period,unlink-transaction,revert-period}.ts` and their services
- [x] `accept_subscription_candidate` (`finance:write`): `candidateId`, `subscriptionId?` (attach to an existing one) → `resolveCandidate`.
- [x] `list_subscription_match_suggestions` (read): `subscriptionId` → `suggestHistoricalMatches`.
- [x] `get_subscription_periods` (read): `subscriptionId`, `limit` (≤ 50), `offset` → `getPeriods`.
- [x] `preview_subscription_payment` (read): `subscriptionId`, `periodId?` → `getSubscriptionPayPreview`.
- [x] `pay_subscription_period` (`finance:write`):
  - `subscriptionId`, `periodId`;
  - `transactionId?` or `createTransaction` with `amount?`, `time?`, `accountId?` (mutually exclusive, as REST);
  - `notes?`;
  - calls `markPeriodPaid`.
- [x] `skip_subscription_period`, `unlink_subscription_period_transaction` (`finance:write`): `subscriptionId`, `periodId`.
- [x] `revert_subscription_period` (`finance:write`, plus `finance:delete` when the revert deletes a transaction): `subscriptionId`, `periodId`. `services/subscriptions/revert-period.ts` deletes the payment transaction when the period's `transactionAutoCreated` is true and the account is not bank-linked (the e2e `subscription-period-actions` asserts the deletion and the balance reversal), so a write-only token must not reach it.
  - The scope decision is made where the delete is decided, inside `revertPeriod`'s own transaction, not from a read made before it (a concurrent unlink or bank-link change between two reads would let a write-only token reach the delete). `revertPeriod` takes an optional `assertCanDeleteTransaction?: () => void`. It calls it in the branch that is about to call `deleteTransaction` (period `transactionAutoCreated`, transaction found, not on a bank-linked account), before that call. When it throws, the transaction rolls back and nothing is written. REST passes no callback and behaves as today.
  - The period read in `revertPeriod` takes a row lock (`lock: true`), so the decision and the delete see one consistent state.
  - The handler calls `requireScope` with `finance:write`, then `revertPeriod` with `assertCanDeleteTransaction` set to a closure that calls `requireScope` with `finance:delete` (the same scope error as everywhere else). A revert that keeps the transaction never calls it, so a write-only token still works for those.
  - Optional: `getRevertEffect({ userId, subscriptionId, periodId })` → `{ deletesTransaction }`, exported from `revert-period.ts`, may serve the tool description's example and an early, friendlier refusal; it never decides. Drop it if it adds nothing. (Dropped: the description states the rule and the callback refuses with the scope error, so a second read adds nothing.)
  - Like `ignore_payee_name`, it goes in `CONDITIONAL_DELETE_TOOLS`. The description says a revert can delete the transaction the app created for the payment.
- [x] unit test `subscription-period-tools.unit.ts`: the pay either-or, args, scopes, and the revert scope rule, with the service mocked to call (or not call) the callback it receives: a write-only token passes when the service never calls `assertCanDeleteTransaction`; it is refused when the service calls it, even if any preliminary `getRevertEffect` said "keep"; a token with `finance:delete` passes in both cases. The existing `subscription-period-actions` e2e (in the gate) keeps REST behaviour unchanged: no callback, deletion still happens.
- [x] metafiles under `// Subscriptions`.
- [x] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/subscriptions/(subscription-periods|subscription-period-actions|subscription-mark-paid|detect-candidates|subscriptions)\.e2e|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.
- [x] extras done: e2e `Subscription period request validation` in `subscription-period-actions.e2e.ts` (pay either-or, non-positive amount, periods page limits) added and seen green against the unmoved controllers before the REST bodies moved into `controllers/subscriptions/shared-schemas.ts`; service unit `revert-period.unit.ts` covers the callback (asked once, before the delete, only on the delete branch; a throw writes nothing) and the row lock.

### Task 11: Payee tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{set-payees-categorization-mode,bulk-delete-payees,get-ignored-payee-names,ignore-payee-name,unignore-payee-name,apply-payee-tags-to-transactions,create-payee-alias,delete-payee-alias}.ts`, `tools/payee-tools.unit.ts`
- Modify: `tools/update-payee.ts`, the four metafiles, `tool-scopes-drift.unit.ts` (`DESTRUCTIVE_TOOLS` gets `bulk_delete_payees`; new `CONDITIONAL_DELETE_TOOLS` gets `ignore_payee_name`)

- [x] read first: `controllers/payees/*`, `services/payees/*`
- [x] `update_payee`: add the `PATCH /payees/:id` fields it lacks (`categorizationMode`, `defaultTagIds`, `defaultLocation`, logo fields), with the REST schema.
- [x] `set_payees_categorization_mode` (`finance:write`): `mode` (`CATEGORIZATION_MODE`) → `bulkUpdateCategorizationMode`. The description says it applies to every payee.
- [x] `bulk_delete_payees` (`finance:delete`): `ids` (1–2000), `ignoreFuture?` → `bulkDeletePayees`.
- [x] `get_ignored_payee_names` (read): `listPayeeIgnoredNames`.
- [x] `ignore_payee_name` (`finance:write`, plus `finance:delete` when `force` is set): `rawName`, `force?` → `addPayeeIgnoredName`. With `force` the service deletes the matching payee for good, so the handler calls `requireScope({ extra, scope: 'finance:delete' })` before the service. Without `force` only `finance:write` applies and the 409 message passes through. This is a deliberate conditional-scope tool: it cannot sit in `DESTRUCTIVE_TOOLS`, because that rule demands `finance:delete` on every call and the drift check refuses a source with `scope: 'finance:write'`. It goes in a hand-kept `CONDITIONAL_DELETE_TOOLS` list in `tool-scopes-drift.unit.ts` instead, and that case asserts its source holds both scope checks; the unit test below proves the `force` path.
- [x] `unignore_payee_name` (`finance:write`): `ignoredNameId` → `removePayeeIgnoredName`.
- [x] `apply_payee_tags_to_transactions` (`finance:write`): `payeeId` → `applyPayeeTagsToExisting`.
- [x] `create_payee_alias` (`finance:write`): `payeeId`, `rawName`.
- [x] `delete_payee_alias` (`finance:delete`): `payeeId`, `aliasId`.
- [x] unit test `payee-tools.unit.ts`: the `force` scope rule (write-only token: `force: false` passes, `force: true` throws and the service mock is not called), the new `update_payee` fields, args.
- [x] metafiles under `// Payees`. Add the missing rows for the six existing payee tools to SKILL.md while there.
- [x] gate (unit `services/mcp/` + payees: 23 suites, 522 tests; e2e: 8 suites, 77 tests; typecheck, lint, oxfmt clean):
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/payees/(payees|bulk-delete-payees|ignored-names|ignore-list-api-and-curation|payee-tags|payee-default-location)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.
- [x] extras done: REST bodies moved into `controllers/payees/shared-schemas.ts`; e2e validation cases (update payload rejections, alias and ignored name over 500 characters, more than 2000 bulk-delete ids) added first and seen green against the unmoved controllers (3 suites, 50 tests).

### Task 12: Transaction templates, automation apply and detail lookups

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/template-output.ts`, `tools/{get-transaction-templates,create-transaction-template,update-transaction-template,delete-transaction-template,apply-transaction-automation,get-category-transaction-count}.ts`, `tools/template-tools.unit.ts`
- Modify: `controllers/transaction-templates/{schema,update-transaction-template}.ts` (shared `updateTemplateBodySchema`), `tools/delete-category.ts` (points to the count tool), `tools/get-transaction-groups.ts` (`groupId`), `tools/get-tags.ts` (`tagId`), the four metafiles

- [x] read first: `controllers/transaction-templates/*` (`schema.ts`), `services/transaction-templates`, `controllers/transaction-automations/apply-to-history.ts`, `services/transaction-automations/zod-schemas`, `controllers/categories.controller/get-category-transaction-count.ts`
- [x] `get_transaction_templates` (read). The description says templates are named presets for new transactions.
- [x] `create_transaction_template` (`finance:write`):
  - `name`, `transactionType`, plus optional `amount`, `accountId`, `categoryId`, `payeeId`, `paymentType`, `note`, `originalCurrencyCode`, `tagIds`, from the REST schema;
  - a pinned amount needs `accountId`, and duplicate names give the 409 message.
- [x] `update_transaction_template` (`finance:write`): `templateId` plus the partial fields. `null` clears, and `tagIds` replaces the set.
- [x] `delete_transaction_template` (`finance:delete`).
- [x] `apply_transaction_automation` (`finance:write`): `automationId`, `transactionIds` (1 to `AUTOMATION_LIMITS.maxApplyIds`) → `applyAutomationToHistory`.
- [x] `get_category_transaction_count` (read): `categoryId` → `countCategoryTransactions`. The description points to it before `delete_category`.
- [x] `get_transaction_groups`: optional `groupId` → `getTransactionGroupById`.
- [x] `get_tags`: optional `tagId` → `getTagById`.
- [x] unit test `template-tools.unit.ts`, covering the two extensions (36 cases, seen red on assertions against stub tools first).
- [x] metafiles: templates under a new `// Transaction templates` group, the rest under their existing groups.
- [x] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/transaction-templates/transaction-templates|services/transaction-automations/apply-to-history|controllers/categories.controller/get-category-transaction-count|services/transaction-groups/transaction-groups|services/tags/tags|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 13: Tracker details and tag reminder tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-budget,get-budget-transactions,get-tag-reminders,create-tag-reminder,update-tag-reminder,delete-tag-reminder}.ts`, `tools/tracker-reminder-tools.unit.ts`
- Modify: the four metafiles

- [ ] read first, on `dev` after Task 3's merge: `controllers/budgets/{get-budgets,get-stats,get-category-budget-transactions}.ts` (tracker stats in base minor units), `controllers/tag-reminders/*`, `serializers/tag-reminders.serializer.ts`
- [ ] `get_budget` (read): `budgetId` → `getBudgetById` + `serializeBudget` and `getBudgetStats` (which returns `{ stats, decimals }`) + `serializeBudgetStats({ stats, decimals })`. On `dev` the two controllers hold nothing beyond that service-plus-serializer pair, so there is no orchestration to move; the tool calls the same functions.
- [ ] `get_budget_transactions` (read): `budgetId`, `from` (≥ 0), `limit` (1–100) → `getCategoryBudgetTransactions`. The description says it works for category trackers, and manual trackers use `search_transactions` with `budgetIds`.
- [ ] `get_tag_reminders` (read): `tagId?`, `reminderId?` (needs `tagId`) → `getAllReminders`, `getRemindersForTag` or `getReminderById`, serialized.
- [ ] `create_tag_reminder` (`finance:write`):
  - `tagId`, `type` (`amountThreshold` | `existenceCheck`), `frequency?`, `dayOfMonth?`, `amountThreshold?` (base currency), `isEnabled?`;
  - through `deserializeCreateTagReminder`, then `createReminder`.
- [ ] `update_tag_reminder` (`finance:write`): `tagId`, `reminderId` and the partial fields, through `deserializeUpdateTagReminder`.
- [ ] `delete_tag_reminder` (`finance:delete`).
- [ ] unit test `tracker-reminder-tools.unit.ts`.
- [ ] metafiles: trackers under `// Trackers`, reminders under `// Taxonomy`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/budgets/(stats|category-budgets|budget-crud)|services/tag-reminders/tag-reminders|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 14: Notification and user settings tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-notifications,mark-notifications-read,dismiss-notification,get-user-settings,update-user-settings}.ts`, `tools/notification-settings-tools.unit.ts`
- Modify: the four metafiles, `tool-scopes-drift.unit.ts` (`LOCK_EXEMPT_TOOLS`: `mark_notifications_read`, `update_user_settings`; `READ_ONLY_ROUTE_TOOLS`: the same two)

- [ ] read first: `controllers/notifications.controller.ts`, `controllers/user-settings/{get-settings,patch-settings}.ts`, `models/user-settings.model.ts` (`ZodSettingsPatchSchema`), `middlewares/entitlements.ts#requireFireSettingsAccess`
- [ ] `get_notifications` (read): `notificationId?`, or `status?`, `type?`, `limit` (1–100), `offset`. The list result includes `unreadCount` (`getUnreadCount`).
- [ ] `mark_notifications_read` (`finance:write`, `allowReadOnly: true`, lock-exempt like REST): `notificationId?`. Without an id it marks all (`markAllAsRead`). Both REST routes (`POST /notifications/read-all`, `POST /notifications/:id/read`) are in `READ_ONLY_ROUTES`, so a read-only user keeps the inbox usable over MCP too.
- [ ] `dismiss_notification` (`finance:write`): `notificationId`. `POST /notifications/:id/dismiss` is not in `READ_ONLY_ROUTES`, so a read-only user is refused, as in REST.
- [ ] `get_user_settings` (read): `getUserSettings`, with the `ai` slice left out. That keeps AI configuration out of the client, matching the ai exclusion.
- [ ] `update_user_settings` (`finance:write`, `allowReadOnly: true`, lock-exempt like REST; `PUT` and `PATCH /user/settings` are in `READ_ONLY_ROUTES`):
  - a deep-merge patch validated with `ZodSettingsPatchSchema` minus `ai` → `patchUserSettings`;
  - a `fire` key needs `requireFeatureAccess` `fire_planner`;
  - it covers `PUT /settings` too: the patch replaces arrays whole, as REST does.
- [ ] unit test `notification-settings-tools.unit.ts`: `ai` rejected and stripped, the `fire` gate, mark all versus one, and read-only handling: `mark_notifications_read` and `update_user_settings` pass for a read-only user, `dismiss_notification` throws for one.
- [ ] metafiles under a new `// Notifications & settings` group.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/notifications/notifications|services/user-settings/(patch-settings|update-settings|fire-settings|settings-service-owned-slices)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 15: Stats tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-total-balance,get-net-worth-history,get-net-worth-drivers,get-investment-contributions,get-venture-contributions,get-pivot-report,get-cumulative-stats,get-earliest-transaction-date}.ts`, `tools/stats-tools.unit.ts`, `services/stats/reports/*.report.ts` (one per report)
- Modify: `controllers/stats.controller.ts` (every report handler calls its report function), `tools/get-balance-history.ts`, `tools/get-expenses-for-period.ts`, `tools/get-spending-by-categories.ts`, `tools/get-cash-flow.ts` (the existing stats tools switch to the same report functions), the four metafiles

- [ ] read first, on `dev` after Task 3's merge: `controllers/stats.controller.ts` and `serializers/stats.serializer.ts`. Every report now takes base `decimals` from `getBaseCurrencyDecimals`, and the serializers take `{ …, decimals }`. Some reports read `includeCreditLimitInStats` from `getUserSettings`.
- [ ] `services/stats/reports/`: one function per report, for example `getTotalBalanceReport({ userId, date })`, that holds what each handler repeats today: the `getUserSettings` read (`includeCreditLimitInStats`), `getBaseCurrencyDecimals`, the stats service call, and the serializer with `{ …, decimals }`. It returns the API payload. `controllers/stats.controller.ts` handlers keep only validation and call the function; the tools call the same function. Cover the eight new reports and the existing ones (`getCombinedBalanceHistoryReport`, the expenses, spending-by-category and cash-flow reports). REST behaviour is unchanged.
  - e2e coverage check before the move: the gate pattern below names the suites for every moved report (including cash flow, spendings by category, expenses amount and the foreign-currency history); `get_total_balance` has none of its own, so confirm `credit-limit-in-stats` exercises `/stats/total-balance` with and without the setting, and add a default-settings case there if it does not. Run any added case green against the unmoved controller.
- [ ] each new tool maps its input and calls the report function (no controller logic in the tool):
  - `get_total_balance` (`date`);
  - `get_net_worth_history` (`from`, `to`, `granularity`);
  - `get_net_worth_drivers` (`from`, `to`, `granularity`, `portfolioIds?`);
  - `get_investment_contributions` (the same);
  - `get_venture_contributions` (`from`, `to`);
  - `get_pivot_report` (`from`, `to`, `granularity`, `rowDimension`, `measure`, `accountIds?`, `categoryIds?`, `payeeIds?`);
  - `get_cumulative_stats` (`from`, `to`, `metric`, `accountId?` and the id include and exclude lists);
  - `get_earliest_transaction_date`.

  All are read tools. Arrays are taken as arrays, not the comma strings REST uses.

- [ ] `get_balance_history` bug fix, test first (the combined branch calls `getCombinedBalanceHistory` without `includeCreditLimit`, while `/stats/combined-balance-history` passes `settings.includeCreditLimitInStats`):
  - write the `stats-tools.unit.ts` case first: the settings mock returns `includeCreditLimitInStats: true`, and the combined branch must call the report with that setting applied (the combined service receives `includeCreditLimit: true`);
  - run it and confirm it fails on the current tool;
  - then switch the tool to `getCombinedBalanceHistoryReport`, which reads the setting, and confirm the case passes.
- [ ] unit test `stats-tools.unit.ts`: the enum schemas, decimals passed through, the credit-limit case above, and `includeCreditLimit` false when the setting is off.
- [ ] metafiles under `// Analytics`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/stats/(get-net-worth-drivers|get-net-worth-history|get-investment-contributions|get-venture-contributions|get-pivot|get-cumulative-data|get-earliest-transaction-date|get-combined-balance-history|credit-limit-in-stats|get-cash-flow|get-spendings-by-categories/get-spendings-by-categories|exclude-planned|base-currency-precision|foreign-currency-balance-history)|services/sharing/shared-account-stats|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 16: Portfolio and portfolio transfer tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-portfolio,get-portfolios-overview,transfer-between-portfolios,exchange-portfolio-currency,set-portfolio-transfer-adjustment,delete-portfolio-transfer,restore-portfolio}.ts`, `tools/portfolio-transfer-tools.unit.ts`
- Modify: `controllers/investments/portfolios/serialize-transfer.ts` (export for reuse if local), the four metafiles

- [ ] read first: `controllers/investments/portfolios/{get-portfolio,get-portfolio-summaries.controller,get-portfolios-annualized-returns.controller,create-portfolio-transfer,exchange-currency,set-transfer-adjustment,delete-portfolio-transfer,restore-portfolio}.ts`, `serializers.ts#slimPortfolioTransferForMcp`
- [ ] `get_portfolio` (read): `portfolioId` → `getPortfolio`.
- [ ] `get_portfolios_overview` (read): `{ summaries, annualizedReturns }` from `getPortfolioSummaries` and `getPortfoliosAnnualizedReturns`.
- [ ] `transfer_between_portfolios` (`finance:write`): `fromPortfolioId`, `toPortfolioId`, `currencyCode`, `amount` (positive decimal string), `date`, `description?` → `createPortfolioTransfer`.
- [ ] `exchange_portfolio_currency` (`finance:write`): `portfolioId`, `fromCurrencyCode`, `toCurrencyCode`, `fromAmount`, `toAmount`, `date`, `description?`.
- [ ] `set_portfolio_transfer_adjustment` (`finance:write`): `transferId`, `isAdjustment`.
- [ ] `delete_portfolio_transfer` (`finance:delete`): `transferId`, `deleteLinkedTransaction?`.
- [ ] `restore_portfolio` (`finance:write`): `portfolioId`.
- [ ] unit test `portfolio-transfer-tools.unit.ts`.
- [ ] metafiles under `// Portfolio cash transfers` and `// Investments`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/investments/portfolios/(get-portfolio-summaries|get-portfolios-annualized-returns|list\.service|delete\.service|transfers/(create-portfolio-transfer|exchange-currency|delete-portfolio-transfer|list-portfolio-transfers))|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 17: Holding, security price and venture link tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create:
  - `tools/{create-holding,delete-holding,get-security-prices,link-transactions-to-venture-event,replace-venture-event-links,delete-venture-event-link}.ts`, `tools/holding-venture-link-tools.unit.ts`;
  - `services/investments/holdings/create-holding-from-input.service.ts`.
- Modify: `controllers/investments/holdings/index.ts` (calls the new service), `tools/search-securities.ts`, the four metafiles

- [ ] read first: `controllers/investments/holdings/index.ts`, `services/investments/securities/add-from-search.service.ts`, `controllers/investments/prices/get-prices.controller.ts`, `controllers/venture/events/{append-links,replace-links,delete-link}.controller.ts`, `services/venture/linking/*`
- [ ] `create-holding-from-input.service.ts`: the controller's orchestration (`securityId`, or `searchResult` → the asset-class check, then `addSecurityFromSearch`, then `createHolding`). The controller calls it.
- [ ] `search_securities` round trip: today the tool drops `providerName`, `providerSymbol` and `priceSourceSymbol`, while the holding body requires `providerName` and `providerSymbol` (and uses `priceSourceSymbol` to pick the price provider), and the result carries no `securityId`, so a search result could not be passed to `create_holding`. Each result keeps its slim fields and gains the routing keys `create_holding` needs (`providerName`, `providerSymbol`, `priceSourceSymbol` when present, plus `exchangeAcronym`, `exchangeMic`, `cryptoCurrencyCode`, `cusip`, `isin` and the rest of the REST `SecuritySearchResultSchema` when set). Its description says to pass a result as `create_holding`'s `searchResult`, and to read the `securityId` from the `create_holding` result (or `get_portfolio_holdings`) before `create_investment_transaction`. Unit case: a mocked search result, passed through the tool's output, validates against `SecuritySearchResultSchema` (export it from the holdings controller, or move it next to the new service).
- [ ] `create_holding` (`finance:write`): `portfolioId` plus exactly one of `securityId` and `searchResult` (a result from `search_securities`, validated with the same `SecuritySearchResultSchema`).
- [ ] `delete_holding` (`finance:delete`): `portfolioId`, `securityId`, `force?`.
- [ ] `get_security_prices` (read): `securityId` (required in MCP; the price table is global and large), `from?`, `to?` → `getPrices`.
- [ ] `link_transactions_to_venture_event` (`finance:write`): `eventId`, `transactionIds` (≥ 1) → `linkTxsToEvent`. The description gives the rules: same currency, not linked elsewhere, the sum equals the event's `lpNetAmount`.
- [ ] `replace_venture_event_links` (`finance:write`): `eventId`, `transactionIds` (may be empty) → `replaceEventLinks`.
- [ ] `delete_venture_event_link` (`finance:delete`): `eventId`, `linkId` → `unlinkTxFromEvent`. It restores the transaction.
- [ ] unit test `holding-venture-link-tools.unit.ts`, including the search-to-create round trip above.
- [ ] metafiles under `// Investments` and `// Venture investments`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/investments/(holdings/holdings|securities-price/get-prices)|services/venture/(events/lifecycle|linking/unlink-tx-from-event)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 18: Loan tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-loans,get-loan-balance-history,create-loan,update-loan,delete-loan,add-loan-note,link-loan-payments,unlink-loan-payment}.ts`, `tools/loan-tools.unit.ts`, `services/loans/get-loan-views.service.ts`
- Modify: `controllers/loans/{get-loans,get-loan-by-id}.ts` (call the new service), the four metafiles

- [ ] read first, on `dev` after Task 3's merge (loans compute in minor units at the loan currency's decimals): `controllers/loans/*`, `services/loans/zod-schemas.ts`, `serializers/loans.serializer.ts`
- [ ] `get-loan-views.service.ts`: the `projectLoan` + payment count + `serializeLoan(s)` assembly the two read controllers repeat. The controllers call it.
- [ ] `get_loans` (read): `loanId?` → a list or one loan view.
- [ ] `get_loan_balance_history` (read): `loanId` → `getLoanBalanceHistory`.
- [ ] `create_loan` (`finance:write`): `createLoanBodySchema`. `update_loan` (`finance:write`): `loanId` + `updateLoanBodySchema`.
- [ ] `delete_loan` (`finance:delete`).
- [ ] `add_loan_note` (`finance:write`): `loanId`, `text` (1–2000) → `updateLoan({ appendNote })`.
- [ ] `link_loan_payments` (`finance:write`): `loanId`, `transactionIds` (1–500), `confirmOverpay?`. `unlink_loan_payment` (`finance:write`): `loanId`, `transactionId`.
- [ ] unit test `loan-tools.unit.ts`.
- [ ] metafiles under a new `// Loans & vehicles` group.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/loans/(loans|loan-balance-history|loan-payment-linking|balance-anchor|planned-payment-legs)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 19: Vehicle tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-vehicles,create-vehicle,update-vehicle,delete-vehicle}.ts`, `tools/vehicle-tools.unit.ts`
- Modify: the four metafiles

- [ ] read first: `controllers/vehicles/*`, `serializers/vehicles.serializer.ts`
- [ ] `get_vehicles` (read): `vehicleId?` → `getVehicles` or `getVehicle`.
- [ ] `create_vehicle` (`finance:write`):
  - `name`, `currencyCode`, `make`, `model`, `year`, `vehicleClass`, `purchasePrice`, `purchaseDate`;
  - optional `trim`, `depreciationPreset`, `customAnnualRatePct`, `salvageFloorPct`, `currentMileage`.
- [ ] `update_vehicle` (`finance:write`): `vehicleId` + the editable fields. Purchase price, purchase date and currency are not editable, and the description says so.
- [ ] `delete_vehicle` (`finance:delete`).
- [ ] unit test `vehicle-tools.unit.ts`.
- [ ] metafiles under `// Loans & vehicles`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/vehicles/vehicles|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 20: Budget plan read tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{list-budget-plans,get-budget-plan-suggestion-context,list-budget-plan-periods,get-budget-plan-period,get-budget-plan-scheduled,get-budget-plan-trends}.ts`, `tools/budget-plan-read-tools.unit.ts`
- Modify: the four metafiles

- [ ] read first, on `dev` after Task 3's merge (plan figures in minor units at the plan currency's decimals): `routes/budget-plans.route.ts`, `controllers/budget-plans/*` (the read handlers), `services/budget-plans/{get-plan,list-periods,get-period-view,get-scheduled,get-trends,suggested-lines}.ts`
- [ ] the tools call the existing services directly (`listPlans`, `getPlan`, `getPeriodView`, `getTrends`, …): on `dev` each read controller is one service call returned as `{ data }`, with no decimals read and no serializer, so there is nothing to move into a new service.
- [ ] `list_budget_plans` (read): `planId?`, `includeDeleted?` → `listPlans` or `getPlan`.
- [ ] `get_budget_plan_suggestion_context` (read): `accountIds?`.
- [ ] `list_budget_plan_periods` (read): `planId`.
- [ ] `get_budget_plan_period` (read): `planId`, `periodId` → `getPeriodView`.
- [ ] `get_budget_plan_scheduled` (read): `planId`, `periodId`.
- [ ] `get_budget_plan_trends` (read): `planId`, `until?`, `count` (1–24, default 6).
- [ ] Reads are not feature-gated, as in REST.
- [ ] unit test `budget-plan-read-tools.unit.ts`.
- [ ] metafiles under a new `// Budget plans` group. The SKILL.md data conventions gain a bullet distinguishing budget plans (period envelopes) from trackers ("budget" tools).
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/budget-plans/(get-trends|get-scheduled|list-periods|period-view-numbers|suggested-lines|guards)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 21: Budget plan setup tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{create-budget-plan,update-budget-plan,delete-budget-plan,restore-budget-plan,set-budget-plan-accounts,create-budget-plan-group,update-budget-plan-group,delete-budget-plan-group}.ts`, `tools/budget-plan-setup-tools.unit.ts`
- Modify: the four metafiles

- [ ] read first: `controllers/budget-plans/*` (the plan and group handlers and their schemas), `services/budget-plans/{create-plan,update-plan,delete-plan,restore-plan,set-plan-accounts,line-groups}.ts`
- [ ] every write here except `delete_budget_plan` calls `requireFeatureAccess` `budget_plan`. Delete stays ungated, as in REST, because an active plan blocks base-currency changes.
- [ ] `create_budget_plan` (`finance:write`): the REST body (`name`, `type`, `cadence`, `anchorDate`, `accountIds`, and the optional fields).
- [ ] `update_budget_plan` (`finance:write`): `planId` + `name`, `autoAttachAccounts`, `carryPolicy`, `poolEnabled`, `zeroSum`, `expectedIncome`.
- [ ] `delete_budget_plan` (`finance:delete`): `planId`, `permanent?` → `deletePlan` or `purgePlan`.
- [ ] `restore_budget_plan` (`finance:write`): `planId`, `replace?`.
- [ ] `set_budget_plan_accounts` (`finance:write`): `planId`, `accountIds`.
- [ ] `create_budget_plan_group`, `update_budget_plan_group` (`finance:write`): `planId`, `groupId?`, `name`. `delete_budget_plan_group` (`finance:delete`).
- [ ] unit test `budget-plan-setup-tools.unit.ts`: the feature gate on each write, delete ungated.
- [ ] metafiles under `// Budget plans`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/budget-plans/(create-plan|delete-plan|restore-plan|set-plan-accounts|line-groups|guards)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 22: Budget plan line and layout tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{create-budget-plan-line,update-budget-plan-line,delete-budget-plan-line,archive-budget-plan-line,add-suggested-budget-plan-lines,set-budget-plan-layout}.ts`, `tools/budget-plan-line-tools.unit.ts`
- Modify: the four metafiles

- [ ] read first: `controllers/budget-plans/*` (the line, suggested-line and layout handlers), `services/budget-plans/{create-line,update-line,delete-line,line-groups,suggested-lines,suggested-lines-ai}.ts`
- [ ] all writes call `requireFeatureAccess` `budget_plan`.
- [ ] `create_budget_plan_line` (`finance:write`): `planId`, `name`, `categoryIds` (≥ 1), `sortOrder?`, `groupId?`, `activeFrom?`.
- [ ] `update_budget_plan_line` (`finance:write`): `planId`, `lineId` + `name`, `sortOrder`, `groupId`, `categoryIds`, `effectiveFrom` (only with `categoryIds`).
- [ ] `delete_budget_plan_line` (`finance:delete`).
- [ ] `archive_budget_plan_line` (`finance:write`): `planId`, `lineId`, `archived` → `archiveLine` or `restoreLine`.
- [ ] `add_suggested_budget_plan_lines` (`finance:write`): `planId`, `answers?` (`budgetSuggestionAnswers`). The description says it may use the server's AI and falls back to spending-based lines without it.
- [ ] `set_budget_plan_layout` (`finance:write`): `planId`, `groups[{ id, lineIds }]`, `ungroupedLineIds`. The description says every group must be listed once.
- [ ] unit test `budget-plan-line-tools.unit.ts`.
- [ ] metafiles under `// Budget plans`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/budget-plans/(lines|line-groups|suggested-lines|merge-lines-on-category-delete)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 23: Budget plan goal and assignment tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{set-budget-plan-line-goal,delete-budget-plan-line-goal,snooze-budget-plan-line-goal,set-budget-plan-assignment}.ts`, `tools/budget-plan-goal-tools.unit.ts`, `services/budget-plans/line-goal-schema.ts`
- Modify: the goal controller (imports the moved schema), the four metafiles

- [ ] read first: the goal and assignment handlers in `controllers/budget-plans/*`, `services/budget-plans/{line-goals,set-assignment}.ts`
- [ ] move the goal body schema and its `superRefine` (which fields each frequency and behaviour allows) from the controller into `line-goal-schema.ts`. The controller and the tool use it, and REST validation is unchanged (`line-goals.e2e.ts` already asserts the 422 for every rejected combination).
  - The tool's `inputSchema` is the schema's `.shape` (a plain shape, as the skill requires); a raw shape cannot carry the `superRefine`. The handler destructures the ids off first (`const { planId, lineId, ...goal } = args`) and runs `lineGoalSchema.parse(goal)` before the service call, so the strict body schema sees only its own fields and the refinements are enforced exactly as in REST; a refusal is an `Error` with the REST message.
- [ ] all writes call `requireFeatureAccess` `budget_plan`.
- [ ] `set_budget_plan_line_goal` (`finance:write`): `planId`, `lineId` + the moved schema's fields.
- [ ] `delete_budget_plan_line_goal` (`finance:delete`).
- [ ] `snooze_budget_plan_line_goal` (`finance:write`): `planId`, `lineId`, `periodId`.
- [ ] `set_budget_plan_assignment` (`finance:write`): `planId`, `periodId`, `lineId`, `scope` (`BUDGET_ASSIGNMENT_SCOPES`), `amount?` and `carryPolicy?` (nullable).
- [ ] unit test `budget-plan-goal-tools.unit.ts`: the moved refinements through the tool (one allowed and one refused combination per frequency; the handler rejects, the service mock is not called), and a normal call with `planId`, `lineId` and a valid goal passes and reaches `setLineGoal` with the goal fields only.
- [ ] metafiles under `// Budget plans`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/budget-plans/(line-goals|set-assignment|pool|period-view-numbers)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 24: Sharing and bank connection status tools (read-only)

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{list-share-invitations,list-share-members,list-shared-with-me,list-bank-connections,get-bank-sync-status}.ts`, `tools/share-bank-status-tools.unit.ts`
- Modify: the four metafiles

- [ ] read first: `controllers/share/*` (the four reads and `_zod.ts`), `services/sharing/{invitations/list-invitations,members/list-members,members/list-shared-with-me}.service.ts`, `controllers/bank-data-providers/*` (the connections and status reads), `services/bank-data-providers/connection/{list-user-connections,get-connection-details}.ts`
- [ ] `list_share_invitations` (read): `direction` (`sent` | `received` | `both`, default `both`).
- [ ] `list_share_members` (read): `resourceType` (account | household | budget), `resourceId`.
- [ ] `list_shared_with_me` (read).
- [ ] `list_bank_connections` (read): `connectionId?` → `listUserConnections` or `getConnectionDetails`. Confirm the output carries no credential or consent token; strip one if it does, with a unit case.
- [ ] `get_bank_sync_status` (read): `getUserAccountsSyncStatus` + `getActiveJobsForUser`, and `getJobGroupProgress` when `jobGroupId` is given. The description says syncing is done in the app.
- [ ] unit test `share-bank-status-tools.unit.ts`.
- [ ] metafiles under a new `// Sharing & bank connections (read-only)` group.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/sharing/(invitations/lifecycle|members/membership|shared-resource-visibility)|services/bank-data-providers/(sync/sync-status-tracker|connection/sync-job-progress-idor)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 25: Import batch tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{list-import-batches,delete-import-batch,get-import-batch-delete-status}.ts`, `tools/import-batch-tools.unit.ts`, `services/import-export/delete-or-queue-batch.service.ts`
- Modify: the batch delete controller (calls the new service), the four metafiles

- [ ] read first: `routes/import-export/batches.route.ts` and its controllers, `services/import-export/{get-batches-history.service,delete-batch.service,delete-batch-queue}.ts`
- [ ] e2e first, before the move (test-first): no e2e case covers the queued fallback (only `delete-batch.service.unit.ts` asserts `ImportBatchTooLargeError`; the sync cap is 1000 rows). Add a REST case to the batch-delete suite: `DELETE /import/batch/:batchId` on a batch above the cap returns the job reply (`jobId`), and `GET /import/batch-delete/status` then reports its progress. Build the batch through the cheapest HTTP path the suite already uses. If a batch above the cap cannot be built over HTTP in reasonable time, stop and ask the owner. Run the case green against the unmoved controller.
- [ ] `delete-or-queue-batch.service.ts`: `deleteImportBatch`, falling back to `queueImportBatchDelete` on `ImportBatchTooLargeError`. It returns `{ deletedCount, deletedIds }` or `{ jobId }`, and the controller uses it.
- [ ] `list_import_batches` (read): `limit` (1–100), `offset`.
- [ ] `delete_import_batch` (`finance:delete`): `batchId`, `deleteLinkedTransfers?`. The description says it undoes an import and that large batches run as a job.
- [ ] `get_import_batch_delete_status` (read).
- [ ] unit test `import-batch-tools.unit.ts`: both delete outcomes.
- [ ] metafiles under a new `// Imports` group.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/import-export/(delete-batch|get-batches-history)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

**Merge:** once Tasks 3–25 pass, merge `feat/mcp-coverage` into `dev` in the main checkout: `git switch dev` (clean tree), then `git merge feat/mcp-coverage`.

- `git merge dev` into `feat/mcp-coverage` first if `dev` moved since Task 3.
- Run the unit gate and one batched e2e run of the MCP suites plus `routes/base-currency-guard-coverage` on `dev`.

### Group D: `feat/apple-pay-ingest` ⏸

⏸ **Deferred:** start only after every task of `docs/plans/20261017-apple-pay-ingest.md` on that branch is checked. If the run reaches this group earlier, leave its boxes open and go on to Task 28.

### Task 26: Ingest token and card mapping tools ⏸

**Branch:** `feat/apple-pay-ingest`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-applepay`

**Files:**

- Create: `tools/{list-ingest-tokens,revoke-ingest-token,get-card-mappings,create-card-mapping,update-card-mapping,delete-card-mapping}.ts`, `tools/ingest-tools.unit.ts`
- Modify: the four metafiles, `tool-scopes-drift.unit.ts` (`DESTRUCTIVE_TOOLS` gets `revoke_ingest_token`; `LOCK_EXEMPT_TOOLS` gets each tool whose route has no lock, for example token revoke)

- [ ] `git merge dev` first. That brings Group A's helpers and drift tests; this branch is fork-only. Resolve per "Merge conflicts". `services/mcp/auth.ts` (the `hashToken` move) is only on this branch.
- [ ] re-audit this branch's final routes under `/user/settings/ingest-tokens`, `/user/settings/card-mappings*` and `/user/settings/card-payments/*`, and update the tool list here if they differ from this plan.
- [ ] `list_ingest_tokens` (read): `listIngestTokens`. Metadata only; the secret is never stored.
- [ ] `revoke_ingest_token` (`finance:delete`, a hard delete): `tokenId` → `revokeIngestToken`.
- [ ] `get_card_mappings` (read): the mappings plus the unlinked parked card labels (`GET /card-mappings/unlinked`).
- [ ] `create_card_mapping`, `update_card_mapping` (`finance:write`): the REST body (card label → account).
- [ ] `delete_card_mapping` (`finance:delete`).
- [ ] no tool mints a token, returns a setup code, reads or writes access headers, or posts a card payment (Technical Details, Apple Pay exclusions).
- [ ] unit test `ingest-tools.unit.ts`.
- [ ] metafiles under a new `// Apple Pay ingest` group.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/ingest-tokens/|<the card-mapping suites the Apple Pay plan names>|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 27: Card payment request tools ⏸

**Branch:** `feat/apple-pay-ingest`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-applepay`

**Files:**

- Create: `tools/{list-card-payment-requests,retry-card-payment-request,dismiss-card-payment-request,list-unconfirmed-card-payments}.ts`, `tools/card-payment-request-tools.unit.ts`
- Modify: the four metafiles, `tool-scopes-drift.unit.ts`

- [ ] `list_card_payment_requests` (read): `status` (`parked` | `recent`).
- [ ] `retry_card_payment_request` (`finance:write`, with the lock as its route has): `requestId`.
- [ ] `dismiss_card_payment_request`: `requestId`. Use `finance:delete` and add it to `DESTRUCTIVE_TOOLS` if the service deletes the row; use `finance:write` if it marks it.
- [ ] `list_unconfirmed_card_payments` (read). The description says a stale plan is removed with `delete_transaction`.
- [ ] unit test `card-payment-request-tools.unit.ts`.
- [ ] metafiles under `// Apple Pay ingest`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='<the waiting-payments suites the Apple Pay plan names>|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

**Merge:** once Tasks 26–27 pass, merge `feat/apple-pay-ingest` into `dev` in the main checkout. This follows that feature's own merge, if its plan has not merged it already. Then run the unit gate and the two tasks' e2e patterns on `dev`.

### Final group: `feat/mcp-coverage`

### Task 28: Verify acceptance criteria

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

- [ ] `git merge dev` (brings in Group D if it has landed).
- [ ] re-run the route audit:
  - the route extraction over `packages/backend/src/routes/**/*.ts`;
  - every ➕ route in the matrix has its tool registered;
  - no route was added since this plan without a status (if one was, add a ➕ task or a ⛔ reason here).
- [ ] the tool count in `server-card.json` equals the registered tools (`server-registration-drift`), and equals 103 + the new tools of the landed groups.
- [ ] the guards match the REST routes, tool by tool:
  - every write tool passes the lock rule or is in `LOCK_EXEMPT_TOOLS` with a matching REST route that has no `checkBaseCurrencyLock`;
  - every non-GET route in `routes/*.ts` that carries `checkBaseCurrencyLock` and has a tool maps to a tool that calls the lock, including read-named ones (`LOCK_GUARDED_READ_TOOLS`: `preview_transaction_automation`, `list_transfer_suggestions`);
  - every `READ_ONLY_ROUTES` entry that has a tool maps to a tool in `READ_ONLY_ROUTE_TOOLS`, and no other tool passes `allowReadOnly`;
  - every rate-limited route that has a tool maps to a tool that calls `enforceUserRateLimit` (`grep -n RateLimit routes/*.ts`);
  - every `delete_*` and `DESTRUCTIVE_TOOLS` tool requires `finance:delete`.
- [ ] measure the `tools/list` size and record it here.
  - Use a one-off script under the scratchpad, not committed: `captureTools` over every register function, `z.toJSONSchema(z.object(shape))` per tool, plus name and description.
  - Record the tool count, total bytes, and the five largest tools.
  - Write the figures under this task as a short note (the Overview's lazy-loading assumption for ~250 tools rests on them).
  - **Threshold:** the full `tools/list` JSON must stay at or under 300,000 bytes (about 75k tokens). That is the budget for a client that loads every tool up front; a lazy client such as Claude Code only pays for names.
  - **If it is over, this task stays open and the fix lands on `feat/mcp-coverage` before the final merge to `dev` (and any deploy)**, in this order, stopping at the first step that gets under the threshold:
    1. cut the descriptions and `.describe()` texts of the five largest tools and any field description that repeats the tool description;
    2. add the smallest toolset switch the installed SDK supports: `createMcpServer({ toolset })`, called at session start in `routes/mcp.route.ts` (the server is built per session, with `mcpAuthInfo` in hand). With `?tools=core` on `/mcp` it calls `RegisteredTool.disable()` on every tool outside a hand-kept `CORE_TOOLS` list; `McpServer` (SDK 1.31, `^1.29` in `package.json`) omits disabled tools from `tools/list` and answers a call to one with "Tool … disabled". The default stays the full set, so existing connections do not change. Add a unit case for the switch and a server-card note.
  - Record which step was needed, or that none was.
- [ ] unit: `npm run test:unit -- --testPathPattern='services/mcp/'`.
- [ ] e2e: one batched run of every gate pattern of Tasks 1–25 (and 26–27 if landed) as a single `--testPathPattern` alternation under `lockf -t 7200 /tmp/mm-e2e.lock`. This is not the full suite.
- [ ] backend typecheck, lint, oxfmt.

### Task 29: [Final] Update documentation

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

- [ ] `packages/frontend/public/skills/connect-moneymatter/SKILL.md`:
  - group the "Available tools" table by the same sections as `server.ts`;
  - every tool has a row, including the venture tools missing today;
  - "Data conventions" covers planned transactions (confirm through `confirm_planned_transaction`; `search_transactions` needs a future `endDate` to see future plans), budget plans versus trackers, and the base-currency lock (writes fail while a base-currency change runs);
  - recompute the sha256 in `agent-skills/index.json`.
- [ ] `prompts/financial-data-guide.ts`:
  - replace "the period-based Budget plan is not available through these tools" with how budget plans differ from trackers;
  - add the planned-transaction and base-currency-change notes;
  - the prompt name is unchanged, so the server card's prompts stay as they are.
- [ ] `packages/docs/src/content/docs/ai/connect-claude-chatgpt-mcp.mdx`:
  - "What you can ask": the new areas (account groups, budget plans, loans, vehicles, currencies and rates, notifications, settings, reconciliation, import undo), with two or three new example prompts;
  - the permissions table's examples;
  - a short "What the assistant can't do" list matching the exclusions (bank connections and syncs, sharing, file imports and downloads, AI settings, account deletion);
  - `cd packages/docs && npm run build` passes and the link check is clean.
- [ ] `.claude/skills/add-mcp-tool/SKILL.md`: the reference examples point at one tool per pattern added here (a consolidated read, a gated write, a lock-exempt write).
- [ ] move this plan to `docs/plans/completed/`, unless Group D is still open; then leave it in place with a note.

**Merge:** once Tasks 28–29 pass, merge `feat/mcp-coverage` into `dev` in the main checkout (`git switch dev` with a clean tree, then `git merge feat/mcp-coverage`). Run the unit gate on `dev`.

## Post-Completion

_Items requiring manual work or external systems; no checkboxes._

**Deployment and smoke test (ritchie):**

- Build and deploy `dev` on the ritchie instance (`money.nemirovsky.dev`).
- Through the Claude Code `moneymatter` MCP connection (Cloudflare Access service token), list the tools. Then run one read and one write per new group against a throwaway account:
  - confirm a planned transaction;
  - create and delete an account group;
  - add and remove a tag reminder;
  - fetch a budget plan period.

**Tool count decision:**

- About 250 tools rely on clients loading tools lazily (Claude Code does, through tool search). A client that loads every tool up front may truncate the list or spend much of its context on it. Task 28 records the measured `tools/list` size.
- Task 28 enforces a 300,000-byte budget before the final merge to `dev`, with description trimming and a `?tools=core` switch (via `RegisteredTool.disable()`) as its mitigations. If the owner's clients still struggle after that, choose a follow-up:
  - scope-based toolsets (disable the write and delete tools for a read-only grant);
  - folding the rarest tools into fewer consolidated tools.

**Upstream:**

- The currency tools ride on `feat/custom-currencies` and `feat/currency-rate-sources` and go upstream with those PRs, together with the lock helper (Task 1) and the shared rate limiter (Task 2) they depend on. Group A and the guards in Task 3 can be offered upstream as one MCP coverage PR, after the owner's discussion with letehaha.
