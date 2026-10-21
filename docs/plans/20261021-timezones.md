# Time zones: a user setting, a zone on every transaction, a zone-aware AI

## Overview

MoneyMatter stores `Transactions.time` as `timestamptz`, an exact instant, and nothing about where it happened. The browser shows it in the device zone. The server treats every time without an offset as UTC and buckets days in UTC.

In the chat this went wrong. Haiku logged a 16:00 local payment as 16:00 UTC, then kept shifting the hours while trying to fix it. The cause is three bugs that compound:

1. The system prompt gives the model the **server's** zone as the user's "Now": `services/chat/runners/prepare-turn.ts:65` passes `Intl.DateTimeFormat().resolvedOptions().timeZone`, which is `UTC` in Docker, to `buildSystemPrompt` (`services/chat/prompt/system-prompt.ts:85`).
2. The tools take a free ISO string, `create_transaction.time: z.string()` (`services/mcp/tools/create-transaction.ts:51`) and `update_transaction.time` (`update-transaction.ts:56`). The server then reads it with `new Date(...)` (`serializers/transactions.serializer.ts:354`, `update-transaction.ts:143`), so an offset-less `2026-10-21T16:00:00` becomes 16:00 **UTC**.
3. The proposal card shows the same offset-less string with `parseISO` (`frontend/src/components/chat/visuals/format-visual-value.ts:31-41`), which reads it in the **browser** zone. The card says 16:00, the list later says 20:00, and every "fix" the model tries moves the instant again.

This plan delivers:

1. **One user setting, "Time zone":** "Automatic (device)", the default, or a manual IANA zone. The same zone is used for viewing and for saving. In automatic mode the device zone is written to the profile whenever it changes, so server-side paths (AI, ingest, imports, reports) know it. A second small setting, **"Clock"**, picks 24-hour or 12-hour time and defaults to the locale.
2. **Every transaction records its zone:** two new nullable columns, `Transactions.timeZone` (IANA) and `Transactions.utcOffsetMinutes` (the offset at that instant). Each write path fills them from what it knows. Existing rows stay `null`, meaning "Unknown": they display in the viewing zone exactly as today. Bank syncs record the user's current zone for rows dated within 3 days of the sync.
3. **A zone-aware AI:**
   - the system prompt states the user's zone and local date and time;
   - the tools take a local wall time plus a zone, or an ISO time with an offset, and the server converts;
   - cards hold instants;
   - notification and statement parsing read wall clocks in the right zone.
4. **Display:**
   - every time is shown in the viewing zone, 24-hour by default for the owner, with a zone label;
   - the transaction dialog and the list tooltip also show the transaction's own zone when it differs;
   - chat cards and edit inputs show only the viewing zone.
5. **Reports bucket days in the viewing zone:** cash flow, spending, pivot, trackers and budgets. Today they use UTC days.
6. **API and MCP:**
   - `timeZone` and `utcOffsetMinutes` appear on transactions and in create and update bodies;
   - the settings carry `timeZone`, `timeZoneSource` and `hourCycle`;
   - `PUT /transactions/bulk`, MCP `bulk_update_transactions` and the list's bulk actions can set or clear the zone on many existing rows at once, so a backfill runs through supported tools, not SQL;
   - every change is additive and nullable, so the work can go upstream as a PR.

## Context (from discovery)

**Settings**

- Per-user settings are one JSONB row, `UserSettings.settings`.
  - The full schema is `ZodSettingsSchema` (`packages/backend/src/models/user-settings.model.ts:361-412`).
  - The patch schema is `ZodSettingsPatchSchema` (`:423-521`).
  - A compile-time guard keeps the two in sync: `SettingsPatchSchemaIsInSync` (`:544`).
  - `PATCH /user/settings` deep-merges (`services/user-settings/patch-settings.ts`). A new key needs no migration.
- MCP `update_user_settings` takes `ZodSettingsPatchSchema.omit({ ai })`'s shape (`services/mcp/tools/update-user-settings.ts:12-13`). A new settings key reaches MCP and the chat with no change to the tool.
- No zone or 12/24-hour preference exists anywhere. The only zone-like setting is `bankSyncHoursUtc`.
- Frontend:
  - the settings type is `UserSettingsSchema` in `packages/frontend/src/api/user-settings.ts`;
  - a display preference lives as a module ref, `currencyDisplayPreference` (`src/js/helpers/formatters.ts:9`), synced from settings in `src/app.vue:44-46`; the new zone and clock refs copy that pattern;
  - the Language page (`pages/settings/subpages/language/index.vue`) holds the locale picker.
- `setDefaultOptions({ locale })` (`src/main.ts:31`) makes date-fns `p` and `PPp` follow the UI locale: 12-hour in English, 24-hour in Ukrainian.

**The transaction column and its write paths.** `Transactions.time` is `DataType.DATE` (`models/transactions.model.ts:199-203`). Almost every path ends in `createTransaction` (`services/transactions/create-transaction.ts`); account↔portfolio transfers call the model-level `Transactions.createTransaction` directly (`services/investments/portfolios/transfers/{account-to-portfolio,portfolio-to-account}-transfer.service.ts`). `createTransaction` defaults `time` to `new Date()` (`:504`, `:564`, `:650`) and copies `time` onto the opposite transfer leg (`:325-333`). The callers:

- **Services between a caller and `createTransaction` that take only `time` today**, so the pair must be threaded through them:
  - balance adjustment: `services/accounts/balance-adjustment.ts` (`adjustAccountBalance` → `createBalanceAdjustmentTransaction`), reached by REST, MCP `adjust_account_balance` and the post-link residual adjustment (`services/accounts/absorb-link-residual.ts:64`, a row dated at `bankConnection.linkedAt`). Import balance reconciliation (`services/import-export/core/reconcile-account-balances.ts`) creates no row: it calls `absorbBalanceAdjustment`, which shifts the opening balance, so it has nothing to record;
  - subscription payments: `services/subscriptions/mark-period-paid.ts` → `build-transaction-from-subscription.ts`, reached by REST, MCP `pay_subscription_period` and the auto-record cron (`services/subscriptions/process-auto-record.ts:83`);
  - account↔portfolio transfers (above), reached by REST and MCP `transfer_account_to_portfolio` / `transfer_portfolio_to_account`.
- **Planned merge:** `createTransaction` may merge an incoming row into a planned one (`create-transaction.ts:497-519` → `services/transactions/planned-matching/merge-into-planned.ts:145-151`), which writes `planned.update({ time: incoming.time, … })` directly.
- **Manual form:**
  - create sends `time.toUTCString()` (`frontend/src/components/dialogs/manage-transaction/utils/prepare-tx-creation-params.ts:54`);
  - update sends `time.toISOString()` (`prepare-tx-updation-params.ts:160`);
  - REST requires a UTC `Z` string: `transactionTimeSchema` (`controllers/transactions.controller/schemas.ts:18-24`).
- **AI chat and MCP:**
  - the chat applies a card by invoking the MCP handler (`services/chat/proposals/approve.ts:202`, catalog in `services/mcp/tool-catalog.ts`);
  - the tools with a time argument are `create_transaction`, `update_transaction`, `adjust_account_balance`, `confirm_planned_transaction` and `pay_subscription_period` (all three `transactionTimeSchema`, Z only: `adjust-account-balance.ts:17`, `confirm-planned-transaction.ts:16`, `pay-subscription-period.ts:26`), and the date bounds of `search_transactions` and `transaction-filter-input.ts:30-31` ("ISO 8601 datetime in UTC");
  - the MCP guide (`services/mcp/prompts/financial-data-guide.ts`) says nothing about zones;
  - card fields with `format: date-time` or an ISO-looking value become `datetime` fields (`services/chat/proposals/card-fields.ts:68-71`), and the editor writes `toISOString()` back (`frontend/src/components/chat/cards/card-field-editor.vue:169-173`).
- **iOS Automation ingest:**
  - `resolvePayloadTime` (`services/ingest/card-payment/parse-payload.ts:113-134`) accepts only ISO 8601 **with an offset** (`:18`) and falls back to the receive time, which sets `timeProvided`;
  - `timeSource` is `run` or `transaction` (`shared/src/types/ingest/index.ts:153-173`);
  - the notification path uses the same resolver (`services/ingest/event/parse-notification-payload.ts:104-119`);
  - the shortcut sends the run time (taps, `build-payments-shortcut.ts:159-189`) or the notification's date (`:263-289`) in ISO 8601 with offset; no zone name is sent;
  - the AI notification parser returns `occurredAt` as a zone-less wall clock (`services/ingest/event/notification-prompt.ts:78-79`);
  - it is kept only as `bankWallClock` (`log-notification-payment.ts:51-55, 249`) and turned into an instant by guessing the offset (`dedup/twin-rule.ts:142-157`, `inferBankTime`);
  - everything is logged through `logIngestedPayment` (`services/ingest/log-ingested-payment.ts:115`).
- **Bank syncs:**

  | Provider       | Where                                                                      | What the provider gives                                                                                                 |
  | -------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
  | Monobank       | `monobank/transaction-sync-queue.ts:561-566`                               | Unix seconds                                                                                                            |
  | SimpleFIN      | `simplefin/simplefin.provider.ts:324-327`                                  | `transacted_at ?? posted`, Unix seconds                                                                                 |
  | Enable Banking | `enablebanking/enablebanking.provider.ts:707-715`, created at `:1098-1103` | `transaction_date \|\| value_date \|\| booking_date`, date-only strings turned into **UTC midnight** by `new Date(...)` |
  | LunchFlow      | `lunchflow/lunchflow.provider.ts:375-379`                                  | `new Date(tx.date)`, a date string                                                                                      |
  | Walutomat      | `walutomat/walutomat.provider.ts:395-401`                                  | `new Date(item.ts)`                                                                                                     |

  No provider sends a zone name. A synced row records the user's setting zone when its time is within `BANK_SYNC_RECENT_ZONE_WINDOW_DAYS` (3) of the sync, else `null` (see Technical Details → Bank syncs).

- **Imports:**
  - CSV, OFX, the statement parser, Microsoft Money, Budget Bakers and YNAB all call `createTransaction`;
  - CSV, OFX and the statement parser already anchor dates to the **browser** zone through `anchorImportDate` (`services/import-export/core/parse/anchor-import-date.ts:30-110`): a date-only value goes to local noon and a wall clock is read in the zone;
  - the frontend sends `Intl.DateTimeFormat().resolvedOptions().timeZone` (`frontend/src/stores/statement-parser.ts:470, 641`, `stores/import-export.ts:667, 755`, `api/import-ofx.ts:24` as `X-Timezone`);
  - the statement-parser AI dates "today" in that zone (`statement-parser/ai-extraction.service.ts:44-46`).
- **Backups:**
  - `BACKUP_FORMAT_VERSION = 3` (`shared/src/types/backup.ts:24`);
  - restore intersects the file's columns with the live model (`services/backup/restore/analyze-archive.ts:41-55`);
  - a model column missing from the file is fine when it is nullable, and a file column the model lacks is dropped;
  - two new nullable columns therefore round-trip with no version bump, and older apps drop them.
- **Data export** writes `date` and `time` as UTC slices (`services/data-export/transformers/transactions-transformer.ts:333-334`).

**Day bucketing (all UTC today)**

- Report ranges arrive as `YYYY-MM-DD` (`controllers/stats.controller.ts`, `dateRange()`). The window becomes `new Date(from)`, which is UTC midnight, and `endOfDay(new Date(to))` in the server zone (`services/stats/stats-transactions.ts:74-86`, `services/stats/utils/index.ts:36-50`).
- Period buckets use date-fns `startOf*` in the server zone (`stats/utils/index.ts`). The server runs in UTC: unit tests force `TZ=UTC` (`packages/backend/package.json:18`), and the containers set no `TZ`.
- Budget activity is UTC explicitly: `p."startDate"::timestamp AT TIME ZONE 'UTC'` (`services/budget-plans/activity/get-plan-activity.ts:94-95`).
- `Balances.date` (DATEONLY) is `startOfDay(time)` in the server zone (`models/balances.model.ts:129, 170`). `toUtcDateString` (`common/utils/date.ts`) documents UTC as the convention.
- The frontend list filters build instants from **browser** days (`components/records-filters/use-filters-from-query.ts:45-52`). Analytics send `yyyy-MM-dd` from browser dates (`api/stats.ts`). The list and the reports can therefore disagree for an evening purchase.
- Crons run on UTC (`crons/*`, `timeZone: 'UTC'`).

**Display today**

- List rows and the table show only the date, `format(new Date(tx.time), 'd MMM y')` (`components/transactions-list/transaction-record.vue:454`, `components/transactions-table/transaction-table-row.vue:381`).
- The form's `date-field` edits browser-local `Date`s:
  - the input pattern is `yyyy-MM-dd HH:mm` (`components/fields/date-field.vue:138`);
  - the popover is a v-calendar 3.1.2 `DatePicker` with `is24hr` (`:69`);
  - v-calendar accepts a `timezone` prop.
- These places show times through the locale's `p`, so they turn 12-hour in English:
  - chat cards (`PPp`);
  - applied changes (`pages/settings/subpages/ai/pages/chat-applied-changes.vue:20`);
  - iOS Automation requests (`pages/accounts/integrations/ios-automation/components/payment-request-summary.vue:20`).
- There is no read-only transaction page. The manage-transaction dialog is the detail view, and its time input is disabled for bank rows (`EXTERNAL_ACCOUNT_RESTRICTED_UPDATION_FIELDS`, `services/transactions/update-transaction/update-transaction.ts:77`).
- The form's optional ("advanced") fields are `TRANSACTION_OPTIONAL_FIELDS` (`shared/src/types/user-settings.ts:6`). All of them are on by default (`components/dialogs/manage-transaction/composables/use-optional-fields.ts:6`).

**Libraries:** `date-fns` 4.3.0 in the backend and the frontend; no zone library. `packages/shared` has no dependencies. The runtime is Node 24, with a full ICU, so `Intl` knows every IANA zone.

## Development Approach

- **TDD:** each task writes failing tests first and records that they fail on assertions.
- **Node:** prefix every node/npm command with `export PATH="$(mise where node@24.21.0)/bin:$PATH"`.
- **Commands:**
  - backend unit: `cd packages/backend && npm run test:unit -- --testPathPattern='<regex>'`;
  - backend e2e, never in parallel: `cd packages/backend && lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='<regex>'`;
  - frontend: `cd packages/frontend && npm run test:unit -- --run <path>`;
  - root: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run knip`.
- **Subagents and skills:** `test-runner`, `linter`, `i18n-editor` (`en` + `uk`), the `add-mcp-tool` skill (for the drift metafiles; no new tool), and `user-docs`.
- **Repo rules:**
  - one task at a time;
  - object params; kebab-case files;
  - comments describe current code;
  - one migration for the branch;
  - e2e tests go through HTTP helpers only.
- **Upstream-friendly:**
  - nullable columns and optional keys;
  - no behavior change for a user whose settings hold no zone, which is UTC, today's behavior;
  - no MCP `serverInfo.version` bump, since the changes are additive.
- **Commits:** none by implementing agents unless the owner asks (rule 10).

## Testing Strategy

- **Unit (backend, also covering `packages/shared` code, as `date-engine.unit.ts` does):**
  - zone validation, offset at an instant, wall clock to instant across DST gaps and overlaps;
  - `resolveRecordedZone`, `resolveTimeInput` (every input shape);
  - zoned day bounds and period buckets (Pacific/Kiritimati +14, Pacific/Pago_Pago -11, Asia/Kathmandu +5:45, America/New_York across DST);
  - system-prompt text;
  - tool validators;
  - the proposal time normalizer;
  - the ingest time resolver;
  - the notification wall-clock reader.
- **E2E (HTTP only):**
  - settings patch (valid, invalid zone 422, MCP patch);
  - transaction create and update with and without a zone;
  - offset recomputed on a time edit; a transfer's legs share the zone;
  - an MCP create from a naive wall time;
  - a chat card holding an instant;
  - ingest with `timeZone`, with only an offset, and with neither;
  - CSV and statement imports stamping the anchor zone;
  - a bank sync stamping the setting zone on a recent row and leaving a 90-day-old row `null`;
  - a bulk zone edit by ids and by filter selection, both transfer legs, per-row offsets across DST;
  - a backup round trip;
  - data-export columns;
  - stats and budgets bucketing an 23:30 local purchase into the right day for a user in a +04:00 zone and one in a -05:00 zone, with a no-zone user unchanged.
- **Frontend vitest:**
  - formatting helpers (zone label, hour cycle);
  - the auto-sync composable (patches only when the source is device and the zone differs);
  - date-field round trip in a non-browser zone;
  - filter bounds and presets in the viewing zone;
  - the optional field's visibility rule;
  - the card date formatter.
- **Playwright (one flow):** set a manual zone, add a transaction at 16:00, see 16:00 in the list tooltip; in the chat, ask to log 16:00 and see 16:00 on the card and in the list.

## Progress Tracking

- Mark completed items `[x]` immediately; ➕ for new tasks, ⚠️ for blockers.
- Note each gate's command and result under the task.

## Solution Overview

```
device zone ──(auto)──┐
manual IANA zone ─────┴─> settings.timeZone  (+ timeZoneSource, hourCycle)
                                 │
     ┌───────────────────────────┼─────────────────────────────────────┐
  frontend                      server                                 AI
  viewing zone for display,     getUserTimeZone(): default for         prompt: "Now: <local> (<zone>)"
  inputs, filters, presets      tools, imports, ingest fallback,       tools: wall time + zone or offset
                                report day bounds
                                 │
  write paths ──> createTransaction({ time, timeZone?, utcOffsetMinutes? })
                     └─ resolveRecordedZone → Transactions.timeZone / utcOffsetMinutes
```

- **Instants stay the truth.** `time` remains the exact instant. `timeZone` says where the payment happened or was entered. `utcOffsetMinutes` is that zone's offset at `time`, or the only thing known when a source sends an offset without a zone.
- **One rule decides a row's zone.** `resolveRecordedZone({ instant, explicitZone, offsetMinutes, candidateZone })`, five branches in order:
  1. `explicitZone` given → that zone, offset derived from it;
  2. `offsetMinutes` given and `candidateZone` has that offset at `instant` → the candidate, with that offset;
  3. `offsetMinutes` given otherwise → `{ timeZone: null, utcOffsetMinutes: offsetMinutes }`;
  4. no offset, `candidateZone` given → the candidate, offset derived from it (a wall clock or a date read in that zone, a `Z` instant, a receive time);
  5. nothing → `null`/`null`.
  - `offsetMinutes` means an offset the **source stated about local time**. A `Z` instant states none, so its `offsetMinutes` is absent, never `0`; a `Z` without a zone therefore goes to branch 4 or 5, never to `{null, 0}`.
  - `candidateZone` is always a **stored** zone (`getStoredUserTimeZone`, a request's zone, an import's request zone), never the `UTC` fallback of `getUserTimeZone`, so a user with no setting records `null`.
- **Viewing and day membership use the setting's zone.** A transaction's own zone is information shown beside the time. It never moves the instant and never decides which report day the row lands in.

## Technical Details

**Settings keys** (backend Zod, the patch schema and the frontend type, together):

- `timeZone?: string`: IANA name; `ianaTimeZone()` checks it.
- `timeZoneSource?: 'device' | 'manual'`: unset means `device`.
- `hourCycle?: 'h23' | 'h12'`: unset means the locale's default.

`getUserTimeZone({ userId })` returns `settings.timeZone ?? 'UTC'`, for day bounds and wall-clock reading. `getStoredUserTimeZone({ userId })` (same file) returns `settings.timeZone ?? null`, for anything that **records** a zone on a row: a zone nobody chose is never stamped. Constants `TIME_ZONE_SOURCES` and `HOUR_CYCLES` go in `shared/src/types/user-settings.ts`.

**`ianaTimeZone()`** (`common/lib/zod/custom-types.ts`):

- a string of at most 64 characters matching `^(UTC|[A-Za-z]+(?:/[A-Za-z0-9_+\-]+)+)$`, for which `new Intl.DateTimeFormat('en', { timeZone })` does not throw;
- aliases such as `Europe/Kiev`, which Chrome still reports, are accepted;
- offset strings such as `+04:00` are refused: an offset is not a zone.

**Automatic mode (frontend):**

- On boot and on `visibilitychange` to visible, the app reads `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- When `timeZoneSource !== 'manual'` and the zone differs from `settings.timeZone`, the app sends `PATCH { timeZone }`.
- With two devices in different zones, the last one to open wins. This is acceptable: the setting means "where I am now".
- The viewing zone is `timeZoneSource === 'manual' ? settings.timeZone : deviceZone`, so a device never waits for the patch to display correctly.

**Columns** (one migration, `20261021000000-add-time-zone-to-transactions.ts`):

- `Transactions.timeZone VARCHAR(64) NULL`;
- `Transactions.utcOffsetMinutes SMALLINT NULL` (-840 to 840, CHECK constraint);
- no index, no backfill;
- the `real_transactions` view is rebuilt at the end of `up` with `dropRealTransactionsViewSql` + `createRealTransactionsViewSql` from `migrations/utils/real-transactions-view.ts`, as `20261016010000-custom-currencies.ts` does. That definition keeps **both** filters, `"isPlanned" = false AND "deletedAt" IS NULL`; a hand-written SQL must not drop the planned filter, or every raw-SQL reader (budget activity, `get-plan-cash`, `absorb-link-residual`, balance revalue) counts plans as money. A `SELECT *` view freezes its column list, which `models/transactions-query/real-transactions-view-columns.e2e.ts` guards. `down` drops the view, drops the columns and re-creates the view the same way.

**Shared helpers** (`packages/shared/src/time-zone/`, Intl only, no dependencies):

- `isValidTimeZone({ zone })`;
- `zoneOffsetMinutes({ zone, instant })`;
- `wallClockToInstant({ wall, zone })`: replaces `zonedWallClockToInstant` / `timezoneOffsetMs` in `anchor-import-date.ts`, which then imports it. It resolves DST edge cases by one rule, independent of the zone's side of UTC (Temporal's `compatible` disambiguation):
  - a wall clock in a spring-forward gap moves forward by the gap (New York 2026-03-08 02:30 → 03:30 EDT = `07:30Z`);
  - a wall clock in a fall-back overlap takes the earlier instant (New York 2026-11-01 01:30 → 01:30 EDT = `05:30Z`; Kyiv 2026-10-25 03:30 → `00:30Z`).
  - The existing two-pass algorithm does not follow one rule (New York's gap resolves backward to `06:30Z`, Kyiv's overlap takes the later instant). `anchor-import-date.unit.ts:128-171` pins New York's `06:30Z`; Task 1 changes that expectation to `07:30Z` and fixes its comment. It is an intended change for one nonexistent hour a year.
- `zonedDayStart({ date, zone })` / `zonedDayEnd({ date, zone })`: local 00:00 of a `YYYY-MM-DD` day as an instant, and the instant just before the next day's 00:00 (23- and 25-hour days included). Used by tool range bounds (Task 4) and reports (Task 8);
- `resolveRecordedZone({ instant, explicitZone, offsetMinutes, candidateZone })` → `{ timeZone, utcOffsetMinutes }` (the five branches in Solution Overview);
- `formatOffset({ minutes })` → `UTC+04:00`.

**`createTransaction` / `updateTransaction`:**

- New optional params `timeZone?: string | null` and `utcOffsetMinutes?: number | null`. The default is `null`, so a caller that knows nothing stores nothing.
- The service derives `utcOffsetMinutes` from `timeZone` at `time`.
- Both transfer legs get the same pair.
- Update:
  - a new `time` with a stored zone recomputes the offset;
  - a new `time` with only a stored offset keeps the offset;
  - `timeZone: null` clears both;
  - a zone change leaves `time` alone.
- `timeZone` is editable on bank-synced rows, because it is an annotation. `time` stays locked.
- **Planned merge** (`merge-into-planned.ts:145-151`): when the incoming row has a zone, the planned row takes the incoming pair; when it has none, the planned row keeps its zone and its offset is recomputed at the new `time`. The incoming pair is never silently dropped.
- **Intermediate services** (Context → write paths) gain the same two optional params and pass them through: `adjustAccountBalance` / `createBalanceAdjustmentTransaction`, `markPeriodPaid` / `buildTransactionFromSubscription`, and both portfolio transfer services (which set them on the model-level create).
- Who records what on those paths:
  - REST callers send `timeZone` (the frontend sends the viewing zone); MCP callers go through `resolveTimeInput`;
  - the auto-record cron records `getStoredUserTimeZone` (the payment is happening now, the same reasoning as recent bank-synced rows; `null` for a user with no setting);
  - the post-link residual adjustment (`absorb-link-residual.ts`) records `null`: it is a system correction dated at the link time, not a payment anyone made somewhere.

**REST:**

- `CreateTransactionBody` / `UpdateTransactionBody` gain `timeZone?: string | null` (`ianaTimeZone().nullable().optional()`). `time` stays a UTC `Z` instant.
- Responses gain `timeZone` and `utcOffsetMinutes`, through `serializeTransaction` and the shared `TransactionModel`.
- The frontend always sends `timeZone` on create: the viewing zone, or the zone picked in the form.

**Bulk zone edits** (no new tool; the existing bulk update grows one field):

- `bulkUpdate` (`services/transactions/bulk-update.ts`), `PUT /transactions/bulk` (`controllers/transactions.controller/bulk-update.ts`) and MCP `bulk_update_transactions` take `timeZone?: string | null`. `null` clears both columns.
- The target is the existing bulk target: `transactionIds`, or a filter `selection` with `excludedIds` (`resolveBulkTargetIds`, `services/transactions/matching-transactions.ts:86`). An account and a date range select a whole trip in one call.
- Transfer legs: `resolveBulkTargetIds` keeps one leg per transfer on the `selection` path (`dedupeTransferLegs`), and `transactionIds` pass through as given. For a zone change the service adds, on both paths, the opposite legs **the caller owns** (same `transferId`, same `userId`), so an own-accounts transfer carries one zone on both legs.
- A leg owned by another user (a transfer into a shared account, `destOwnerUserId`) is left unchanged: `bulkUpdate` writes only the caller's rows (`where: { id, userId }`), as it already does for payees. The two legs then may differ; each owner annotates their own row.
- One `UPDATE` sets the zone and computes each row's offset at its own `time`:
  `"utcOffsetMinutes" = EXTRACT(EPOCH FROM (("time" AT TIME ZONE :zone) - ("time" AT TIME ZONE 'UTC'))) / 60`.
  An e2e test compares the SQL result with `zoneOffsetMinutes` across a DST switch, so Postgres's tz database and Node's ICU agree on the rows tested.
- Bank-synced rows are included: the zone is an annotation, and `time` is not touched.
- A zone change moves no money, balance or report day, because day membership follows the viewing zone. It needs no recompute.
- A mapping-style tool (ids → zones in one call) is not added: a backfill applies one zone per period, which is one bulk call per group.

**Tool time input** (`common/lib/time-zones/resolve-time-input.ts`, used by every MCP tool with a transaction time):

- `time` accepts:
  - `YYYY-MM-DDTHH:mm[:ss]`: a wall clock read in `timeZone`;
  - ISO with `Z` or an offset: an exact instant;
  - `YYYY-MM-DD`: noon in `timeZone`, the same rule imports use.
- `timeZone?` (IANA) is the zone the wall clock is read in and the zone the row records. A wall clock without it is read in `getUserTimeZone`; the row records `timeZone` when given, else `getStoredUserTimeZone` (so a user with no setting records `null`).
- A **non-zero** ISO offset that disagrees with an explicit `timeZone` at that instant is refused with a message telling the model to send the wall clock and the zone. `Z` is never refused: it names an instant and claims nothing about local time, so `{ time: '…Z', timeZone }` (what the proposal normalizer and the card editor produce) is always accepted, and the row records `timeZone`.
- **Create tools vs update tools.** The recording rule above is for tools that create a row (`create_transaction`, `adjust_account_balance`, `pay_subscription_period`, the portfolio transfer tools). Tools that change an existing row's time (`update_transaction`, `confirm_planned_transaction`) never change its zone unless `timeZone` is passed:
  - a wall clock is read in `timeZone` when given, else in the viewing zone (`getUserTimeZone`), as the form reads its input;
  - without `timeZone` the row keeps its stored zone (`null` stays `null`) and only the offset is recomputed at the new time, the same rule as `updateTransaction`;
  - with `timeZone` the row records it, as the dialog's zone field does.
- Descriptions say:
  - "Prefer the user's local wall time without an offset, plus timeZone when the payment happened elsewhere";
  - "never convert to UTC yourself".
- **Range bounds are a separate resolver**, `resolveRangeBound({ value, edge: 'start' | 'end', zone })` in the same file, never the point-in-time resolver (whose date-only rule is noon):
  - `YYYY-MM-DD` at `start` → `zonedDayStart`, at `end` → `zonedDayEnd`;
  - a wall clock → that instant in the user's zone; ISO with `Z` or an offset → as is.
  - Users: `search_transactions` (`startDate`/`endDate`), `transaction-filter-input` (`from`/`to`, also the `selection` of `bulk_update_transactions` / `bulk_delete_transactions`), `list_transfer_suggestions`, `create_tracker` / `update_tracker` (`startDate`/`endDate`, Z-only today through `dateBound({ precision: 'datetime' })`, `controllers/trackers/shared-schemas.ts:24-25`).
  - The tool converts every bound to a `Z` string **before** the REST schemas parse it (`parseTransactionFilters` re-validates through `dateRange({ precision: 'datetime' })`, `controllers/transactions.controller/transaction-filters.ts:29`, which accepts `Z` only), so the REST contract stays unchanged.
  - The descriptions drop "in UTC" and their `Z` examples.
- Out of scope, and their descriptions keep saying UTC: `get_security_prices` and the investment-transaction tools (market data and trades, not ledger times).

**Chat:**

- `prepareChatTurn` passes `getUserTimeZone(...)` instead of the server zone.
- `contextSection` adds a rule:

  > "Times the user mentions are in <zone> unless they name another place or zone. Pass transaction times and date ranges to tools as local wall time (2026-10-21T16:00) or dates, and add timeZone only for another zone. Never convert them to UTC. Tools whose description says UTC (security prices) take UTC."

- `propose.ts` normalizes the time arguments of a proposed call before storing the card, with the same resolvers the handlers use:
  - create tools: when the recorded zone is known, `{ time, timeZone? }` becomes `{ time: '<UTC ISO Z>', timeZone: '<zone>' }`; when it is `null` with an offset (an offset-only input), `time` becomes the ISO **with that offset** (`2026-10-21T16:00:00+02:00`) and `timeZone` is omitted; when both are `null`, `time` becomes `Z` and `timeZone` is omitted. `timeZone` is never stored as `null` on a create card: create tools' `timeZone` is optional, not nullable (only update tools accept `null`, to clear);
  - so approval re-resolves to the same pair: zone + `Z` → branch 1; offset ISO → branch 3; `Z` alone → branch 4 or 5;
  - update tools: `time` becomes `'<UTC ISO Z>'`, and `timeZone` is kept only when the model passed it (so approval does not re-zone the row).
  - The card shows the instant in the viewing zone, the editor writes an instant (`Z`) back, and on approval `resolveTimeInput` accepts `Z` with any `timeZone` (see above). An edited offset-only card loses its stated offset (the user typed a time in the viewing zone), so it records branch 4 or 5.

**Ingest:**

- `timeZone` (optional IANA) joins `CARD_PAYMENT_REQUEST_KEYS` and the event body.
- `resolvePayloadTime` also returns the parsed offset in minutes.
- The logged row's pair comes from `resolveRecordedZone`:
  - `explicitZone` is the request's `timeZone`;
  - `offsetMinutes` comes from the ISO;
  - `candidateZone` is `getStoredUserTimeZone` (`null` for a user with no setting).
- A blank time (the receive time) uses the request zone, else the setting.
- The shortcut adds a `Format Date` step with Custom format `VV` (Apple's date formatter prints the IANA ID) and sends it as `timeZone`. Whether this works is checked on a device (Post-Completion). Without it the offset alone is stored.
- In the notification path, `bankWallClock` is first read in the request zone (`wallClockToInstant`) and accepted when it lies within `inferBankTime`'s residual of the request time. Otherwise the existing inference runs.

**Imports:**

- The anchor zone is the request's `timezone` when sent, else `getUserTimeZone`. The recorded zone's candidate is the request's `timezone`, else `getStoredUserTimeZone`, so a user with no setting and no request zone records `null`.
- The frontend sends the viewing zone instead of the raw device zone.
- Each created row gets `resolveRecordedZone({ explicitZone: undefined, offsetMinutes: <cell offset if any>, candidateZone: <request timezone ?? getStoredUserTimeZone> })`. The anchor zone (with its `UTC` fallback) is only for reading the cell; it is never the candidate. An offset-free cell records the candidate (branch 4); a cell with an offset of its own keeps that offset, and the zone too when it matches.
- OFX: the upload parses dates (`ofx-import/date.ts`, zone from `X-Timezone`) and a separate execute request creates the rows (`ofx-import/execute-import.service.ts:230`, `time: new Date(tx.date)`). `parseOfxDate` also returns the offset the cell carried (`[±h:TZ]`), which the parsed transaction keeps as `utcOffsetMinutes`; the execute request (`controllers/import-export/ofx/execute-ofx.controller.ts`) gains `timezone`, which the frontend sends as for CSV; execute-import applies `resolveRecordedZone` per row.
- MS Money, Budget Bakers and YNAB (no zone in the file, values parsed as UTC) store `null`.

**Bank syncs** (owner's decision):

- No provider gives a zone. A payment synced soon after it happened most likely happened where the user is now, so a recent row records the user's setting zone at sync time.
- The rule, one helper for all five providers: `bankSyncRecordedZone({ time, syncedAt, userZone })`, where `userZone: string | null` comes from `getStoredUserTimeZone` (never the `UTC` fallback), in `services/bank-data-providers/utils/recorded-zone.ts`.
  - When `|syncedAt − time| ≤ BANK_SYNC_RECENT_ZONE_WINDOW_DAYS` (3 days, one exported constant in that file), the row gets `timeZone = userZone` and the offset at its `time`. A `null` `userZone` gives `null`/`null`.
  - Otherwise both columns stay `null`. This covers an initial or backfill sync (up to 90 days of history), when the user may have been elsewhere.
  - `syncedAt` is the sync job's start time, read once per sync, so every row of one sync is judged against the same moment.
- Call sites, each passing the pair to `createTransaction`:

  | Provider       | Create site                                         | `time` the rule compares            |
  | -------------- | --------------------------------------------------- | ----------------------------------- |
  | Monobank       | `monobank/transaction-sync-queue.ts:561-566`        | Unix seconds, an exact instant      |
  | SimpleFIN      | `simplefin/simplefin.provider.ts:882`               | `transacted_at ?? posted`           |
  | Enable Banking | `enablebanking/enablebanking.provider.ts:1098-1103` | the date-only value as UTC midnight |
  | LunchFlow      | `lunchflow/lunchflow.provider.ts:375-379`           | `new Date(tx.date)`                 |
  | Walutomat      | `walutomat/walutomat.provider.ts:395-401`           | `new Date(item.ts)`                 |

- A later sync that moves `time` (Enable Banking pending → booked, `:1040-1041`, which writes `updates.time` directly) also sets `utcOffsetMinutes` from the stored zone at the new time; a `null` zone stays `null`. The zone itself is not re-judged on that update.
- A user without a zone setting gets `null` ("Unknown") on every synced row, recent or not: `UTC` would record a zone nobody chose. The frontend writes a real zone on the first app open, so only syncs before that are affected.
- Enable Banking's and LunchFlow's date-only times at UTC midnight are a separate bug; see the Decisions section.

**Reports:**

- `from`/`to` (`YYYY-MM-DD`) become instants **in the user's zone**, keeping today's window semantics (`stats-transactions.ts:69-86`, `stats/utils/index.ts:36-50`): `from` → `zonedDayStart`; `to` → `zonedDayEnd` only when `from` is also given, and `zonedDayStart(to)` for an open-start window. With `zone = 'UTC'` every bound equals today's.
- Period buckets use date-fns v4 with `@date-fns/tz` (`startOfDay(d, { in: tz(zone) })`, likewise for week, month, quarter and year).
- Budgets: every `utcInstant` bound becomes a zoned bound: the `fromUtc` / `toUtc` / `poolFromUtc` pre-filter and the period JOIN (`AT TIME ZONE :zone`) in `activity/get-plan-activity.ts:94-107`, `activity/get-plan-cash.ts`, `get-scheduled.ts:104`. `fold/goal-schedule.ts` (calendar arithmetic on dates, no instants) stays as is.
- `getWhereConditionForTime` stays as it is: its only callers (`stats/get-balance-history.ts:116`, `get-balance-history-for-account.ts:54`) filter the DATEONLY `Balances.date`, which stays on UTC days (Decision 3).
- `zone` is a **required** parameter of `generatePeriodBuckets`, `findBucketIndex` and the `statsTransactions` window, so the compiler lists every caller and each one decides:
  - zoned (`getUserTimeZone`): cash flow, expenses history, cumulative, spending by categories, pivot (`get-pivot/{index,buckets}.ts`), tracker stats (`trackers/{spending-stats,stats,get-category-tracker-transactions}.ts`), subscriptions summary (`subscriptions/get-subscriptions-summary.ts`);
  - `'UTC'`, with a comment pointing at Decision 3: net-worth history (`get-net-worth-history/index.ts`, whose snapshot dates come from `format(bucket.periodEnd, 'yyyy-MM-dd')` at `:224` and must match UTC `Balances` days), net-worth drivers (`get-net-worth-drivers/{index,investment-growth,savings}.ts`, `stats/utils/savings-transactions.ts`), investment contributions (`get-investment-contributions/{index,derivations}.ts`).
- MCP report tools take their default range in the user's zone: `get_spending_by_categories` (`:35-41`) and `get_expenses_for_period` (`:28-33`) default to the current month **as dates** (`YYYY-MM-DD` of the first of the month and today in the user's zone), not server-time datetimes; `search_transactions` and `get_balance_history` compute "30 days ago" from today's date in the user's zone. Explicit bounds go through `resolveRangeBound`.
- Sites:
  - `stats/stats-transactions.ts` `windowWhere`;
  - `stats/utils/index.ts` (`generatePeriodBuckets`, `findBucketIndex`) and every caller listed above;
  - `budget-plans/{activity/get-plan-activity,activity/get-plan-cash,get-scheduled,date-ranges}.ts`;
  - the MCP report tools above.
- A user with no zone gets `UTC`, which is today's behavior.

**Frontend display:**

- `src/js/helpers/time-zone.ts` holds the refs `viewingTimeZone` and `hourCyclePreference`, synced in `app.vue` like `currencyDisplayPreference`, plus helpers:
  - `formatInViewingZone({ date, pattern })` uses `format(date, pattern, { in: tz(zone) })`;
  - `formatTime({ date, zone? })` gives `HH:mm`, or `h:mm a` under `h12`;
  - `formatZoneLabel({ date, zone })` uses Intl `timeZoneName: 'shortOffset'` and gives `GMT+4`;
  - `formatDateTime({ date, zone? })` gives `21 Oct 2026, 16:00 GMT+4`.
- Patterns that used `p` take the hour cycle from the ref instead of the locale.
- **`timeZone: null` means "Unknown" and is shown as if the feature did not exist.** Every display path formats the instant in the viewing zone and never converts to, labels, or compares with a recorded zone:
  - the list and table tooltip show one line (`formatDateTime` in the viewing zone) and no second-zone line;
  - the transaction dialog shows no "Recorded in" caption; the optional zone field, when the user has turned it on, shows its placeholder "Unknown" and stays empty;
  - chat cards, edit inputs and data export behave the same for `null` and non-`null` rows (viewing zone only; export's `localTime` uses the user's zone).
  - Chosen: no "Unknown" text in the detail view. Almost every existing row is `null`, so a label there would be noise on every old transaction.
- A helper `hasDistinctRecordedZone({ timeZone, utcOffsetMinutes, viewingZone, instant })` is the only gate for the second line and the caption: `false` for `null`/`null`, `false` when the recorded offset equals the viewing zone's offset at that instant, `true` otherwise. An offset-only row shows its second line as `UTC+02:00`.

## Decisions (made by the owner on 2026-10-21)

1. **One setting, not two.**
   - "Time zone" governs both viewing and saving.
   - Automatic follows the device, which covers the traveller who wants local times on the road. Each row's own zone then shows where it happened.
   - A separate "save in" zone would only matter for entering payments made elsewhere. The per-transaction zone picker in the form covers that.
   - Two settings would be needed for "view in my home zone while I travel, but record local zones". Add a second key later if wanted: the data model already supports it.
2. **Existing transactions: `null` ("Unknown").**
   - Existing rows came from several places and devices, and the current setting would assert a zone nobody knows.
   - `null` displays exactly as today (viewing zone, no second zone, no conversion) and costs no data rewrite. The detail view shows nothing for it (Technical Details → Frontend display).
   - Not chosen: stamping the current setting on manual rows only.
   - A user who knows better sets zones afterwards with the bulk edit (Task 12): by ids, or by a filter selection such as an account and a date range. The owner's own backfill uses it (Post-Completion).
3. **Day bucketing: the viewing zone (the setting).**
   - The list, analytics and budgets will agree, and a day is a contiguous span of time, so SQL ranges stay indexable.
   - Bucketing by each transaction's own local date (a coffee at 23:30 in New York lands on that New York day) needs per-row zone math in every report and can make days overlap. Rejected for now. `utcOffsetMinutes` keeps it possible later.
   - **`Balances` and net-worth history stay on UTC days.** Re-bucketing them would need a full balance rebuild on every zone change. This is a known limitation, flagged in the docs.
4. **The transaction zone in imports:**
   - CSV, OFX and statement imports stamp the zone they were anchored in, now the setting rather than the raw device zone;
   - a cell's own offset is kept;
   - MS Money, Budget Bakers and YNAB store `null`;
   - bank syncs record the user's setting zone for rows dated within 3 days of the sync (`BANK_SYNC_RECENT_ZONE_WINDOW_DAYS`), and `null` for older rows such as an initial 90-day history.
5. **12/24h: a new `hourCycle` setting**, default "Automatic (from language)", and the owner picks 24-hour.
   - Forcing 24-hour for everyone would change upstream English users' display.
   - The form input is already 24-hour (`is24hr`, `HH:mm`) and stays so under `h23`; under `h12` it shows AM/PM.
6. **The form's zone picker:**
   - It is an optional ("advanced") field `timeZone`. It is off by default, unlike the other optional fields, and shown regardless when the transaction's zone differs from the viewing zone.
   - The time input always shows the viewing zone, per the owner's "edit mode shows one zone".
   - Picking another zone changes only the recorded zone. A caption under the time shows the same instant in the picked zone ("= 08:00 in New York").
   - Alternative not chosen: read the typed wall clock in the picked zone, as calendar apps do.
7. **Follow-ups, out of scope:**
   - Enable Banking and LunchFlow date-only times anchored at UTC midnight. They show the previous day west of UTC. The fix is to anchor at noon in the user zone, but it changes stored times and dedup windows, so it needs its own plan.
   - Crons that use a UTC "today" (subscription auto-record and reminders).
   - Investment transactions' dates.

## What Goes Where

- **Implementation Steps** (`[ ]`): code, tests, docs in this repo.
- **Post-Completion** (no checkboxes): device check of the shortcut's `VV` format, re-signing the shortcut, the owner's settings and data backfill, the upstream PR split.

## Implementation Steps

### Task 1: Shared zone helpers and types

**Files:**

- Create: `packages/shared/src/time-zone/{index,zone-offset,wall-clock,zoned-days,recorded-zone,format-offset}.ts`
- Modify: `packages/shared/src/types/user-settings.ts` (`TIME_ZONE_SOURCES`, `HOUR_CYCLES`, `TRANSACTION_OPTIONAL_FIELDS` += `timeZone`), `packages/shared/src/types/transactions/transactions.ts` (`TransactionModel.timeZone`, `utcOffsetMinutes`; `CreateTransactionBody` / update body `timeZone?`), `packages/shared/src/types/ingest/index.ts` (`timeZone` request key)
- Modify: `packages/backend/src/services/import-export/core/parse/anchor-import-date.ts` (import the moved helpers), `anchor-import-date.unit.ts` (the New York gap expectation)
- Create: `packages/backend/src/services/import-export/core/parse/time-zone-helpers.unit.ts`

- [x] write failing unit tests:
  - `isValidTimeZone`: `Asia/Tbilisi`, `Europe/Kiev`, `UTC` pass; `+04:00`, `Mars/Base`, `''` fail;
  - `zoneOffsetMinutes`: Kathmandu +345; New York -300 / -240 around both 2026 DST switches;
  - `wallClockToInstant`: New York and Kyiv gaps both resolve forward (`2026-03-08T02:30` NY → `07:30Z`), New York and Kyiv overlaps both take the earlier instant, Kiritimati +14;
  - `zonedDayStart` / `zonedDayEnd`: Tbilisi `2026-10-21` → `2026-10-20T20:00Z` / `2026-10-21T19:59:59.999Z`; New York's 23- and 25-hour days; Kiritimati, Pago Pago;
  - `resolveRecordedZone`, each of the five branches (explicit zone; offset matching the candidate; offset not matching; candidate only; nothing), and a `Z` input with no zone and no candidate → `null`/`null`, not offset 0;
  - `formatOffset` for ±, zero and 45-minute offsets;
  - `anchor-import-date.unit.ts` passes with one change: the New York gap case expects `2026-03-08T07:30:00.000Z` and its comment says forward by the gap
- [x] implement the helpers with `Intl.DateTimeFormat` only; move the wall-clock code out of `anchor-import-date.ts`
- [x] add the shared constants and fields (➕ `TRANSACTION_OPTIONAL_FIELDS` += `timeZone` moved to Task 11: the form's field-reveal map must gain the field in the same change, or the frontend typecheck breaks; `isValidTimeZone` also checks the IANA name shape, since Intl accepts `+04:00`); `typecheck` stays green (frontend and backend compile with the new optional fields)
- [x] gate: unit `--testPathPattern='import-export/core/parse/(anchor-import-date|time-zone-helpers)'`; root `typecheck`

### Task 2: User settings: time zone, source, hour cycle

**Files:**

- Modify: `packages/backend/src/common/lib/zod/custom-types.ts` (`ianaTimeZone()`), `.unit.ts`
- Modify: `packages/backend/src/models/user-settings.model.ts` (both schemas)
- Create: `packages/backend/src/services/user-settings/get-user-time-zone.ts`
- Modify: `packages/backend/src/services/user-settings/patch-settings.e2e.ts`, `packages/backend/src/services/mcp/tools/notification-settings-tools.unit.ts` (or a new `time-zone-settings-tools.unit.ts`)
- Modify: `packages/frontend/src/api/user-settings.ts` (type)

- [ ] write failing unit tests:
  - `ianaTimeZone()` accepts an alias, refuses an offset and an unknown zone;
  - `update_user_settings` accepts `{ timeZone, timeZoneSource, hourCycle }` and refuses `timeZone: '+04:00'`
- [ ] write failing e2e:
  - `PATCH /user/settings` stores `timeZone: 'Asia/Tbilisi'`, `timeZoneSource: 'manual'`, `hourCycle: 'h23'` and `GET` returns them;
  - an invalid zone → 422;
  - patching `locale` leaves `timeZone` alone;
  - a user without the key reads as `UTC` through the chat prompt (covered in Task 5)
- [ ] implement the keys in `ZodSettingsSchema` and `ZodSettingsPatchSchema` (the `SettingsPatchSchemaIsInSync` guard must stay green), `getUserTimeZone` and `getStoredUserTimeZone`
- [ ] gate: unit `--testPathPattern='(zod/custom-types|mcp/tools/(notification-settings|time-zone-settings)-tools)'`; e2e `--testPathPattern='user-settings/patch-settings.e2e'`

### Task 3: Transaction columns and the REST create/update contract

**Files:**

- Create: `packages/backend/src/migrations/20261021000000-add-time-zone-to-transactions.ts`
- Modify: `packages/backend/src/models/transactions.model.ts`, `packages/backend/src/serializers/transactions.serializer.ts`, `packages/backend/src/controllers/transactions.controller/{create-transaction,update-transaction}.ts`, `packages/backend/src/services/transactions/{create-transaction,types}.ts`, `packages/backend/src/services/transactions/update-transaction/update-transaction.ts`, `packages/backend/src/services/mcp/serializers.ts` (output fields)
- Modify: `packages/backend/src/services/transactions/planned-matching/merge-into-planned.ts`
- Modify: `packages/backend/src/services/accounts/balance-adjustment.ts`, `packages/backend/src/services/subscriptions/{mark-period-paid,build-transaction-from-subscription,process-auto-record}.ts`, `packages/backend/src/services/investments/portfolios/transfers/{account-to-portfolio,portfolio-to-account}-transfer.service.ts` and their REST controllers' bodies (`timeZone?`)
- Create: `packages/backend/src/services/transactions/time-zone.e2e.ts`

- [ ] write failing e2e:
  - create with `timeZone: 'America/New_York'` returns the zone and `utcOffsetMinutes: -240` (a summer instant);
  - create without `timeZone` returns `null`/`null`;
  - a transfer's two legs carry the same pair;
  - updating `time` into winter recomputes `-300`;
  - updating `timeZone: null` clears both;
  - updating `timeZone` on a bank-synced row (helper-made external account) succeeds while `time` stays refused;
  - an invalid zone → 422;
  - `GET /transactions` and the by-id route return both fields;
  - a balance adjustment, a subscription mark-paid and an account→portfolio transfer, each through REST with `timeZone`, record it; an auto-recorded subscription payment records the user's stored zone (`null` without a setting);
  - a planned row created through REST with `timeZone: 'America/New_York'` in October, merged by a CSV import row in November for a user **with no zone setting**, imported **without** a `timezone` in the request (so the incoming row is `null` before and after Task 7), keeps New York and gets -300 (`merge-on-import.e2e.ts`'s setup); the case where the incoming row has a zone is tested in Task 7, the first task with an HTTP path that produces one;
  - `real-transactions-view-columns.e2e.ts` gains a case: a planned row is not in the view
- [ ] implement the migration (both columns, CHECK on the offset range, the `real_transactions` view rebuild; `down` reverses it), the model fields, `createTransaction` / `updateTransaction` params and derivation, and the opposite-leg copy (`create-transaction.ts:325-333`) plus its update twin
- [ ] gate: e2e `--testPathPattern='(transactions/(time-zone|get-by-id|get-transactions|planned-matching/merge-on-import)|transactions-query/real-transactions-view-columns)\.e2e'`

### Task 4: Tool time input for MCP and the chat cards

**Files:**

- Create: `packages/backend/src/common/lib/time-zones/resolve-time-input.ts`, `.unit.ts`
- Modify: `packages/backend/src/services/mcp/tools/{create-transaction,update-transaction,adjust-account-balance,confirm-planned-transaction,pay-subscription-period,transfer-account-to-portfolio,transfer-portfolio-to-account,search-transactions,transaction-filter-input,list-transfer-suggestions,create-tracker,update-tracker}.ts`, `packages/backend/src/services/mcp/tool-arg-validators.ts`, `packages/backend/src/services/mcp/prompts/financial-data-guide.ts`
- Modify: `packages/backend/src/services/chat/toolkit/propose.ts` (+ `services/chat/proposals/normalize-time-args.ts`, `.unit.ts`)
- Modify: `packages/frontend/public/skills/connect-moneymatter/SKILL.md`, `packages/frontend/public/.well-known/agent-skills/index.json` (sha256)
- Modify: tool unit tests (`transaction-read-tools.unit.ts`, `transaction-amount-inputs.unit.ts`, …)
- Create: `packages/backend/src/services/mcp/tool-time-input.e2e.ts` (through the MCP HTTP endpoint, as `mcp-scope-gate.e2e.ts` does), `packages/backend/src/services/chat/proposals/time-args.e2e.ts`

- [ ] write failing unit tests:
  - `resolveTimeInput`:
    - `2026-10-21T16:00` + user zone `Asia/Tbilisi` → `12:00Z`, zone Tbilisi, +240;
    - `+ timeZone: 'America/New_York'` → `20:00Z`, zone New York;
    - `2026-10-21T16:00:00+04:00` → `12:00Z`, zone Tbilisi (the candidate matches);
    - `…+02:00` with a Tbilisi user → offset +120, zone `null`;
    - `…+02:00` with `timeZone: 'Asia/Tbilisi'` → refused;
    - `2026-10-21` → local noon;
    - garbage → refused;
    - `2026-10-21T12:00:00Z` + `timeZone: 'Asia/Tbilisi'` → accepted, `12:00Z`, zone Tbilisi;
    - `2026-10-21T12:00:00Z` alone for a Tbilisi user → zone Tbilisi, +240; for a user with no setting → `null`/`null` (never offset 0);
  - `confirm_planned_transaction` and `pay_subscription_period` accept a wall clock (`2026-10-21T16:00` → `12:00Z` for a Tbilisi user), not only `Z`;
  - `normalizeTimeArgs` on an offset-only create (`+02:00`, Tbilisi user) stores the offset ISO without `timeZone`, and re-resolving it gives `{null, +120}`; a user with no setting gets a card with no `timeZone` key;
  - update mode: no `timeZone` on a New York row → the zone stays New York, the wall clock is read in the viewing zone, the offset is recomputed; a `null` row stays `null`; `timeZone` given → recorded;
  - `resolveRangeBound`: `2026-10-21` as start/end for a Tbilisi user → `2026-10-20T20:00Z` / `2026-10-21T19:59:59.999Z`; a `Z` bound passes through;
  - each tool's `validate…Args` refuses a bad zone;
  - `normalizeTimeArgs` rewrites only the known time keys of the transaction tools
- [ ] write failing e2e:
  - MCP `create_transaction` with `time: '2026-10-21T16:00'` for a user with `timeZone: 'Asia/Tbilisi'` stores `12:00Z` and the zone;
  - a chat card for the same call stores `time` as `12:00:00.000Z` with `timeZone`, and approving it creates that row;
  - a chat card for `update_transaction` on a New York row changes the time and keeps `America/New_York`;
  - `search_transactions` with `startDate=endDate=2026-10-21` for a Tbilisi user returns a row at `2026-10-20T21:30Z` and one at `2026-10-21T19:00Z`;
  - `create_tracker` with `startDate: '2026-10-01'` stores `2026-09-30T20:00Z` for a Tbilisi user
- [ ] implement:
  - the resolver;
  - the tools take `time` and `timeZone` through it and pass `{ timeZone, utcOffsetMinutes }` to the services Task 3 extended; update tools use update mode;
  - range-bound tools convert through `resolveRangeBound` before the REST schema parse;
  - `adjust_account_balance`, `confirm_planned_transaction` and `pay_subscription_period` drop `transactionTimeSchema()` for the resolver's input schema;
  - the descriptions as in Technical Details;
  - the proposal normalizer;
  - the guide paragraph on zones
- [ ] update the agent SKILL.md text on times and its sha256 (the `add-mcp-tool` skill's drift checklist)
- [ ] gate: unit `--testPathPattern='(time-zones/resolve-time-input|mcp/tools/.*|mcp/(agent-skills|server-card|tool-arg-validators)-drift|chat/proposals/normalize-time-args)'`; e2e `--testPathPattern='(mcp/tool-time-input|chat/proposals/(approve|time-args)|trackers/tracker-crud)\.e2e'`

### Task 5: Chat system prompt in the user's zone

**Files:**

- Modify: `packages/backend/src/services/chat/runners/prepare-turn.ts`, `packages/backend/src/services/chat/prompt/system-prompt.ts`, `system-prompt.unit.ts`
- Modify: `packages/backend/src/services/chat/runs/run-stream.e2e.ts` (assert the system text the mocked model receives)

- [ ] write failing tests:
  - unit: the context section carries the time rule and the user's zone;
  - e2e: a user with `timeZone: 'Asia/Tbilisi'` gets "Now: … (Asia/Tbilisi)" in the system prompt the mocked model receives, and a user without one gets `UTC`
- [ ] implement: `getUserTimeZone` in `prepareChatTurn` (it already loads settings), the rule text
- [ ] gate: unit `--testPathPattern='chat/prompt/system-prompt'`; e2e `--testPathPattern='chat/runs/run-stream\.e2e'`

### Task 6: Ingest: zone from the device, offset fallback, bank wall clock

**Files:**

- Modify: `packages/backend/src/services/ingest/card-payment/{parse-payload,sanitize-payload,process-card-payment}.ts`, `packages/backend/src/services/ingest/event/{parse-notification-payload,log-notification-payment}.ts`, `packages/backend/src/services/ingest/log-ingested-payment.ts`, `packages/backend/src/services/ingest/dedup/{enrich-twin,twin-rule}.ts`
- Modify: `packages/frontend/scripts/shortcuts/{build-payments-shortcut,build-card-payment-shortcut}.ts` + specs; regenerate `packages/frontend/shortcuts/{log-payments,log-card-payment}.plist` with `npm run shortcuts:build` (unsigned; the signed `.shortcut` files in `public/shortcuts/` are Post-Completion)
- Modify: `packages/backend/docs/card-payment-ingest.md`
- Modify: `parse-payload.unit.ts`, `twin-rule` unit, `ingest-card-payment.e2e.ts`, `ingest-event.e2e.ts`

- [ ] write failing unit tests:
  - `resolvePayloadTime` returns the offset (`+04:00` → 240, `Z` → 0, blank → none);
  - an invalid `timeZone` is a rejection reason (`invalidTimeZone`, added to `CARD_PAYMENT_REJECTION_REASONS`);
  - the wall clock read in the request zone wins when within the residual
- [ ] write failing e2e:
  - a tap with `time: …+04:00` and `timeZone: 'Asia/Tbilisi'` → row zone Tbilisi, +240;
  - the same without `timeZone` for a Tbilisi user → Tbilisi;
  - for a Kyiv user → zone `null`, +240;
  - blank time → the setting's zone;
  - a notification row gets the same treatment
- [ ] implement the request key, the resolver change and `resolveRecordedZone` at `logIngestedPayment` (`pipeline`-independent)
- [ ] shortcut: add the `Format Date` (Custom `VV`) action and the `timeZone` key to both bodies; specs assert the action and the key
- [ ] gate: unit `--testPathPattern='ingest/(card-payment/parse-payload|dedup/.*|event/parse-notification-payload)'`; e2e `--testPathPattern='ingest/(card-payment/ingest-card-payment|event/ingest-event)\.e2e'`; frontend `scripts/shortcuts`

### Task 7: Imports, bank syncs, backups and data export

**Files:**

- Modify: `packages/backend/src/services/import-export/{csv-import/parse-valid-rows,csv-import/execute-import/index,statement-parser/execute-import.service,statement-parser/ai-extraction.service,ofx-import/date}.ts` and the controllers that read `timezone` / `X-Timezone` (fallback to `getUserTimeZone`)
- Modify: `packages/backend/src/services/import-export/core/parse/anchor-import-date.ts` (also return the offset the cell carried, if any)
- Modify: `packages/backend/src/services/data-export/transformers/transactions-transformer.ts`
- Modify: `packages/backend/src/services/import-export/ofx-import/{date,execute-import.service}.ts`, `packages/backend/src/controllers/import-export/ofx/execute-ofx.controller.ts`, `ofx-import/date.unit.ts`
- Create: `packages/backend/src/services/bank-data-providers/utils/recorded-zone.ts`, `.unit.ts`
- Modify: the five provider create sites listed in Technical Details → Bank syncs
- Modify: `detect-duplicates.e2e.ts`, `statement-parser/execute-import.e2e.ts`, `ai-extraction.e2e.ts`, `backup/restore/restore-backup.e2e.ts`, `data-export/export-data.e2e.ts`, one bank sync e2e (`bank-data-providers/connection/transaction-sync.e2e.ts`)

- [ ] write failing e2e:
  - a CSV row `2026-06-01 23:30` imported with `timezone: 'America/Montevideo'` stores that zone and -180;
  - the same import **without** `timezone` for a user whose setting is Montevideo anchors in Montevideo (today: UTC);
  - a statement import stamps the zone;
  - an OFX import executed with `timezone: 'America/Montevideo'` stamps that zone on an offset-free row, and a row with `[+2:EET]` keeps +120;
  - the statement AI's "today" uses the setting when the request has none;
  - a Tbilisi user's bank sync: a row dated 1 day before the sync gets `Asia/Tbilisi` and +240; a row dated 90 days back stays `null`/`null`; a user with no setting gets `null`/`null` on the recent row too;
  - a planned row without a zone, matched by that recent synced row with `Asia/Tbilisi`, takes the incoming pair (`planned-matching/merge-on-sync.e2e.ts` setup);
  - backup → restore keeps both columns, and restoring a fixture archive without the columns gives `null`;
  - data export adds `timeZone` and `localTime` (ISO with the row's offset, or the user's zone when `null`) and leaves `date`/`time` as they are
- [ ] write failing unit tests for `bankSyncRecordedZone`: exactly 3 days → stamped; 3 days and 1 second → `null`; a future-dated row within the window → stamped; `userZone: null` inside the window → `null`/`null`
- [ ] implement (backend only; the frontend starts sending the viewing zone in Task 13, once Task 9's `viewingTimeZone` exists; until then the backend's fallback to the stored setting covers a request without `timezone`)
- [ ] gate: e2e `--testPathPattern='(import-export/(csv-import/detect-duplicates|statement-parser/(execute-import|ai-extraction))|backup/restore/restore-backup|data-export/export-data|import-export/ofx-import/.*|bank-data-providers/connection/transaction-sync|transactions/planned-matching/merge-on-sync)\.e2e'`; unit `--testPathPattern='(bank-data-providers/utils/recorded-zone|ofx-import/date)'`

### Task 8: Report day bucketing in the user's zone

**Files:**

- Modify: `packages/backend/package.json` (`@date-fns/tz`, pinned)
- Create: `packages/backend/src/common/lib/time-zones/tz-options.ts`, `.unit.ts` (`tzOptions({ zone })` for date-fns; the day bounds come from Task 1)
- Modify: `packages/backend/src/services/stats/{stats-transactions,utils/index,utils/savings-transactions,get-cash-flow,get-expenses-history,get-cumulative-data}.ts`, `stats/get-pivot/{index,buckets}.ts`, `stats/get-spendings-by-categories/index.ts`, `stats/get-net-worth-history/index.ts`, `stats/get-net-worth-drivers/{index,investment-growth,savings}.ts`, `stats/get-investment-contributions/{index,derivations}.ts` (explicit `'UTC'`), `services/trackers/{spending-stats,stats,get-category-tracker-transactions}.ts`, `services/subscriptions/get-subscriptions-summary.ts`, `services/budget-plans/{activity/get-plan-activity,activity/get-plan-cash,get-scheduled,date-ranges}.ts`, `services/mcp/tools/{get-spending-by-categories,get-expenses-for-period,search-transactions,get-balance-history}.ts` (defaults)
- Create: `packages/backend/src/services/stats/time-zone-buckets.e2e.ts`, `packages/backend/src/services/budget-plans/time-zone-activity.e2e.ts`

- [ ] write failing unit tests:
  - month buckets for Tbilisi start at local midnight; New York's November bucket spans the 25-hour day;
  - an open-start window with `to=2026-10-21` ends at `zonedDayStart('2026-10-21')`, and with `zone: 'UTC'` every bound equals today's
- [ ] write failing e2e:
  - a Tbilisi user's expense at `2026-10-20T21:30Z` (01:30 local on the 21st) counts on Oct 21 in cash flow (daily), spending-by-categories for `from=to=2026-10-21`, pivot by day, tracker spending, and the October budget period when it is the first day;
  - a New York user's `2026-11-01T03:30Z` counts on Oct 31;
  - the same Tbilisi row counts in the first budget period's activity **and** cash (`get-plan-cash`), and a New York row at `2026-11-01T03:30Z` counts in October's last period;
  - `get_spending_by_categories` with no dates, called for a Tbilisi user at `2026-10-31T21:30Z` (01:30 on Nov 1 local), reports November;
  - net-worth history for a New York user keeps the October point on Oct 31 (UTC days);
  - a user without a zone keeps today's results (re-run the existing stats e2e unchanged)
- [ ] implement with `{ in: tz(zone) }` on the date-fns calls and `AT TIME ZONE :zone` in the budget SQL; `Balances` untouched (comment why)
- [ ] gate: unit `--testPathPattern='(time-zones/tz-options|stats/utils)'`; e2e `--testPathPattern='(stats/(time-zone-buckets|get-cash-flow|get-pivot|get-cumulative-data|get-net-worth-history|get-net-worth-drivers)|budget-plans/time-zone-activity|trackers/spending-stats|subscriptions/subscriptions)\.e2e'`

### Task 9: Frontend: zone and clock state, formatting helpers, auto sync

**Files:**

- Modify: `packages/frontend/package.json` (`@date-fns/tz`, same pin)
- Create: `packages/frontend/src/js/helpers/time-zone.ts`, `.test.ts`; `packages/frontend/src/composable/use-device-time-zone-sync.ts`, `.test.ts`
- Modify: `packages/frontend/src/app.vue`

- [ ] write failing vitest:
  - `formatTime` gives `16:00` under `h23` and `4:00 PM` under `h12` for the same instant;
  - `formatZoneLabel` gives `GMT+4` for Tbilisi;
  - `formatDateTime` in a zone that is not the test runner's;
  - `viewingTimeZone` picks manual over device;
  - the sync composable patches once when the source is device and the zone differs, never when manual, and again after a `visibilitychange` with a new zone
- [ ] implement the refs, the helpers and the composable, wired in `app.vue`
- [ ] gate: frontend `src/js/helpers/time-zone.test.ts src/composable/use-device-time-zone-sync.test.ts`

### Task 10: Frontend: settings UI

**Files:**

- Modify: `packages/frontend/src/pages/settings/subpages/language/index.vue` (section "Time zone and clock"), or a new `rows/time-zone-rows.vue` beside it
- Create: `packages/frontend/src/components/fields/time-zone-select-field.vue`, `.test.ts` (searchable, built on the existing combobox; options from `Intl.supportedValuesOf('timeZone')` labelled `GMT+4 · Asia/Tbilisi`, with "Automatic (device): Asia/Tbilisi" first)
- i18n `en` + `uk` via `i18n-editor`

- [ ] write failing vitest: choosing Automatic patches `{ timeZoneSource: 'device', timeZone: <device> }`; choosing a zone patches `{ timeZoneSource: 'manual', timeZone }`; the clock control patches `hourCycle` and "Automatic" removes it (patch with the locale default, or a `null` the schema allows; pick one and test it)
- [ ] implement with a placeholder, sentence case, a success toast
- [ ] gate: frontend `src/components/fields/time-zone-select-field.test.ts` and the page test if one exists

### Task 11: Frontend: display and the transaction form

**Files:**

- Modify: `packages/frontend/src/components/transactions-list/transaction-record.vue`, `packages/frontend/src/components/transactions-table/transaction-table-row.vue` (date in the viewing zone; `DesktopOnlyTooltip` on the date with `formatDateTime`, plus a second line for the row's own zone when it differs)
- Modify: `packages/frontend/src/components/fields/date-field.vue` (a `timeZone` prop, default `viewingTimeZone`; input formatting and parsing through `tz`; v-calendar `timezone` prop; `is24hr` from `hourCyclePreference`)
- Modify: `packages/frontend/src/components/dialogs/manage-transaction/{dialog-content.vue,helpers.ts,types.ts,utils/prepare-tx-creation-params.ts,utils/prepare-tx-updation-params.ts,composables/use-optional-fields.ts}` (the `timeZone` form field, the caption, sending `timeZone`; `timeZone` excluded from `DEFAULT_OPTIONAL_FIELDS` and shown when it differs from the viewing zone)
- Modify: `packages/frontend/src/api/accounts.ts` (`:60`, balance adjustment), `packages/frontend/src/api/subscriptions.ts` (`:231`, mark paid), `packages/frontend/src/api/portfolios.ts` (`:94`, `:112`, account↔portfolio transfers): each body sends `timeZone: viewingTimeZone`; their dialogs (`pages/account/components/balance-adjustment-dialog.vue`, `pages/planned/subscriptions/components/subscription-mark-paid-dialog.vue`, the portfolio transfer dialogs) read and show times through `date-field` in the viewing zone
- Modify: `packages/frontend/src/components/chat/visuals/format-visual-value.ts`, `packages/frontend/src/pages/settings/subpages/ai/pages/chat-applied-changes.vue`, `packages/frontend/src/pages/accounts/integrations/ios-automation/components/{payment-request-summary,unconfirmed-payments}.vue`, `packages/frontend/src/pages/optimizations/reconciliation/components/merge-dialog.vue`, `packages/frontend/src/pages/settings/subpages/general/rows/transaction-rows.vue` (the new optional field's label)
- Specs beside each changed util; i18n `en` + `uk`

- [ ] write failing vitest:
  - `date-field` with `timeZone: 'Asia/Tbilisi'` shows `2026-10-21 16:00` for `12:00Z` and emits `12:00Z` back when 16:00 is typed;
  - `prepareTxCreationParams` sends `timeZone`;
  - the balance-adjustment, mark-paid and both portfolio-transfer API calls send `timeZone`;
  - the optional-field visibility rule;
  - `formatVisualDate` shows a `Z` instant in the viewing zone with the hour cycle;
  - the list tooltip text with and without a second zone;
  - `hasDistinctRecordedZone` for `null`/`null`, a same-offset zone, a different zone and an offset-only row;
  - a `null` row in the list, the table, the dialog and a chat card renders exactly what it renders today in the viewing zone (no caption, no second line, empty zone field with the "Unknown" placeholder)
- [ ] implement; the dialog caption reads "Recorded in America/New_York: 08:00 GMT-4" when the row's zone differs
- [ ] gate: frontend the changed spec files

### Task 12: Bulk zone edits: API, MCP and the list action

**Files:**

- Modify: `packages/backend/src/services/transactions/bulk-update.ts`, `packages/backend/src/controllers/transactions.controller/bulk-update.ts`, `packages/backend/src/services/mcp/tools/bulk-update-transactions.ts` (+ its validator in `tool-arg-validators.ts`), `packages/shared/src/types/transactions/transactions.ts` (bulk body type)
- Modify: `packages/backend/src/controllers/transactions.controller/bulk-update.e2e.ts`, the bulk tool's unit test
- Modify: `packages/frontend/src/components/transactions-list/bulk-action-dialogs.vue`, `packages/frontend/src/composable/use-bulk-transaction-actions.ts`, `packages/frontend/src/api/transactions.ts` + specs; i18n `en` + `uk`

- [ ] write failing e2e:
  - `PUT /transactions/bulk` with `transactionIds` and `timeZone: 'Asia/Makassar'` sets the zone on each row and the offset at each row's own time (+480);
  - the same by a filter `selection` (one account, a date range) with one `excludedIds` row left untouched;
  - an own-accounts transfer selected by one leg gets the zone on both legs, by ids and by selection;
  - a transfer into another user's shared account: the caller's leg is updated, the other user's leg is unchanged;
  - New York rows on both sides of the 2026 DST switch get -240 and -300, equal to `zoneOffsetMinutes`;
  - `timeZone: null` clears both columns;
  - a bank-synced row is updated, and its `time` is unchanged;
  - an invalid zone → 422; another user's ids → not updated;
  - `timeZone` alone is a valid bulk body (the "at least one field" check counts it)
- [ ] write failing unit tests: `bulk_update_transactions` accepts `timeZone` and `null`, refuses `+04:00`; its description says what the zone means and that the offset is computed per row
- [ ] implement per Technical Details → Bulk zone edits
- [ ] frontend: a "Set time zone" bulk action beside the existing ones. Its dialog uses `time-zone-select-field` (Task 10) plus a "Clear" choice, sends the current target (ids or selection), shows the toast and invalidates the transaction queries. Vitest covers the payload for both target kinds.
- [ ] gate: e2e `--testPathPattern='transactions.controller/bulk-update\.e2e'`; unit `--testPathPattern='mcp/tools/.*bulk'`; frontend the changed spec files

### Task 13: Frontend: filters, presets and widgets in the viewing zone

**Files:**

- Modify: `packages/frontend/src/stores/{statement-parser,import-export}.ts`, `packages/frontend/src/api/import-ofx.ts` (send `viewingTimeZone`; OFX also on execute) + `src/stores/import-export.test.ts`
- Modify: `packages/frontend/src/components/records-filters/use-filters-from-query.ts`, `packages/frontend/src/api/stats.ts` (`formatDate` in the viewing zone), the date-preset helpers (`components/lib/ui/date-selector`, `TRANSACTION_DATE_PRESETS` consumers), `components/widgets/{spending-pace-widget/index.vue,balance-trend.vue,latest-records.vue}`
- Specs beside each

- [ ] write failing vitest: "today" for a Tbilisi viewer at `2026-10-20T21:30Z` is Oct 21; the end bound of `end=2026-10-21` is `2026-10-21T19:59:59.999Z` in Tbilisi; `api/stats` sends the viewing-zone calendar day; the import stores send `viewingTimeZone` (the two existing expectations change)
- [ ] implement with `tz(viewingTimeZone)`
- [ ] gate: frontend the changed spec files

### Task 14: Verify acceptance criteria

- [ ] the Haiku scenario end to end against a mocked model: the clock is fixed at `2026-07-15T10:00Z` (summer in Kyiv, so the offsets below hold on any run date); a Tbilisi user says "coffee 5 GEL at 16:00"; the model calls `create_transaction` with `time: '2026-07-15T16:00'`; the card shows 16:00; approval stores `2026-07-15T12:00Z`, `Asia/Tbilisi`, +240; the list tooltip shows 16:00 GMT+4
- [ ] the same chat after switching the setting to manual `Europe/Kyiv`: the list shows 15:00 GMT+3 and a second line "Recorded in Asia/Tbilisi: 16:00 GMT+4"
- [ ] a user without a zone sees no change in reports (the existing stats and budgets e2e suites pass untouched)
- [ ] Playwright flow from the Testing Strategy
- [ ] full backend unit suite, the e2e patterns of Tasks 2–8 and 12 in one serial run (including `real-transactions-view-columns.e2e`), the frontend suite, root `typecheck`, `lint`, `format:check`, `knip`

### Task 15: Documentation

- [ ] user docs (`packages/docs`, via `user-docs`): a "Time zone and clock" settings page; how each source records a zone; the note that balance history uses UTC days
- [ ] `packages/docs/.../integrations/ios-automation.mdx` and `packages/backend/docs/card-payment-ingest.md`: the `timeZone` key and the offset fallback
- [ ] MCP: the guide paragraph and SKILL.md (done in Task 4), checked against the final tool descriptions
- [ ] `.claude/docs/backend-conventions.md`: a short "Times and zones" section (instants in `time`, `resolveRecordedZone` for the zone, `getUserTimeZone` for day bounds, `getStoredUserTimeZone` for recording, ledger-time and range tools never take UTC-only input, update tools never re-zone a row)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

_Items requiring manual work or external systems; no checkboxes._

**Device check (owner's iPhone):**

- Confirm that Shortcuts' Format Date with Custom `VV` prints an IANA ID (`Asia/Tbilisi`), on the tap path and on the notification path.
- If it prints something else, drop the action: the server stores the offset and the zone when it matches the setting.
- Then sign and share the regenerated plists (`public/shortcuts/README.md`).

**Owner settings:** set Clock to 24-hour, and leave Time zone on Automatic, which writes `Asia/Tbilisi` on first open.

**Owner data backfill (one-off, after Task 12 is deployed; not part of the upstream PR):**

- **Source 1, the Sheets ledger.** Read the per-row zones of the old Google Sheets ledger with the `bt` CLI. Match each row to its MoneyMatter transaction (account, amount, date, then merchant or note). Matched rows with a sheet zone are applied as they are, without review.
- **Source 2, inference from context, for every other row.** Look at what was happening around the transaction's date, a few days on either side:
  - where the owner's other spending happened then: merchant locations and countries, spending in a local currency;
  - the sheet zones of neighbouring rows.
  - Take the majority country in that window and its zone.
  - Do **not** take the zone from the account's country group or its currency: a Georgian card is used abroad. The account's country is at most a weak tiebreaker.
  - Windows with mixed signals, such as travel days, are marked uncertain.
- **Review: every inferred zone needs the owner's approval**, not only the uncertain ones.
  - Present the inferred zones grouped by period and country, one line each, e.g. "Mar 3–17: Indonesia (Asia/Makassar, UTC+8), 42 transactions".
  - Uncertain rows are flagged inside their group with the reason.
  - The owner approves or corrects each group.
- **Apply.** Only after approval: one `bulk_update_transactions` call (or `PUT /transactions/bulk`) per approved group, with `transactionIds` and the group's `timeZone`. Keep the list of applied groups and ids as the record. A wrong group can be undone by clearing it with `timeZone: null`.

**Upstream PR shape:** Tasks 1–5 and 9–12 stand alone, as the zone column, the AI fix, display and bulk zone edits. Tasks 6–8 and 13 can follow as a second PR, since report bucketing is the only visible behavior change for users who set nothing.

**Release note:** reports, budgets and the list now agree on day boundaries in the user's zone. Before, reports used UTC days.
