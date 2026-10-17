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
   - checks that live only in some controllers;
   - nothing checks that a tool file is actually registered in `server.ts`.

   Task 3 adds the missing guards and a registration drift test, and brings the `add-mcp-tool` skill up to date. The skill's template still omits `requireScope`, which every write tool calls.

Every tool is a thin wrapper over the service its REST route already uses. When a controller holds logic that a tool needs, the plan moves that logic into a service and has both callers use it, so REST and MCP cannot drift.

When this plan is done, the server has about 250 tools (about 260 with Apple Pay). The Verify task measures the size of the `tools/list` payload, because some MCP clients cap the tool count or the context it takes (Post-Completion).

## Context (from discovery)

- **MCP server:**
  - `server.ts` (`createMcpServer`, version `1.0.0`) registers 103 tools from `tools/*.ts`; the venture tools are re-exported through `tools/venture-tools.ts`. There is one prompt, `prompts/financial-data-guide.ts`.
  - Helpers live in `tools/helpers.ts`: `getUserId`, `requireScope` (it also rejects demo and read-only users), `jsonContent`, `assertOriginalCurrencyArgs`.
  - Output is slimmed by `serializers.ts` (`slimAccountsForMcp`, …).
- **Auth and scopes:**
  - The `/mcp` route gate (`routes/mcp.route.ts`, `mcp-scope-gate.e2e.ts`) requires `finance:read` for every call.
  - Read tools (`^(get|list|search|preview)_`) call no scope helper. Write tools call `requireScope({ extra, scope: 'finance:write' })`. Tools that permanently delete call it with `'finance:delete'`.
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
  - **`checkBaseCurrencyLock`** guards almost every REST write, through `isBaseCurrencyChangeLocked({ userId })` in `@services/currencies/base-currency-lock`. No MCP tool calls it.
  - **`requireFeature`** (`middlewares/entitlements.ts`): `budget_plan` on budget-plan writes, `attachments` on attachment delete, `fire_planner` when a settings patch carries `fire`. `services/mcp/auth.ts` loads `getEntitlementsByUserId` but keeps only `readOnly`.
  - **`blockDemoUsers` and `enforceReadOnly`** are already covered by `requireScope`.
  - **Rate limiters** are Express-only. MCP tools have none, as today.
- **Controller-only logic a tool would otherwise copy:**
  - account update checks (`currentBalance` only on system accounts; no move into or out of the `vehicle` category);
  - refund recommendations, transfer recommendations, transfer bulk scan and dismissal (all inline in `controllers/transactions.controller/`);
  - the holding creation from a search result;
  - the rate-source save follow-ups (`backfillCoingeckoRates`, `fetchHttpRateAfterSave`);
  - the change-base supported-currency check;
  - the budget-plan goal `superRefine`;
  - the import-batch delete fallback to a queued job;
  - the loan view assembly (`projectLoan` + `countLoanPayments` + `serializeLoan`).
- **Planned transactions:**
  - The web app confirms a plan with `PUT /transactions/:id` `{ isPlanned: false }`, adding `time: now` when the plan is still in the future (`upcoming-section.vue`).
  - The service refuses it on bank-connected accounts (`plannedUnflipOnConnectedAccount`).
  - On `dev`, confirming also settles the linked subscription period (`42141245`).
  - `update_transaction` has no `isPlanned`.
  - `search_transactions` has no `isPlanned` filter, and its `endDate` defaults to now, so future plans are hidden.
- **`dev` moved after this worktree was cut** (`90bf0925` to `17e13dd7`, the per-currency-precision merge):
  - Stats, tracker and budget-plan engines now take base or plan `decimals` (`getBaseCurrencyDecimals`), and their serializers take `{ …, decimals }`.
  - Five existing stats tools were updated there.
  - New stats, tracker and plan tools must copy the decimals handling from the controllers on `dev`, which Task 3's merge brings in.
- **Bugs and gaps noticed, outside this plan's scope:**
  - `GET /transactions/:id/refunds` validates `query.transactionId` and ignores `:id`.
  - `get_balance_history` omits `includeCreditLimit` in its combined branch (fixed in Task 15).
- **Branches and worktrees** (state on 2026-10-17):

  | Tools for                                      | Branch                       | Worktree                                                                                                            |
  | ---------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
  | custom currencies (CRUD, decimals, logo)       | `feat/custom-currencies`     | `/Users/nemirovsky/Developer/moneymatter-currencies`                                                                |
  | rate sources, rate history, dated manual rates | `feat/currency-rate-sources` | main checkout `/Users/nemirovsky/Developer/moneymatter`, after `git switch`                                         |
  | Apple Pay ingest tokens, card mappings         | `feat/apple-pay-ingest`      | `/Users/nemirovsky/Developer/moneymatter-applepay`, only after the Apple Pay plan finishes (⏸)                       |
  | everything else                                | `feat/mcp-coverage`          | `/Users/nemirovsky/Developer/moneymatter-mcp`                                                                       |

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

  The currency branches are upstream PR candidates, so `dev` is never merged into them. They get their tools first, and Task 3 adds the lock check to those tools on `feat/mcp-coverage`.
- **Testing approach:** regular, code first and tests in the same task. Each tool is a thin wrapper, and the risk sits in argument mapping, scopes and guards, which the unit tests cover. Where a task moves controller logic into a service, the existing REST e2e suites of that route stay green without edits to their expectations. That is the proof the move kept behaviour.
- **Gates name exactly which tests must pass:**
  - Unit: `cd packages/backend && npm run test:unit -- --testPathPattern='services/mcp/'`. It covers the drift suites and every new tool unit test.
  - e2e: one batched run per gate, `cd packages/backend && lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='...'`. It runs through `test-runner`, never in parallel, and never the full suite. Every pattern includes `services/mcp/(connected-apps|mcp-scope-gate)`.
  - Then backend typecheck, lint and oxfmt.
- **One area per task, 4–8 tools.** Follow the `add-mcp-tool` skill for every tool, as updated in Task 3.
- **Mirror the REST route** for each tool:
  - the same service;
  - the same validation (reuse the controller's zod schema or fields where they are exported, or export them);
  - the same lock and feature gate;
  - the same serializer, slimmed for MCP where the output is large.
- Complete each task fully before the next. **Keep this plan current** when scope changes.
- **Commits:** as the exec flow makes them, one per task; no pushes.

## Testing Strategy

- **Backend unit** (`npm run test:unit` in `packages/backend`): one `tools/<area>-tools.unit.ts` per task, built on Task 3's `captureTools`. For every new tool:
  - its input schema accepts a valid input and rejects an invalid one (a wrong enum, a missing id, a mutually exclusive pair);
  - a write tool throws without its scope, throws while the base-currency lock is set (unless exempt), and throws without the feature when it has a gate. In each case the service mock is not called;
  - the handler calls the service with `userId` and the mapped arguments, and returns `jsonContent` of the result;
  - a read tool works with no scope helper;
  - conditional behaviour, such as `change_base_currency` with and without a base currency, or `ignore_payee_name` with `force`.
- **Drift and registration** (unit, every gate): `server-card-drift`, `agent-skills-drift`, `tool-scopes-drift` (extended in Task 3), and `server-registration-drift` (new in Task 3).
- **Backend e2e:** the MCP suites plus the REST suites of the routes each task wraps. These guard every service the task touches, and any logic it moves out of a controller.
- **No frontend changes.** The docs site build runs in Task 29.

## Progress Tracking

- Mark completed items `[x]` immediately.
- Prefix newly discovered tasks with ➕ and blockers with ⚠️.
- Keep this plan in sync with the actual work.

## Solution Overview

- **Tool shape.** Each tool is one file in `tools/`, following the skill's template, with three changes after Task 3:
  - write tools call `requireScope`, then `await assertBaseCurrencyUnlocked({ userId })`, then (when gated) `await requireFeatureAccess({ userId, feature })`, before `trackMcpToolUsed`;
  - errors are thrown as `Error`s with the same i18n message the REST route returns;
  - output goes through the route's serializer, and lists through an MCP slim helper in `serializers.ts` when the REST payload carries UI-only fields.
- **Consolidation.** Routes that differ only by an id or a filter share one tool:
  - `get_transactions` takes ids or a transfer id;
  - `get_refunds` lists, or reads one pair, or reads one transaction's refunds;
  - `get_user_currencies` returns currencies, base and pair rates;
  - `get_notifications` returns the list, one item and the unread count.

  This keeps the tool count near one per action, not one per route.
- **Planned transactions** get `confirm_planned_transaction` and an `isPlanned` filter on `search_transactions`. `update_transaction` stays without `isPlanned`, so a plan is confirmed only through one tool with one clear contract.
- **Guards.** Task 3 adds `assertBaseCurrencyUnlocked` and `requireFeatureAccess` to `tools/helpers.ts` and applies the lock check to every existing write tool. `tool-scopes-drift.unit.ts` then fails for any write tool without it, unless the tool is listed in `LOCK_EXEMPT_TOOLS` (whose REST route has no lock: `change_base_currency`, notification reads, settings patch and others).
- **Excluded routes** are listed with a reason under Technical Details. They do not get tools in this plan.

## Technical Details

### Tool conventions

- **Names:**
  - read tools start with `get_`, `list_`, `search_` or `preview_`, and nothing else does;
  - `delete_*` tools require `finance:delete`;
  - other tools that permanently remove data (`bulk_delete_*`, `merge_duplicate_transactions`, `revoke_ingest_token`, `dismiss_card_payment_request` if it deletes) also require `finance:delete` and are added to `DESTRUCTIVE_TOOLS`.
- **Ids:**
  - `recordId()` from `@common/lib/zod/custom-types` for record ids;
  - money as decimal numbers (investment amounts as the decimal strings their REST schemas use);
  - dates as ISO strings converted with `new Date()` where the service wants a `Date`.
- **Pagination caps:** reuse the REST limits (for example notifications 1–100, batches 1–100, budget category transactions 1–100). `get_transactions` caps `ids` at 100.
- **Write guard order:** `getUserId` → `requireScope` → `assertBaseCurrencyUnlocked` (unless exempt) → `requireFeatureAccess` (when gated) → `trackMcpToolUsed` → service.
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

### Helpers added in Task 3

- `assertBaseCurrencyUnlocked({ userId })`:
  - `isBaseCurrencyChangeLocked`; throws `t({ key: 'currencies.baseCurrencyChangeInProgress' })`;
  - fails closed with `t({ key: 'common.serviceTemporarilyUnavailable' })` when Redis throws, as the middleware does.
- `requireFeatureAccess({ userId, feature })`: `getEntitlementsByUserId`; throws the same message as `requireFeature`'s 402 when the feature is missing.
- `services/mcp/test-utils.ts`:
  - `captureTools({ register })` returns `[{ name, config, handler }]`;
  - `makeExtra({ userId, scopes, readOnly = false, role })` builds the `extra` that `getUserId` and `requireScope` read.

### Route audit

Legend:
- ✅ covered by an existing tool;
- ➕ T*n* gets a tool in Task *n* (E = extends an existing tool);
- ⛔ excluded, with a reason key from "Excluded routes".

Paths are relative to each mount; Apple Pay routes are in Group D.

**`/accounts`** (9: ✅ 2, ➕ 6, ⛔ 1)

| Route                          | Status | Tool / reason                         |
| ------------------------------ | ------ | ------------------------------------- |
| GET /                          | ✅     | `get_accounts`                        |
| GET /:id                       | ➕ T4  | `get_account`                         |
| GET /:id/transaction-count     | ➕ T4  | `get_account` (`transactionCount`)    |
| POST /                         | ➕ T4  | `create_account`                      |
| PUT /:id                       | ➕ T4  | `update_account` (status stays with `archive_account`) |
| DELETE /:id                    | ➕ T4  | `delete_account`                      |
| POST /:id/unlink               | ➕ T4  | `unlink_account_from_bank_connection` |
| POST /:id/link                 | ⛔     | bank                                  |
| POST /:id/balance-adjustment   | ✅     | `adjust_account_balance`              |

**`/account-group`** (`account-groups.ts`, 8: ➕ 8)

| Route                                    | Status | Tool                          |
| ---------------------------------------- | ------ | ----------------------------- |
| POST /                                   | ➕ T5  | `create_account_group`        |
| GET /                                    | ➕ T5  | `get_account_groups`          |
| PUT /:groupId                            | ➕ T5  | `update_account_group`        |
| DELETE /:groupId                         | ➕ T5  | `delete_account_group`        |
| POST /:groupId/add-account/:accountId    | ➕ T5  | `add_account_to_group`        |
| DELETE /:groupId/accounts                | ➕ T5  | `remove_accounts_from_group`  |
| PUT /:groupId/move                       | ➕ T5  | `move_account_group`          |
| GET /:groupId/accounts                   | ➕ T5  | `get_account_groups` (`groupId`) |

**`/transactions`** (38: ✅ 13, ➕ 22, ⛔ 3)

| Route                                        | Status | Tool / reason                                        |
| -------------------------------------------- | ------ | ---------------------------------------------------- |
| POST /:transactionId/attachments             | ✅     | `create_attachment_upload_url` (token URL)           |
| GET /refund                                  | ➕ T8  | `get_refunds` (pair)                                 |
| GET /refunds                                 | ➕ T8  | `get_refunds`                                        |
| GET /refund-recommendations                  | ➕ T8  | `get_refund_recommendations`                         |
| GET /planned-summary                         | ➕ T7  | `get_planned_summary`                                |
| GET /summary                                 | ➕ T7  | `get_transactions_summary`                           |
| GET /transfer-recommendations                | ➕ T8  | `get_transfer_recommendations`                       |
| POST /transfer-recommendations/bulk-scan     | ➕ T8  | `list_transfer_suggestions`                          |
| POST /transfer-recommendations/dismiss       | ➕ T8  | `dismiss_transfer_suggestion`                        |
| POST /refund                                 | ✅     | `link_refund`                                        |
| POST /match-invoice                          | ⛔     | file                                                 |
| POST /match-invoice/candidates               | ⛔     | file (second step of the upload flow)                |
| DELETE /refund                               | ✅     | `unlink_refund`                                      |
| GET /reconciliation/history                  | ➕ T9  | `get_reconciliation_history`                         |
| GET /reconciliation/stuck-pending            | ➕ T9  | `list_stuck_pending_transactions`                    |
| POST /reconciliation/remove                  | ➕ T9  | `remove_duplicate_transactions`                      |
| POST /reconciliation/merge                   | ➕ T9  | `merge_duplicate_transactions`                       |
| POST /reconciliation/restore                 | ➕ T9  | `restore_removed_transactions`                       |
| POST /reconciliation/keep-as-booked          | ➕ T9  | `keep_pending_as_booked`                             |
| POST /reconciliation/stuck-pending/check     | ⛔     | bank                                                 |
| DELETE /splits/:splitId                      | ✅     | `delete_split`                                       |
| POST /:transactionId/link-to-portfolio       | ✅     | `link_transaction_to_portfolio`                      |
| POST /:transactionId/unlink-from-portfolio   | ✅     | `unlink_transaction_from_portfolio`                  |
| GET /:transactionId/portfolio-link           | ➕ T7  | `get_transaction_links`                              |
| GET /:transactionId/venture-link             | ➕ T7  | `get_transaction_links`                              |
| GET /:transactionId/attachments              | ➕ T7  | `list_transaction_attachments`                       |
| GET /                                        | ✅     | `search_transactions` (E T7: `isPlanned`)            |
| GET /by-ids                                  | ➕ T7  | `get_transactions`                                   |
| GET /:id                                     | ➕ T7  | `get_transactions`                                   |
| GET /:id/refunds                             | ➕ T8  | `get_refunds` (`transactionId`)                      |
| GET /transfer/:transferId                    | ➕ T7  | `get_transactions` (`transferId`)                    |
| POST /                                       | ✅     | `create_transaction`                                 |
| PUT /unlink                                  | ✅     | `unlink_transfer`                                    |
| PUT /link                                    | ✅     | `link_transfer` (one pair per call)                  |
| PUT /bulk                                    | ✅     | `bulk_update_transactions`                           |
| POST /bulk-delete                            | ➕ T7  | `bulk_delete_transactions`                           |
| PUT /:id                                     | ✅     | `update_transaction`; `isPlanned: false` → `confirm_planned_transaction` (T7) |
| DELETE /:id                                  | ✅     | `delete_transaction`                                 |

**`/attachments`** (2: ➕ 1, ⛔ 1): GET /:id/file ⛔ file; DELETE /:id ➕ T7 `delete_attachment`.

**`/categories`** (5: ✅ 4, ➕ 1): GET / ✅ `get_categories`; POST / ✅ `create_category`; PUT /:id ✅ `update_category`; DELETE /:id ✅ `delete_category`; GET /:id/transaction-count ➕ T12 `get_category_transaction_count`.

**`/tags`** (12: ✅ 6, ➕ 6)

| Route                           | Status | Tool                                                       |
| ------------------------------- | ------ | ---------------------------------------------------------- |
| GET /                           | ✅     | `get_tags`                                                 |
| GET /:id                        | ➕ T12 | `get_tags` (E: `tagId`)                                    |
| POST /                          | ✅     | `create_tag`                                               |
| PUT /:id                        | ✅     | `update_tag`                                               |
| DELETE /:id                     | ✅     | `delete_tag`                                               |
| POST /:id/transactions          | ✅     | `assign_tags_to_transaction`, `bulk_update_transactions`   |
| DELETE /:id/transactions        | ✅     | `remove_tags_from_transaction`                             |
| GET /:tagId/reminders           | ➕ T13 | `get_tag_reminders`                                        |
| GET /:tagId/reminders/:id       | ➕ T13 | `get_tag_reminders`                                        |
| POST /:tagId/reminders          | ➕ T13 | `create_tag_reminder`                                      |
| PUT /:tagId/reminders/:id       | ➕ T13 | `update_tag_reminder`                                      |
| DELETE /:tagId/reminders/:id    | ➕ T13 | `delete_tag_reminder`                                      |

**`/tag-reminders`** (1: ➕ 1): GET / ➕ T13 `get_tag_reminders`.

**`/payees`** (16: ✅ 7, ➕ 8, ⛔ 1)

| Route                              | Status | Tool / reason                                         |
| ---------------------------------- | ------ | ----------------------------------------------------- |
| GET /                              | ✅     | `get_payees`                                          |
| POST /                             | ✅     | `create_payee`                                        |
| GET /lookup                        | ✅     | `get_payees` (same id and name list)                  |
| PATCH /bulk-categorization-mode    | ➕ T11 | `set_payees_categorization_mode`                      |
| POST /bulk-delete                  | ➕ T11 | `bulk_delete_payees`                                  |
| GET /ignored-names                 | ➕ T11 | `get_ignored_payee_names`                             |
| POST /ignored-names                | ➕ T11 | `ignore_payee_name`                                   |
| DELETE /ignored-names/:id          | ➕ T11 | `unignore_payee_name`                                 |
| GET /:id                           | ✅     | `get_payee`                                           |
| PATCH /:id                         | ✅     | `update_payee` (E T11: mode, default tags, location, logo) |
| DELETE /:id                        | ✅     | `delete_payee`                                        |
| POST /:id/merge                    | ✅     | `merge_payees`                                        |
| POST /:id/apply-tags               | ➕ T11 | `apply_payee_tags_to_transactions`                    |
| POST /:id/aliases                  | ➕ T11 | `create_payee_alias`                                  |
| DELETE /:id/aliases/:aliasId       | ➕ T11 | `delete_payee_alias`                                  |
| POST /:id/reset-logo               | ⛔     | cosmetic                                              |

**`/budgets`** (trackers; 11: ✅ 8, ➕ 3)
- ✅: GET / `get_budgets`; GET /:id/spending-stats `get_budget_spending_stats`; POST / `create_budget`; PUT /:id `update_budget`; PATCH /:id/archive `archive_budget`; DELETE /:id `delete_budget`; POST /:id/transactions `add_transactions_to_budget`; DELETE /:id/transactions `remove_transactions_from_budget`.
- ➕ T13: GET /:id `get_budget`; GET /:id/stats `get_budget`; GET /:id/category-transactions `get_budget_transactions`.

**`/budget-plans`** (26: ➕ 26)

| Route                                                      | Status | Tool                                       |
| ---------------------------------------------------------- | ------ | ------------------------------------------ |
| GET /                                                      | ➕ T20 | `list_budget_plans`                        |
| GET /suggestion-context                                    | ➕ T20 | `get_budget_plan_suggestion_context`       |
| GET /:planId                                               | ➕ T20 | `list_budget_plans` (`planId`)             |
| GET /:planId/trends                                        | ➕ T20 | `get_budget_plan_trends`                   |
| GET /:planId/periods                                       | ➕ T20 | `list_budget_plan_periods`                 |
| GET /:planId/periods/:periodId                             | ➕ T20 | `get_budget_plan_period`                   |
| GET /:planId/periods/:periodId/scheduled                   | ➕ T20 | `get_budget_plan_scheduled`                |
| POST /                                                     | ➕ T21 | `create_budget_plan`                       |
| PATCH /:planId                                             | ➕ T21 | `update_budget_plan`                       |
| DELETE /:planId                                            | ➕ T21 | `delete_budget_plan`                       |
| POST /:planId/restore                                      | ➕ T21 | `restore_budget_plan`                      |
| PUT /:planId/accounts                                      | ➕ T21 | `set_budget_plan_accounts`                 |
| POST /:planId/groups                                       | ➕ T21 | `create_budget_plan_group`                 |
| PATCH /:planId/groups/:groupId                             | ➕ T21 | `update_budget_plan_group`                 |
| DELETE /:planId/groups/:groupId                            | ➕ T21 | `delete_budget_plan_group`                 |
| PUT /:planId/layout                                        | ➕ T22 | `set_budget_plan_layout`                   |
| POST /:planId/lines                                        | ➕ T22 | `create_budget_plan_line`                  |
| POST /:planId/suggested-lines                              | ➕ T22 | `add_suggested_budget_plan_lines`          |
| PATCH /:planId/lines/:lineId                               | ➕ T22 | `update_budget_plan_line`                  |
| DELETE /:planId/lines/:lineId                              | ➕ T22 | `delete_budget_plan_line`                  |
| POST /:planId/lines/:lineId/archive                        | ➕ T22 | `archive_budget_plan_line`                 |
| POST /:planId/lines/:lineId/restore                        | ➕ T22 | `archive_budget_plan_line` (`archived: false`) |
| PUT /:planId/lines/:lineId/goal                            | ➕ T23 | `set_budget_plan_line_goal`                |
| DELETE /:planId/lines/:lineId/goal                         | ➕ T23 | `delete_budget_plan_line_goal`             |
| POST /:planId/lines/:lineId/goal/snooze                    | ➕ T23 | `snooze_budget_plan_line_goal`             |
| PUT /:planId/periods/:periodId/lines/:lineId/assignment    | ➕ T23 | `set_budget_plan_assignment`               |

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

| Route                                              | Status | Tool / reason                         |
| -------------------------------------------------- | ------ | ------------------------------------- |
| GET /portfolios                                    | ✅     | `get_portfolios`                      |
| GET /portfolios/annualized-returns                 | ➕ T16 | `get_portfolios_overview`             |
| GET /portfolios/summaries                          | ➕ T16 | `get_portfolios_overview`             |
| GET /portfolios/:id                                | ➕ T16 | `get_portfolio`                       |
| GET /portfolios/:id/balance                        | ✅     | `get_portfolio_balances`              |
| GET /portfolios/:id/summary                        | ✅     | `get_portfolio_summary`               |
| PUT /portfolios/:id/balance                        | ⛔     | internal (test and dev seeding only)  |
| POST /portfolios/:id/cash-transaction              | ✅     | `create_portfolio_cash_transaction`   |
| POST /portfolios/:id/transfer                      | ➕ T16 | `transfer_between_portfolios`         |
| POST /portfolios/:id/exchange-currency             | ➕ T16 | `exchange_portfolio_currency`         |
| POST /portfolios/:id/transfer/from-account         | ✅     | `transfer_account_to_portfolio`       |
| POST /portfolios/:id/transfer/to-account           | ✅     | `transfer_portfolio_to_account`       |
| GET /portfolios/:id/transfers                      | ✅     | `list_portfolio_transfers`            |
| PATCH /portfolios/:id/transfers/:transferId/adjustment | ➕ T16 | `set_portfolio_transfer_adjustment` |
| DELETE /portfolios/:id/transfers/:transferId       | ➕ T16 | `delete_portfolio_transfer`           |
| PUT /portfolios/:id                                | ✅     | `update_portfolio`                    |
| DELETE /portfolios/:id                             | ✅     | `delete_portfolio`                    |
| POST /portfolios/:id/restore                       | ➕ T16 | `restore_portfolio`                   |
| POST /portfolios                                   | ✅     | `create_portfolio`                    |
| POST /sync/securities-prices                       | ⛔     | admin                                 |
| GET /prices                                        | ➕ T17 | `get_security_prices`                 |
| GET /securities                                    | ⛔     | redundant (`search_securities`)       |
| GET /securities/search                             | ✅     | `search_securities`                   |
| POST /securities/price-upload-info                 | ⛔     | admin                                 |
| POST /securities/prices/bulk-upload                | ⛔     | admin                                 |
| GET /portfolios/:portfolioId/holdings              | ✅     | `get_portfolio_holdings`              |
| POST /holding                                      | ➕ T17 | `create_holding`                      |
| DELETE /holding                                    | ➕ T17 | `delete_holding`                      |
| GET /transactions                                  | ✅     | `get_investment_transactions`         |
| POST /transaction                                  | ✅     | `create_investment_transaction`       |
| DELETE /transaction/:transactionId                 | ✅     | `delete_investment_transaction`       |
| PUT /transaction/:transactionId                    | ✅     | `update_investment_transaction`       |
| POST /transactions-import/estimate-cost            | ⛔     | import                                |
| POST /transactions-import/extract                  | ⛔     | import                                |
| POST /transactions-import/execute                  | ⛔     | import                                |

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

| Route                                         | Status | Tool / reason                                    |
| --------------------------------------------- | ------ | ------------------------------------------------ |
| GET /                                         | ✅     | `get_user_profile`                               |
| POST /feature-trials/:feature                 | ⛔     | account                                          |
| PUT /update                                   | ⛔     | account (identity fields; no `profile:write` scope) |
| DELETE /delete                                | ⛔     | account                                          |
| POST /wipe-data                               | ⛔     | account                                          |
| POST /data-export                             | ⛔     | file                                             |
| POST /backup                                  | ⛔     | file                                             |
| POST /backup/restore                          | ⛔     | file                                             |
| GET /backup/restore/status                    | ⛔     | file                                             |
| GET /backup/restore/status/:jobId             | ⛔     | file                                             |
| GET /currencies                               | ➕ T6  | `get_user_currencies`                            |
| GET /currencies/base                          | ➕ T6  | `get_user_currencies`                            |
| GET /currencies/rates                         | ➕ T6  | `get_user_currencies`                            |
| POST /currencies                              | ➕ T6  | `add_user_currencies`                            |
| GET /currencies/custom                        | ➕ T1  | `list_custom_currencies`                         |
| GET /currencies/coingecko/search              | ➕ T2  | `search_coingecko_coins`                         |
| POST /currencies/custom                       | ➕ T1  | `create_custom_currency`                         |
| PUT /currencies/custom/:code                  | ➕ T1  | `update_custom_currency`                         |
| DELETE /currencies/custom/:code               | ➕ T1  | `delete_custom_currency`                         |
| POST /currencies/base                         | ➕ T6  | `change_base_currency` (first base)              |
| PUT /currencies/:code/rate-source             | ➕ T2  | `set_currency_rate_source`                       |
| GET /currencies/:code/rate-history            | ➕ T2  | `get_currency_rate_history`                      |
| POST /currencies/:code/rate-source/test       | ➕ T2  | `test_currency_rate_source`                      |
| POST /currencies/change-base                  | ➕ T6  | `change_base_currency`                           |
| GET /currencies/change-base/status            | ➕ T6  | `get_base_currency_change_status`                |
| PUT /currency                                 | ➕ T6  | `update_user_currency`                           |
| PUT /currency/rates                           | ➕ T2  | `set_exchange_rates`                             |
| DELETE /currency                              | ➕ T6  | `delete_user_currency`                           |
| DELETE /currency/rates                        | ➕ T2  | `delete_exchange_rates`                          |
| GET /settings                                 | ➕ T14 | `get_user_settings`                              |
| PUT /settings                                 | ➕ T14 | `update_user_settings` (patch semantics)         |
| PATCH /settings                               | ➕ T14 | `update_user_settings`                           |
| GET /settings/onboarding                      | ⛔     | ui                                               |
| PUT /settings/onboarding                      | ⛔     | ui                                               |
| /settings/ai/connections (7 routes)           | ⛔     | ai                                               |
| GET /settings/ai/cli/availability             | ⛔     | ai                                               |
| /settings/ai/cli/auth-sessions (4 routes)     | ⛔     | ai (also admin and self-host only; PTY sign-in)  |
| /settings/ai/features (4 routes)              | ⛔     | ai                                               |
| /settings/ai/custom-instructions (2 routes)   | ⛔     | ai                                               |
| /ai/categorization/* (4 routes)               | ⛔     | ai                                               |
| GET /settings/mcp/connected-apps              | ⛔     | auth (the OAuth grants themselves)               |
| DELETE /settings/mcp/connected-apps/:clientId | ⛔     | auth                                             |

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

| Mount | Routes | Reason |
| --- | --- | --- |
| `/auth` (better-auth-extensions) | signups-open, features, set-password | auth |
| `/billing` | checkout, portal | account |
| `/admin` | PATCH /users/:id/plan | admin |
| `/brand-logos` | GET /search | cosmetic |
| `/resource-leases` | POST /refresh | import (keeps an ms-money/ofx upload alive) |
| `/client-logs` | POST / | transport (frontend telemetry) |
| `/sse` | GET /events | transport |
| `/mcp` | POST, GET, DELETE / | transport (the MCP endpoint itself) |
| `/webhooks` | POST /github, POST /billing | transport |
| `/github`, `/landing`, `/demo` | GET /activity, POST /faq/ask, POST / | transport (public landing and demo) |
| `/tests` | 3 routes | internal (mounted only in test) |

OAuth metadata (`oauth-metadata.route.ts`) registers `app.get` routes outside the router count and is auth.

**Totals** (401 routes):

| Group | Routes |
| --- | --- |
| ✅ covered today | 103 |
| ➕ planned | 175 (Group B 4, Group C 6, Group A 165) |
| ⛔ excluded | 123 |

Recount from the tables:
- ⛔: accounts 1, attachments 1, transactions 3, payees 1, subscriptions 1, investments 8, notifications 1, user 35, share 9, bank 16, import 26, other mounts 21.

  That sums to 123. "Other mounts" are auth 3, billing 2, admin 1, brand-logos 1, resource-leases 1, client-logs 1, sse 1, mcp 3, webhooks 2, github, landing and demo 3, tests 3.

Without a tool today: 298 routes, of which 175 get one and 123 stay out.

Planned new tools: 147 on the path to `dev` (B 4, C 6, A 137), plus about 10 in Group D. The server grows from 103 to about 250 tools.

### Excluded routes (reasons)

| Key | Routes | Why no tool |
| --- | --- | --- |
| auth | `/auth/*`, OAuth metadata, `/user/settings/mcp/connected-apps*` | Sign-in, password and OAuth-grant management. An MCP client must not manage its own grants; revoking stays in Settings. |
| account | billing checkout and portal, feature trials, profile update, user delete, data wipe | Account lifecycle and payment redirects. There is no `profile:write` scope, and deleting or wiping the account must stay a deliberate in-app action. |
| admin | `/admin/*`, securities price sync, upload info and bulk upload | Operator-only routes behind `adminOnly`. |
| internal | `/tests/*`, `POST /notifications`, `PUT /investments/portfolios/:id/balance` | Test-only or test seeding routes, or a route background jobs use. |
| transport | `/mcp`, `/sse`, `/webhooks/*`, `/client-logs`, `/github`, `/landing`, `/demo` | Transports, signed webhooks, telemetry and public pages. |
| bank | connect, reauthorize, OAuth callback, Enable Banking country and bank lists, available accounts, account link, every sync and load action, stuck-pending check, disconnect, connection edit, reconcile-duplicates, provider list | These need the bank's consent flow or a live bank call, which needs the user present (PSU headers). Unattended calls can burn the bank's daily limit (about 4 per day for Enable Banking). Some take the user's provider secrets. Read-only connection and sync status is in T24. |
| file | attachment download, data export, backups and restore, invoice matching | These move file bytes. An MCP client cannot stream them, and base64 through the model context is costly and leaks documents into transcripts. Uploads already use `create_attachment_upload_url`. |
| import | csv, text-source, ynab, budget-bakers-wallet, ms-money, ofx, investment statement import, ai-map-categories, resource leases | These are interactive wizards (parse, map, review duplicates, execute) built around a file. Some spend the server's AI on extraction. An agent records rows through `create_transaction` / `create_investment_transaction`, and can undo an import through T25. |
| share | invitation create, accept, decline, resend, cancel, back-invite; member update and revoke; leave | They grant or revoke another person's access to financial data, and send email. That stays a deliberate in-app action. The reads are in T24. |
| ai | `/user/settings/ai/*`, `/user/ai/categorization/*` | They configure the app's own AI providers (API keys, models, CLI sign-in) and its built-in categorizer. Keys must not pass through a third-party client, and the client categorizes through `bulk_update_transactions`. |
| ui | onboarding checklist | UI state with no data meaning. |
| cosmetic | logo search, payee and subscription logo reset | Visual pickers an agent cannot see. Logo fields stay settable through the update tools. |
| redundant | `GET /investments/securities` | The full global securities list. `search_securities` covers lookup. |

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
- Modify: the four metafiles, `tool-scopes-drift.unit.ts` (no list change expected)

- [ ] read first: the `add-mcp-tool` skill, `controllers/currencies/custom-currencies.ts`, `services/currencies/custom-currencies.service.ts` on this branch, and `tools/transaction-amount-inputs.unit.ts` for the capture pattern. `services/mcp/test-utils.ts` does not exist on this branch, so use a local capture helper in the test file.
- [ ] `list_custom_currencies` (read): `listCustomCurrencies({ userId })`; code, name, symbol, decimals and logo as the REST list returns them.
- [ ] `create_custom_currency` (`finance:write`):
  - `code`, `name`, `decimals` (int in the REST bounds), `symbol?`, using the controller's strict schema (export it if it is local);
  - an ISO code or a duplicate gives the REST error message;
  - the description says custom currencies are per user and need a rate source for base-currency values.
- [ ] `update_custom_currency` (`finance:write`):
  - `code`, plus optional `name`, `decimals`, `symbol` (null clears) and `logoUrl` (null clears) if the branch's schema has it;
  - the description says a decimals change is refused while the user has rows in the currency.
- [ ] `delete_custom_currency` (`finance:delete`): `code`; refused while in use, as REST does.
- [ ] unit test `custom-currency-tools.unit.ts`: the schema cases (an invalid code, decimals out of range); the scope and refusal for each write tool; service args; read output passthrough.
- [ ] metafiles: register in `server.ts` under a new `// Currencies` group, then the `server-card.json` entries, the SKILL.md rows and the sha256.
- [ ] gate:
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
  - `packages/backend/src/services/mcp/tools/{search-coingecko-coins,get-currency-rate-history,set-currency-rate-source,test-currency-rate-source,set-exchange-rates,delete-exchange-rates}.ts`;
  - `tools/rate-source-tools.unit.ts`;
  - `packages/backend/src/services/currencies/rate-sources/save-rate-source.service.ts`.
- Modify: `controllers/currencies/rate-source.ts` (calls the new service), `controllers/user.controller.ts` (the opposite-pair check for rate removal moves into `removeUserExchangeRates`), the four metafiles, `tool-scopes-drift.unit.ts` (`DESTRUCTIVE_TOOLS` unchanged: `delete_exchange_rates` is covered by its prefix)

- [ ] read first: `controllers/currencies/rate-source.ts`, `controllers/currencies/rate-history.ts`, `controllers/currencies/edit-currency-exchange-rate.ts`, `removeUserCurrencyExchangeRate` in `controllers/user.controller.ts`, `services/currencies/rate-sources/index.ts` (the `updateRateSourceBodySchema` union)
- [ ] `save-rate-source.service.ts`:
  - `saveCurrencyRateSource({ userId, code, body })` runs `setCurrencyRateSource`, then the follow-ups the controller runs today: the CoinGecko backfill after commit, or the HTTP first fetch;
  - the controller calls it;
  - the REST behaviour is unchanged.
- [ ] `search_coingecko_coins` (read): `query` (1–100) → `searchCoingeckoCoins`. A missing `COINGECKO_API_KEY` gives the REST "not available" message.
- [ ] `get_currency_rate_history` (read): `code`, `limit` (1–100, default 30), `offset` → `listCurrencyRateHistory`.
- [ ] `set_currency_rate_source` (`finance:write`): `code` plus the `updateRateSourceBodySchema` fields (`rateSource`, `config`, `logoUrl?` for CoinGecko). Calls `saveCurrencyRateSource`. Header values for the HTTP source are accepted but never echoed (the service already returns only `headerNames`).
- [ ] `test_currency_rate_source` (`finance:write`, a preview that saves nothing): `code`, `config`, `date?` → `testHttpRateSource`. Returns `{ ok, … }` as REST does.
- [ ] `set_exchange_rates` (`finance:write`):
  - `pairs[]` of `{ baseCode, quoteCode, rate > 0, effectiveDate? }` → `editUserExchangeRates`;
  - the description says each pair needs its opposite in the same call, and `effectiveDate` applies only to custom currencies.
- [ ] `delete_exchange_rates` (`finance:delete`): `pairs[]` of `{ baseCode, quoteCode, effectiveDate? }`. No `effectiveDate` removes all of a pair's rates. Calls `removeUserExchangeRates`, which now enforces the opposite pair itself.
- [ ] unit test `rate-source-tools.unit.ts`: the schema union (each source, an invalid config), the pair rules, scopes, service args, and that `set_currency_rate_source` calls `saveCurrencyRateSource`.
- [ ] metafiles under the `// Currencies` group.
- [ ] gate:
  - unit: `npm run test:unit -- --testPathPattern='services/(mcp/|currencies/rate-sources/)'`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/currencies/rate-sources/(rate-history|rate-source|http-rate-source|coingecko-rate-source)|services/user-exchange-rate/(dated-user-exchange-rates|update-exchange-rates)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - backend typecheck, lint, oxfmt.

**Merge:** once Task 2 passes, merge `feat/currency-rate-sources` into `dev` in the main checkout: `git switch dev`, then `git merge feat/currency-rate-sources`.
- `dev`'s MCP files changed only in five stats tools, which this group does not touch, so a conflict there is unexpected. If one appears, follow "Merge conflicts" in Technical Details.
- Run Task 1's and Task 2's unit and e2e patterns as one batched run on `dev`.
- Leave the main checkout on `dev`.

### Group A: `feat/mcp-coverage`

### Task 3: Groundwork: write guards, registration drift and the skill

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `packages/backend/src/services/mcp/test-utils.ts`, `packages/backend/src/services/mcp/server-registration-drift.unit.ts`, `packages/backend/src/services/mcp/tools/write-guards.unit.ts`
- Modify: `tools/helpers.ts`, `tools/helpers.unit.ts`, `tool-scopes-drift.unit.ts`, every existing write tool in `tools/`, `.claude/skills/add-mcp-tool/SKILL.md`

- [ ] `git merge dev`. It brings Groups B and C and dev's decimals changes to five stats tools. Resolve per "Merge conflicts" if needed, then run the drift suites.
- [ ] `assertBaseCurrencyUnlocked` and `requireFeatureAccess` in `tools/helpers.ts` (Technical Details, "Helpers added in Task 3"). Unit cases in `helpers.unit.ts` cover: lock set → throws; Redis error → throws the unavailable message; unlocked → passes; feature missing → throws; feature present → passes.
- [ ] `services/mcp/test-utils.ts` with `captureTools` and `makeExtra`.
- [ ] call `await assertBaseCurrencyUnlocked({ userId })` right after `requireScope` in every existing write tool whose REST counterpart carries `checkBaseCurrencyLock`.
  - Check each route in `routes/*.ts`. A tool whose route has no lock (for example `detect_subscription_candidates`, a GET in REST, and `create_attachment_upload_url` if its upload route has none) goes into `LOCK_EXEMPT_TOOLS`, with a comment naming the route.
- [ ] `tool-scopes-drift.unit.ts`:
  - new case "every tool that checks a scope also checks the base-currency lock, unless listed in `LOCK_EXEMPT_TOOLS`";
  - a second case that every `LOCK_EXEMPT_TOOLS` entry exists;
  - export nothing new.
- [ ] `server-registration-drift.unit.ts`: every `export function register\w+` in `tools/*.ts` (and `venture-tools.ts` re-exports) is imported and called as `register…(server)` exactly once in `server.ts`, and `server.ts` calls nothing that is not exported.
- [ ] `write-guards.unit.ts`: with `captureTools`, `archive_account`, `delete_tag` and `create_transaction` throw while the lock is set, and their service mocks are not called. Each also throws for a demo user and for a read-only user.
- [ ] update `.claude/skills/add-mcp-tool/SKILL.md`:
  - the template with `requireScope`, `assertBaseCurrencyUnlocked` and `requireFeatureAccess`;
  - the naming and scope rules (Technical Details, "Tool conventions");
  - `DESTRUCTIVE_TOOLS` and `LOCK_EXEMPT_TOOLS`;
  - "mirror the REST route: same service, validation, lock and feature gate; move controller-only logic into a service instead of copying it";
  - the unit test pattern with `captureTools`;
  - the drift suites (four) and the gate pattern `services/mcp/`;
  - replace "do not add e2e tests" with: the gate runs the MCP e2e suites plus the REST suites of the wrapped routes.
- [ ] gate:
  - unit: `npm run test:unit -- --testPathPattern='services/mcp/'`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='routes/base-currency-guard-coverage|services/currencies/change-base-currency-status|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - backend typecheck, lint, oxfmt.

### Task 4: Account tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-account,create-account,update-account,delete-account,unlink-account-from-bank-connection}.ts`, `tools/account-tools.unit.ts`
- Modify: `services/accounts.service.ts` (or a new `services/accounts/assert-account-update-allowed.ts`), `controllers/accounts.controller.ts`, the four metafiles

- [ ] read first: `controllers/accounts.controller.ts` (`getAccountById`, `createAccount`, `updateAccount`, `deleteAccount`), `controllers/accounts/unlink-from-bunk-connection.ts`, `services/accounts/transaction-count.ts`, `serializers.ts#slimAccountsForMcp`
- [ ] move the controller-only update checks into the service path, used by REST and MCP alike:
  - `currentBalance` only on system accounts;
  - no move into or out of the `vehicle` category.
- [ ] `get_account` (read): `accountId` → `getAccountById`, `attachAccountCurrencyMeta`, `serializeAccount`, slimmed, plus `transactionCount` from `getAccountTransactionCount`. Not found gives a clear error.
- [ ] `create_account` (`finance:write`):
  - `name`, `currencyCode`, `accountCategory` (`ACCOUNT_CATEGORIES`, default `general`), `initialBalance`, `creditLimit` (≥ 0), logo fields (`logoFieldsShape`);
  - `type` is always `system`;
  - amounts through `Money.fromDecimal` as the controller does.
- [ ] `update_account` (`finance:write`): `accountId`, plus optional `name`, `accountCategory`, `creditLimit`, `excludeFromStats`, `currentBalance`, `initialBalance` and logo fields. `status` stays with `archive_account`, and the description says so.
- [ ] `delete_account` (`finance:delete`): `accountId`, `removePortfolioTransfers?` → `deleteAccountById`.
- [ ] `unlink_account_from_bank_connection` (`finance:write`): `accountId` → `unlinkAccountFromBankConnection`. The description says the account becomes manual and keeps its history.
- [ ] unit test `account-tools.unit.ts`, covering the moved checks through `update_account`.
- [ ] metafiles under `// Profile & accounts`.
- [ ] gate:
  - unit: `npm run test:unit -- --testPathPattern='services/mcp/'`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='controllers/accounts.controller|services/accounts/(archive-account|delete-account|transaction-count|balance-adjustment|account-brand-logos)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - backend typecheck, lint, oxfmt.

### Task 5: Account group tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-account-groups,create-account-group,update-account-group,delete-account-group,add-account-to-group,remove-accounts-from-group,move-account-group}.ts`, `tools/account-group-tools.unit.ts`
- Modify: the four metafiles

- [ ] read first: `routes/account-groups.ts`, `controllers/account-groups/*`, `services/account-groups/*`, `serializeAccountGroups`
- [ ] `get_account_groups` (read): `includeArchived?`, `accountIds?` → `getAccountGroups`. With `groupId` it returns that group's accounts (`getAccountsInGroup`). Serialized as REST does.
- [ ] `create_account_group` (`finance:write`): `name`, `parentGroupId?` (nullable), logo fields.
- [ ] `update_account_group` (`finance:write`): `groupId` plus the same fields, optional. It returns the single group, not REST's one-element array.
- [ ] `delete_account_group` (`finance:delete`): `groupId`.
- [ ] `add_account_to_group` (`finance:write`): `groupId`, `accountId`.
- [ ] `remove_accounts_from_group` (`finance:write`): `groupId`, `accountIds[]`.
- [ ] `move_account_group` (`finance:write`): `groupId`, `newParentGroupId` (null for top level) → `moveAccountGroup`. A zero update count means not found. The description says it moves a group, not an account.
- [ ] unit test `account-group-tools.unit.ts`.
- [ ] metafiles under a new `// Account groups` group.
- [ ] gate:
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
- Modify: `controllers/currencies/change-base-currency.controller.ts`, the four metafiles, `tool-scopes-drift.unit.ts` (`LOCK_EXEMPT_TOOLS`: `change_base_currency`)

- [ ] read first: `controllers/user.controller.ts` (the currency handlers), `controllers/currencies/add-user-currencies.ts`, `change-base-currency.controller.ts`, `change-base-currency-status.controller.ts`, `controllers/exchange-rates/{pair-rate,rates-for-date}.controller.ts`, `controllers/currencies.controller.ts`
- [ ] `start-base-currency-change.service.ts`: move the controller's `isCurrencySupportedForHistoricalData` check and `enqueueBaseCurrencyChange` behind one function. The controller calls it.
- [ ] `get_user_currencies` (read): `getUserCurrencies`, `getUserBaseCurrency` and `getUserExchangeRates` in one result, with custom-currency metadata as the REST list returns it.
- [ ] `list_supported_currencies` (read): `getAllSystemCurrencies()`.
- [ ] `get_exchange_rate` (read): `date` (YYYY-MM-DD), `from?`, `to?`.
  - With both codes: `assertCurrencyCodesVisible`, then `getExchangeRate({ requireUserConnection: false })`. `ExchangeRateUnavailableError` becomes a clear "no rate" error.
  - With neither: `getExchangeRatesForDate`, the global rates.
  - One code alone is a schema error.
- [ ] `add_user_currencies` (`finance:write`): `currencies[]` of `{ currencyCode, exchangeRate?, liveRateUpdate? }`.
- [ ] `update_user_currency` (`finance:write`): `currencyCode`, `exchangeRate?`, `liveRateUpdate?` → `editUserCurrency`.
- [ ] `delete_user_currency` (`finance:delete`): `currencyCode` → `deleteUserCurrency`.
- [ ] `change_base_currency` (`finance:write`, lock-exempt like REST): `newCurrencyCode` (ISO).
  - A user without a base gets `setBaseUserCurrency`. Otherwise the new service runs and returns `{ jobId, state }`.
  - The description warns that the change recalculates all history and blocks other edits until it finishes. It points to `get_base_currency_change_status`.
- [ ] `get_base_currency_change_status` (read): `getBaseCurrencyChangeStatus`.
- [ ] unit test `currency-settings-tools.unit.ts`: the `get_exchange_rate` modes, both `change_base_currency` branches, the lock exemption.
- [ ] metafiles under `// Currencies`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/currencies/(add-user-currency|change-base-currency\.service|change-base-currency-status|currency-code-validation)|services/user-exchange-rate/(get-exchange-rate-pair|get-user-exchange-rates)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 7: Transaction reads, planned confirmation, bulk delete and attachments

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-transactions,get-transactions-summary,get-planned-summary,confirm-planned-transaction,bulk-delete-transactions,get-transaction-links,list-transaction-attachments,delete-attachment}.ts`, `tools/transaction-read-tools.unit.ts`
- Modify:
  - `tools/search-transactions.ts` (`isPlanned` filter; the description explains `endDate` for future plans);
  - `controllers/transactions.controller/transaction-filters.ts` (export the filter fields and `toServiceFilters` if they are local);
  - the four metafiles;
  - `tool-scopes-drift.unit.ts`: `DESTRUCTIVE_TOOLS` gets `bulk_delete_transactions`; `LOCK_EXEMPT_TOOLS` gets `delete_attachment` (its REST route has no lock).

- [ ] read first: `controllers/transactions.controller.ts` (`getTransactionById`, `getTransactionsByTransferId`), `get-transactions-by-ids.ts`, `get-transactions-summary.ts` and `get-planned-summary.ts` on `dev` (summary sums in base minor units), `bulk-delete.ts`, `update-transaction.ts`, `services/transactions/update-transaction.ts` (planned guards), `frontend/src/pages/records/components/upcoming-section.vue`, `controllers/attachments.controller.ts`
- [ ] `get_transactions` (read):
  - `ids` (1–100) or `transferId`, and `includeSplits?`;
  - `getTransactionsByIds`, `getTransactionById` or `getTransactionsByTransferId`;
  - serialized like `search_transactions`;
  - exactly one of `ids` and `transferId`.
- [ ] `get_transactions_summary` (read): the transaction filter fields (dates, types, account, category, tag and payee ids, the amount range, `isPlanned`, …) through `toServiceFilters` → `getTransactionsSummary`.
- [ ] `get_planned_summary` (read): `getPlannedSummary({ userId })`.
- [ ] `confirm_planned_transaction` (`finance:write`):
  - `transactionId`, `time?` → `updateTransaction({ isPlanned: false, time })`;
  - when `time` is absent and the plan is in the future, it sets now, as the web app does;
  - the service's refusal on bank-connected accounts passes through with its message;
  - the description says bank plans are confirmed by sync, and that confirming settles a linked subscription period.
- [ ] `search_transactions`: optional `isPlanned` boolean passed to `getTransactions`.
- [ ] `bulk_delete_transactions` (`finance:delete`): `transactionIds` or `filters` (+ `excludedIds`), not both → `resolveBulkTargetIds` + `bulkDelete`. The service's refusals (bank rows, the max count) pass through.
- [ ] `get_transaction_links` (read): `transactionId` → `{ portfolioLink, ventureLink }` from `getTransactionPortfolioLink` and `getTransactionVentureLink`.
- [ ] `list_transaction_attachments` (read): `transactionId` → `listAttachments`.
- [ ] `delete_attachment` (`finance:delete`, lock-exempt, `requireFeatureAccess` `attachments`): `attachmentId` → `deleteAttachment`.
- [ ] unit test `transaction-read-tools.unit.ts`: the `get_transactions` modes, the confirm time rule (past plan keeps its time, future plan gets now), the bulk-delete either-or, the attachment feature gate, the `isPlanned` passthrough.
- [ ] metafiles under `// Transactions`.
- [ ] gate:
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
  - `services/transactions/transactions-linking/{get-transfer-recommendations,bulk-scan-transfer-recommendations,dismiss-transfer-suggestion}.service.ts`.
- Modify: `controllers/transactions.controller/refunds/get-refund-recommendations.ts`, `controllers/transactions.controller/transfer-linking/{get-transfer-recommendations,bulk-scan-transfer-recommendations,dismiss-transfer-suggestion}.ts` (they call the new services), the four metafiles

- [ ] read first: those four controllers, `transfer-linking/constants.ts`, `services/tx-refunds/*`, `@models/transfer-suggestion-dismissals.model`
- [ ] move the inline logic of the four controllers into the four services unchanged: windows, limits, scoring, sorting, the ownership check. The controllers keep only validation and the response.
- [ ] `get_refunds` (read): one tool with three modes.
  - `transactionId` → `getRefundsForTransactionById`;
  - `originalTxId` + `refundTxId` → `getRefund`;
  - otherwise `page`, `limit`, `categoryId?`, `accountId?`, `transactionType?` → `getRefundTransactions`.
- [ ] `get_refund_recommendations` (read): `transactionId`, or `transactionType` + `originAmount` + `accountId`, as REST refines.
- [ ] `get_transfer_recommendations` (read): the same two input shapes.
- [ ] `list_transfer_suggestions` (read): `from`, `to`, `limit` (≤ 50, default 20), `offset`, `includeOutOfWallet` → the bulk-scan service. While moving it, confirm it writes nothing; if it does, rename the tool to a write name and give it `finance:write`.
- [ ] `dismiss_transfer_suggestion` (`finance:write`): `expenseTransactionId`, `incomeTransactionId`.
- [ ] unit test `refund-transfer-tools.unit.ts`: the `get_refunds` modes, the recommendation input refinements, dismissal args.
- [ ] metafiles under `// Transactions`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='controllers/transactions.controller/(refunds/get-refund-recommendations|transfer-linking/(get-transfer-recommendations|bulk-scan-transfer-recommendations|link-transactions))|services/tx-refunds/(create-single-refund|refund-links)|services/transactions/splits/splits-refunds|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 9: Reconciliation tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-reconciliation-history,list-stuck-pending-transactions,remove-duplicate-transactions,restore-removed-transactions,merge-duplicate-transactions,keep-pending-as-booked}.ts`, `tools/reconciliation-tools.unit.ts`
- Modify: the four metafiles, `tool-scopes-drift.unit.ts` (`DESTRUCTIVE_TOOLS` gets `merge_duplicate_transactions` if a merge cannot be undone)

- [ ] read first: `controllers/transactions.controller/reconciliation.ts`, `services/transactions/reconciliation/*`, `reconciliation.e2e.ts`
- [ ] `get_reconciliation_history` (read): `getReconciliationHistory`.
- [ ] `list_stuck_pending_transactions` (read): `getStuckPending`.
- [ ] `remove_duplicate_transactions` (`finance:write`): `transactionIds` (REST bounds) → `removeTransactions`. The description says removed rows can be restored.
- [ ] `restore_removed_transactions` (`finance:write`): `restoreTransactions`.
- [ ] `merge_duplicate_transactions`: `transactionIds` (REST min and max), `survivorId` → `mergeTransactions`.
  - Check in the service and history whether a merge can be undone. If not, use `finance:delete` and add it to `DESTRUCTIVE_TOOLS`; if it can, use `finance:write`.
  - Record the decision here.
- [ ] `keep_pending_as_booked` (`finance:write`): `transactionIds` → `keepAsBooked`.
- [ ] unit test `reconciliation-tools.unit.ts`.
- [ ] metafiles under a new `// Reconciliation` group.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/transactions/reconciliation/(reconciliation|notify-stuck-pending)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 10: Subscription period and candidate tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{accept-subscription-candidate,list-subscription-match-suggestions,get-subscription-periods,preview-subscription-payment,pay-subscription-period,skip-subscription-period,unlink-subscription-period-transaction,revert-subscription-period}.ts`, `tools/subscription-period-tools.unit.ts`
- Modify: the four metafiles

- [ ] read first: `controllers/subscriptions/{accept-candidate,suggest-matches,get-pay-preview,get-periods,mark-period-paid,skip-period,unlink-transaction,revert-period}.ts` and their services
- [ ] `accept_subscription_candidate` (`finance:write`): `candidateId`, `subscriptionId?` (attach to an existing one) → `resolveCandidate`.
- [ ] `list_subscription_match_suggestions` (read): `subscriptionId` → `suggestHistoricalMatches`.
- [ ] `get_subscription_periods` (read): `subscriptionId`, `limit` (≤ 50), `offset` → `getPeriods`.
- [ ] `preview_subscription_payment` (read): `subscriptionId`, `periodId?` → `getSubscriptionPayPreview`.
- [ ] `pay_subscription_period` (`finance:write`):
  - `subscriptionId`, `periodId`;
  - `transactionId?` or `createTransaction` with `amount?`, `time?`, `accountId?` (mutually exclusive, as REST);
  - `notes?`;
  - calls `markPeriodPaid`.
- [ ] `skip_subscription_period`, `unlink_subscription_period_transaction`, `revert_subscription_period` (`finance:write`): `subscriptionId`, `periodId`.
- [ ] unit test `subscription-period-tools.unit.ts`: the pay either-or, args, scopes.
- [ ] metafiles under `// Subscriptions`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/subscriptions/(subscription-periods|subscription-period-actions|subscription-mark-paid|detect-candidates|subscriptions)\.e2e|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 11: Payee tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{set-payees-categorization-mode,bulk-delete-payees,get-ignored-payee-names,ignore-payee-name,unignore-payee-name,apply-payee-tags-to-transactions,create-payee-alias,delete-payee-alias}.ts`, `tools/payee-tools.unit.ts`
- Modify: `tools/update-payee.ts`, the four metafiles, `tool-scopes-drift.unit.ts` (`DESTRUCTIVE_TOOLS` gets `bulk_delete_payees`)

- [ ] read first: `controllers/payees/*`, `services/payees/*`
- [ ] `update_payee`: add the `PATCH /payees/:id` fields it lacks (`categorizationMode`, `defaultTagIds`, `defaultLocation`, logo fields), with the REST schema.
- [ ] `set_payees_categorization_mode` (`finance:write`): `mode` (`CATEGORIZATION_MODE`) → `bulkUpdateCategorizationMode`. The description says it applies to every payee.
- [ ] `bulk_delete_payees` (`finance:delete`): `ids` (1–2000), `ignoreFuture?` → `bulkDeletePayees`.
- [ ] `get_ignored_payee_names` (read): `listPayeeIgnoredNames`.
- [ ] `ignore_payee_name` (`finance:write`): `rawName`, `force?` → `addPayeeIgnoredName`. With `force`, which deletes the matching payee, the tool also requires `finance:delete`. Without `force` the 409 message passes through.
- [ ] `unignore_payee_name` (`finance:write`): `ignoredNameId` → `removePayeeIgnoredName`.
- [ ] `apply_payee_tags_to_transactions` (`finance:write`): `payeeId` → `applyPayeeTagsToExisting`.
- [ ] `create_payee_alias` (`finance:write`): `payeeId`, `rawName`.
- [ ] `delete_payee_alias` (`finance:delete`): `payeeId`, `aliasId`.
- [ ] unit test `payee-tools.unit.ts`: the `force` scope rule, the new `update_payee` fields, args.
- [ ] metafiles under `// Payees`. Add the missing rows for the six existing payee tools to SKILL.md while there.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/payees/(payees|bulk-delete-payees|ignored-names|ignore-list-api-and-curation|payee-tags|payee-default-location)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 12: Transaction templates, automation apply and detail lookups

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-transaction-templates,create-transaction-template,update-transaction-template,delete-transaction-template,apply-transaction-automation,get-category-transaction-count}.ts`, `tools/template-tools.unit.ts`
- Modify: `tools/get-transaction-groups.ts` (`groupId`), `tools/get-tags.ts` (`tagId`), the four metafiles

- [ ] read first: `controllers/transaction-templates/*` (`schema.ts`), `services/transaction-templates`, `controllers/transaction-automations/apply-to-history.ts`, `services/transaction-automations/zod-schemas`, `controllers/categories.controller/get-category-transaction-count.ts`
- [ ] `get_transaction_templates` (read). The description says templates are named presets for new transactions.
- [ ] `create_transaction_template` (`finance:write`):
  - `name`, `transactionType`, plus optional `amount`, `accountId`, `categoryId`, `payeeId`, `paymentType`, `note`, `originalCurrencyCode`, `tagIds`, from the REST schema;
  - a pinned amount needs `accountId`, and duplicate names give the 409 message.
- [ ] `update_transaction_template` (`finance:write`): `templateId` plus the partial fields. `null` clears, and `tagIds` replaces the set.
- [ ] `delete_transaction_template` (`finance:delete`).
- [ ] `apply_transaction_automation` (`finance:write`): `automationId`, `transactionIds` (1 to `AUTOMATION_LIMITS.maxApplyIds`) → `applyAutomationToHistory`.
- [ ] `get_category_transaction_count` (read): `categoryId` → `countCategoryTransactions`. The description points to it before `delete_category`.
- [ ] `get_transaction_groups`: optional `groupId` → `getTransactionGroupById`.
- [ ] `get_tags`: optional `tagId` → `getTagById`.
- [ ] unit test `template-tools.unit.ts`, covering the two extensions.
- [ ] metafiles: templates under a new `// Transaction templates` group, the rest under their existing groups.
- [ ] gate:
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
- [ ] `get_budget` (read): `budgetId` → `getBudgetById` + `getBudgetStats`, with both serializers and the decimals handling the controllers use.
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
- Modify: the four metafiles, `tool-scopes-drift.unit.ts` (`LOCK_EXEMPT_TOOLS`: `mark_notifications_read`, `update_user_settings`)

- [ ] read first: `controllers/notifications.controller.ts`, `controllers/user-settings/{get-settings,patch-settings}.ts`, `models/user-settings.model.ts` (`ZodSettingsPatchSchema`), `middlewares/entitlements.ts#requireFireSettingsAccess`
- [ ] `get_notifications` (read): `notificationId?`, or `status?`, `type?`, `limit` (1–100), `offset`. The list result includes `unreadCount` (`getUnreadCount`).
- [ ] `mark_notifications_read` (`finance:write`, lock-exempt like REST): `notificationId?`. Without an id it marks all (`markAllAsRead`).
- [ ] `dismiss_notification` (`finance:write`): `notificationId`.
- [ ] `get_user_settings` (read): `getUserSettings`, with the `ai` slice left out. That keeps AI configuration out of the client, matching the ai exclusion.
- [ ] `update_user_settings` (`finance:write`, lock-exempt like REST):
  - a deep-merge patch validated with `ZodSettingsPatchSchema` minus `ai` → `patchUserSettings`;
  - a `fire` key needs `requireFeatureAccess` `fire_planner`;
  - it covers `PUT /settings` too: the patch replaces arrays whole, as REST does.
- [ ] unit test `notification-settings-tools.unit.ts`: `ai` rejected and stripped, the `fire` gate, mark all versus one.
- [ ] metafiles under a new `// Notifications & settings` group.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/notifications/notifications|services/user-settings/(patch-settings|update-settings|fire-settings|settings-service-owned-slices)|services/mcp/(connected-apps|mcp-scope-gate)'`;
  - typecheck, lint, oxfmt.

### Task 15: Stats tools

**Branch:** `feat/mcp-coverage`

**Worktree:** `/Users/nemirovsky/Developer/moneymatter-mcp`

**Files:**

- Create: `tools/{get-total-balance,get-net-worth-history,get-net-worth-drivers,get-investment-contributions,get-venture-contributions,get-pivot-report,get-cumulative-stats,get-earliest-transaction-date}.ts`, `tools/stats-tools.unit.ts`
- Modify: `tools/get-balance-history.ts` (`includeCreditLimit` from user settings in the combined branch), the four metafiles

- [ ] read first, on `dev` after Task 3's merge: `controllers/stats.controller.ts` and `serializers/stats.serializer.ts`. Every report now takes base `decimals` from `getBaseCurrencyDecimals`, and the serializers take `{ …, decimals }`. Some reports read `includeCreditLimitInStats` from `getUserSettings`.
- [ ] each tool copies its controller's argument mapping, decimals and serializer:
  - `get_total_balance` (`date`);
  - `get_net_worth_history` (`from`, `to`, `granularity`);
  - `get_net_worth_drivers` (`from`, `to`, `granularity`, `portfolioIds?`);
  - `get_investment_contributions` (the same);
  - `get_venture_contributions` (`from`, `to`);
  - `get_pivot_report` (`from`, `to`, `granularity`, `rowDimension`, `measure`, `accountIds?`, `categoryIds?`, `payeeIds?`);
  - `get_cumulative_stats` (`from`, `to`, `metric`, `accountId?` and the id include and exclude lists);
  - `get_earliest_transaction_date`.

  All are read tools. Arrays are taken as arrays, not the comma strings REST uses.
- [ ] `get_balance_history`: pass `includeCreditLimit` from the user's settings in the combined branch, as `/stats/combined-balance-history` does.
- [ ] unit test `stats-tools.unit.ts`: the enum schemas, decimals passed through, the credit-limit setting read.
- [ ] metafiles under `// Analytics`.
- [ ] gate:
  - unit: `services/mcp/`;
  - e2e: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='services/stats/(get-net-worth-drivers|get-net-worth-history|get-investment-contributions|get-venture-contributions|get-pivot|get-cumulative-data|get-earliest-transaction-date|get-combined-balance-history|credit-limit-in-stats)|services/mcp/(connected-apps|mcp-scope-gate)'`;
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
- Modify: `controllers/investments/holdings/index.ts` (calls the new service), the four metafiles

- [ ] read first: `controllers/investments/holdings/index.ts`, `services/investments/securities/add-from-search.service.ts`, `controllers/investments/prices/get-prices.controller.ts`, `controllers/venture/events/{append-links,replace-links,delete-link}.controller.ts`, `services/venture/linking/*`
- [ ] `create-holding-from-input.service.ts`: the controller's orchestration (`securityId`, or `searchResult` → the asset-class check, then `addSecurityFromSearch`, then `createHolding`). The controller calls it.
- [ ] `create_holding` (`finance:write`): `portfolioId` plus exactly one of `securityId` and `searchResult` (the `SecuritySearchResult` that `search_securities` returns).
- [ ] `delete_holding` (`finance:delete`): `portfolioId`, `securityId`, `force?`.
- [ ] `get_security_prices` (read): `securityId` (required in MCP; the price table is global and large), `from?`, `to?` → `getPrices`.
- [ ] `link_transactions_to_venture_event` (`finance:write`): `eventId`, `transactionIds` (≥ 1) → `linkTxsToEvent`. The description gives the rules: same currency, not linked elsewhere, the sum equals the event's `lpNetAmount`.
- [ ] `replace_venture_event_links` (`finance:write`): `eventId`, `transactionIds` (may be empty) → `replaceEventLinks`.
- [ ] `delete_venture_event_link` (`finance:delete`): `eventId`, `linkId` → `unlinkTxFromEvent`. It restores the transaction.
- [ ] unit test `holding-venture-link-tools.unit.ts`.
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
- [ ] move the goal body schema and its `superRefine` (which fields each frequency and behaviour allows) from the controller into `line-goal-schema.ts`. The controller and the tool use it, and REST validation is unchanged.
- [ ] all writes call `requireFeatureAccess` `budget_plan`.
- [ ] `set_budget_plan_line_goal` (`finance:write`): `planId`, `lineId` + the moved schema's fields.
- [ ] `delete_budget_plan_line_goal` (`finance:delete`).
- [ ] `snooze_budget_plan_line_goal` (`finance:write`): `planId`, `lineId`, `periodId`.
- [ ] `set_budget_plan_assignment` (`finance:write`): `planId`, `periodId`, `lineId`, `scope` (`BUDGET_ASSIGNMENT_SCOPES`), `amount?` and `carryPolicy?` (nullable).
- [ ] unit test `budget-plan-goal-tools.unit.ts`: the moved refinements (one allowed and one refused combination per frequency).
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
- [ ] every write tool passes the lock rule or is in `LOCK_EXEMPT_TOOLS` with a matching REST route; every `delete_*` and `DESTRUCTIVE_TOOLS` tool requires `finance:delete`.
- [ ] measure the `tools/list` size and record it here.
  - Use a one-off script under the scratchpad, not committed: `captureTools` over every register function, `z.toJSONSchema(z.object(shape))` per tool, plus name and description.
  - Record the tool count, total bytes, and the five largest tools.
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

- With about 250 tools, some MCP clients may truncate the list or spend much of their context on it. Task 28 records the measured `tools/list` size.
- If it is too large for the clients the owner uses, choose a follow-up:
  - scope-based or opt-in toolsets (for example a `?tools=core|full` query on `/mcp`);
  - folding the rarest tools into fewer consolidated tools.

**Upstream:**

- The currency tools ride on `feat/custom-currencies` and `feat/currency-rate-sources` and go upstream with those PRs. Group A and the guards in Task 3 can be offered upstream as one MCP coverage PR, after the owner's discussion with letehaha.
