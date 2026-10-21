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

**The transaction column and its write paths.** `Transactions.time` is `DataType.DATE` (`models/transactions.model.ts:199-203`). Every path ends in `createTransaction` (`services/transactions/create-transaction.ts`), which defaults `time` to `new Date()` (`:504`, `:564`, `:650`) and copies `time` onto the opposite transfer leg (`:325-333`). The callers:

- **Manual form:**
  - create sends `time.toUTCString()` (`frontend/src/components/dialogs/manage-transaction/utils/prepare-tx-creation-params.ts:54`);
  - update sends `time.toISOString()` (`prepare-tx-updation-params.ts:160`);
  - REST requires a UTC `Z` string: `transactionTimeSchema` (`controllers/transactions.controller/schemas.ts:18-24`).
- **AI chat and MCP:**
  - the chat applies a card by invoking the MCP handler (`services/chat/proposals/approve.ts:202`, catalog in `services/mcp/tool-catalog.ts`);
  - the tools with a time argument are `create_transaction`, `update_transaction`, `adjust_account_balance` (`transactionTimeSchema`, Z only), `confirm_planned_transaction`, `pay_subscription_period`, and the date bounds of `search_transactions` and `transaction-filter-input.ts:30-31` ("ISO 8601 datetime in UTC");
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
- **One rule decides a row's zone.** `resolveRecordedZone({ instant, offsetMinutes, candidateZone })`:
  - an explicit zone wins, and the offset is derived from it;
  - an offset alone keeps the candidate zone when the candidate's offset at that instant is equal, and is stored without a zone otherwise;
  - with neither, the result is `null`.
- **Viewing and day membership use the setting's zone.** A transaction's own zone is information shown beside the time. It never moves the instant and never decides which report day the row lands in.

## Technical Details

**Settings keys** (backend Zod, the patch schema and the frontend type, together):

- `timeZone?: string`: IANA name; `ianaTimeZone()` checks it.
- `timeZoneSource?: 'device' | 'manual'`: unset means `device`.
- `hourCycle?: 'h23' | 'h12'`: unset means the locale's default.

`getUserTimeZone({ userId })` returns `settings.timeZone ?? 'UTC'`. Constants `TIME_ZONE_SOURCES` and `HOUR_CYCLES` go in `shared/src/types/user-settings.ts`.

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
- no index, no backfill.

**Shared helpers** (`packages/shared/src/time-zone/`, Intl only, no dependencies):

- `isValidTimeZone({ zone })`;
- `zoneOffsetMinutes({ zone, instant })`;
- `wallClockToInstant({ wall, zone })`: moved out of `anchor-import-date.ts` (`zonedWallClockToInstant` / `timezoneOffsetMs`), which then imports it;
- `resolveRecordedZone({ instant, offsetMinutes, candidateZone, explicitZone })` → `{ timeZone, utcOffsetMinutes }`;
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

**REST:**

- `CreateTransactionBody` / `UpdateTransactionBody` gain `timeZone?: string | null` (`ianaTimeZone().nullable().optional()`). `time` stays a UTC `Z` instant.
- Responses gain `timeZone` and `utcOffsetMinutes`, through `serializeTransaction` and the shared `TransactionModel`.
- The frontend always sends `timeZone` on create: the viewing zone, or the zone picked in the form.

**Bulk zone edits** (no new tool; the existing bulk update grows one field):

- `bulkUpdate` (`services/transactions/bulk-update.ts`), `PUT /transactions/bulk` (`controllers/transactions.controller/bulk-update.ts`) and MCP `bulk_update_transactions` take `timeZone?: string | null`. `null` clears both columns.
- The target is the existing bulk target: `transactionIds`, or a filter `selection` with `excludedIds` (`resolveBulkTargetIds`, `services/transactions/matching-transactions.ts:86`). An account and a date range select a whole trip in one call.
- `resolveBulkTargetIds` keeps one leg per transfer (`dedupeTransferLegs`). For a zone change the service adds the opposite legs back, so both legs carry the same zone.
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
- `timeZone?` (IANA) is the zone the wall clock is read in and the zone the row records. It defaults to `getUserTimeZone`.
- An ISO offset that disagrees with an explicit `timeZone` at that instant is refused with a message telling the model to send the wall clock and the zone. It is not silently re-zoned.
- Descriptions say:
  - "Prefer the user's local wall time without an offset, plus timeZone when the payment happened elsewhere";
  - "never convert to UTC yourself".
- `search_transactions` and `transaction-filter-input` bounds accept a date or a wall clock read in the user's zone, and the descriptions drop "in UTC".

**Chat:**

- `prepareChatTurn` passes `getUserTimeZone(...)` instead of the server zone.
- `contextSection` adds a rule:

  > "Times the user mentions are in <zone> unless they name another place or zone. Pass them to tools as local wall time (2026-10-21T16:00) and add timeZone only for another zone. Never convert times to UTC."

- `propose.ts` normalizes the time arguments of a proposed call before storing the card: `{ time, timeZone? }` becomes `{ time: '<UTC ISO Z>', timeZone: '<zone>' }`. The card therefore shows the instant in the viewing zone, and the editor writes an instant back.

**Ingest:**

- `timeZone` (optional IANA) joins `CARD_PAYMENT_REQUEST_KEYS` and the event body.
- `resolvePayloadTime` also returns the parsed offset in minutes.
- The logged row's pair comes from `resolveRecordedZone`:
  - `explicitZone` is the request's `timeZone`;
  - `offsetMinutes` comes from the ISO;
  - `candidateZone` is `getUserTimeZone`.
- A blank time (the receive time) uses the request zone, else the setting.
- The shortcut adds a `Format Date` step with Custom format `VV` (Apple's date formatter prints the IANA ID) and sends it as `timeZone`. Whether this works is checked on a device (Post-Completion). Without it the offset alone is stored.
- In the notification path, `bankWallClock` is first read in the request zone (`wallClockToInstant`) and accepted when it lies within `inferBankTime`'s residual of the request time. Otherwise the existing inference runs.

**Imports:**

- The anchor zone is the request's `timezone` when sent, else `getUserTimeZone`.
- The frontend sends the viewing zone instead of the raw device zone.
- Each created row gets `resolveRecordedZone({ explicitZone: undefined, offsetMinutes: <cell offset if any>, candidateZone: anchorZone })`. A cell with an offset of its own keeps that offset, and the zone too when it matches.
- MS Money, Budget Bakers and YNAB (no zone in the file, values parsed as UTC) store `null`.

**Bank syncs** (owner's decision):

- No provider gives a zone. A payment synced soon after it happened most likely happened where the user is now, so a recent row records the user's setting zone at sync time.
- The rule, one helper for all five providers: `bankSyncRecordedZone({ time, syncedAt, userZone })` in `services/bank-data-providers/utils/recorded-zone.ts`.
  - When `|syncedAt − time| ≤ BANK_SYNC_RECENT_ZONE_WINDOW_DAYS` (3 days, one exported constant in that file), the row gets `timeZone = getUserTimeZone(...)` and the offset at its `time`.
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
- A user without a zone setting gets `UTC` stamped, which is what they see today; the frontend writes a real zone on the first app open, so this only affects syncs before that.
- Enable Banking's and LunchFlow's date-only times at UTC midnight are a separate bug; see the Decisions section.

**Reports:**

- `from`/`to` (`YYYY-MM-DD`) become instants at the start of `from` and the end of `to` **in the user's zone**: `zonedDayStart({ date, zone })`.
- Period buckets use date-fns v4 with `@date-fns/tz` (`startOfDay(d, { in: tz(zone) })`, likewise for week, month, quarter and year).
- Budget SQL takes `AT TIME ZONE :zone`.
- Sites:
  - `stats/stats-transactions.ts` `windowWhere`;
  - `stats/utils/index.ts` (`getWhereConditionForTime`, `generatePeriodBuckets`, `findBucketIndex`);
  - `stats/get-pivot/buckets.ts`, `stats/get-spendings-by-categories`, `stats/get-cash-flow.ts`;
  - `trackers/spending-stats.ts`;
  - `budget-plans/activity/get-plan-activity.ts`, `budget-plans/date-ranges.ts`.
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

- Create: `packages/shared/src/time-zone/{index,zone-offset,wall-clock,recorded-zone,format-offset}.ts`
- Modify: `packages/shared/src/types/user-settings.ts` (`TIME_ZONE_SOURCES`, `HOUR_CYCLES`, `TRANSACTION_OPTIONAL_FIELDS` += `timeZone`), `packages/shared/src/types/transactions/transactions.ts` (`TransactionModel.timeZone`, `utcOffsetMinutes`; `CreateTransactionBody` / update body `timeZone?`), `packages/shared/src/types/ingest/index.ts` (`timeZone` request key)
- Modify: `packages/backend/src/services/import-export/core/parse/anchor-import-date.ts` (import the moved helpers)
- Create: `packages/backend/src/services/import-export/core/parse/time-zone-helpers.unit.ts`

- [ ] write failing unit tests:
  - `isValidTimeZone`: `Asia/Tbilisi`, `Europe/Kiev`, `UTC` pass; `+04:00`, `Mars/Base`, `''` fail;
  - `zoneOffsetMinutes`: Kathmandu +345; New York -300 / -240 around both 2026 DST switches;
  - `wallClockToInstant`: spring-forward gap resolves forward, fall-back overlap takes the earlier instant, Kiritimati +14;
  - `resolveRecordedZone`, each branch (explicit zone; offset matching the candidate; offset not matching; nothing);
  - `formatOffset` for ±, zero and 45-minute offsets;
  - `anchor-import-date.unit.ts` still passes unchanged
- [ ] implement the helpers with `Intl.DateTimeFormat` only; move the wall-clock code out of `anchor-import-date.ts`
- [ ] add the shared constants and fields; `typecheck` stays green (frontend and backend compile with the new optional fields)
- [ ] gate: unit `--testPathPattern='import-export/core/parse/(anchor-import-date|time-zone-helpers)'`; root `typecheck`

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
- [ ] implement the keys in `ZodSettingsSchema` and `ZodSettingsPatchSchema` (the `SettingsPatchSchemaIsInSync` guard must stay green), and `getUserTimeZone`
- [ ] gate: unit `--testPathPattern='(zod/custom-types|mcp/tools/(notification-settings|time-zone-settings)-tools)'`; e2e `--testPathPattern='user-settings/patch-settings.e2e'`

### Task 3: Transaction columns and the REST create/update contract

**Files:**

- Create: `packages/backend/src/migrations/20261021000000-add-time-zone-to-transactions.ts`
- Modify: `packages/backend/src/models/transactions.model.ts`, `packages/backend/src/serializers/transactions.serializer.ts`, `packages/backend/src/controllers/transactions.controller/{create-transaction,update-transaction}.ts`, `packages/backend/src/services/transactions/{create-transaction,types}.ts`, `packages/backend/src/services/transactions/update-transaction/update-transaction.ts`, `packages/backend/src/services/mcp/serializers.ts` (output fields)
- Create: `packages/backend/src/services/transactions/time-zone.e2e.ts`

- [ ] write failing e2e:
  - create with `timeZone: 'America/New_York'` returns the zone and `utcOffsetMinutes: -240` (a summer instant);
  - create without `timeZone` returns `null`/`null`;
  - a transfer's two legs carry the same pair;
  - updating `time` into winter recomputes `-300`;
  - updating `timeZone: null` clears both;
  - updating `timeZone` on a bank-synced row (helper-made external account) succeeds while `time` stays refused;
  - an invalid zone → 422;
  - `GET /transactions` and the by-id route return both fields
- [ ] implement the migration (both columns, CHECK on the offset range, `down` removes them), the model fields, `createTransaction` / `updateTransaction` params and derivation, and the opposite-leg copy (`create-transaction.ts:325-333`) plus its update twin
- [ ] gate: e2e `--testPathPattern='transactions/(time-zone|get-by-id|get-transactions)\.e2e'`

### Task 4: Tool time input for MCP and the chat cards

**Files:**

- Create: `packages/backend/src/common/lib/time-zones/resolve-time-input.ts`, `.unit.ts`
- Modify: `packages/backend/src/services/mcp/tools/{create-transaction,update-transaction,adjust-account-balance,confirm-planned-transaction,pay-subscription-period,search-transactions,transaction-filter-input}.ts`, `packages/backend/src/services/mcp/tool-arg-validators.ts`, `packages/backend/src/services/mcp/prompts/financial-data-guide.ts`
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
  - each tool's `validate…Args` refuses a bad zone;
  - `normalizeTimeArgs` rewrites only the known time keys of the transaction tools
- [ ] write failing e2e: MCP `create_transaction` with `time: '2026-10-21T16:00'` for a user with `timeZone: 'Asia/Tbilisi'` stores `12:00Z` and the zone; a chat card for the same call stores `time` as `12:00:00.000Z` with `timeZone`, and approving it creates that row
- [ ] implement:
  - the resolver;
  - the tools take `time` and `timeZone` through it (the handlers pass `{ timeZone, utcOffsetMinutes }` on);
  - `adjust_account_balance` stops requiring `Z`;
  - the descriptions as in Technical Details;
  - the proposal normalizer;
  - the guide paragraph on zones
- [ ] update the agent SKILL.md text on times and its sha256 (the `add-mcp-tool` skill's drift checklist)
- [ ] gate: unit `--testPathPattern='(time-zones/resolve-time-input|mcp/tools/.*|mcp/(agent-skills|server-card|tool-arg-validators)-drift|chat/proposals/normalize-time-args)'`; e2e `--testPathPattern='(mcp/tool-time-input|chat/proposals/(approve|time-args))\.e2e'`

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
- Modify: `packages/frontend/scripts/shortcuts/{build-payments-shortcut,build-card-payment-shortcut}.ts` + specs; regenerate `packages/frontend/public/shortcuts/*.plist` (unsigned; signing is Post-Completion)
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
- Modify: `packages/frontend/src/stores/{statement-parser,import-export}.ts`, `packages/frontend/src/api/import-ofx.ts` (send `viewingTimeZone`) + `import-export.test.ts`
- Create: `packages/backend/src/services/bank-data-providers/utils/recorded-zone.ts`, `.unit.ts`
- Modify: the five provider create sites listed in Technical Details → Bank syncs
- Modify: `detect-duplicates.e2e.ts`, `statement-parser/execute-import.e2e.ts`, `ai-extraction.e2e.ts`, `backup/restore/restore-backup.e2e.ts`, `data-export/export-data.e2e.ts`, one bank sync e2e (`bank-data-providers/connection/transaction-sync.e2e.ts`)

- [ ] write failing e2e:
  - a CSV row `2026-06-01 23:30` imported with `timezone: 'America/Montevideo'` stores that zone and -180;
  - the same import **without** `timezone` for a user whose setting is Montevideo anchors in Montevideo (today: UTC);
  - a statement import stamps the zone;
  - the statement AI's "today" uses the setting when the request has none;
  - a Tbilisi user's bank sync: a row dated 1 day before the sync gets `Asia/Tbilisi` and +240; a row dated 90 days back stays `null`/`null`; a user with no setting gets `UTC` on the recent row;
  - backup → restore keeps both columns, and restoring a fixture archive without the columns gives `null`;
  - data export adds `timeZone` and `localTime` (ISO with the row's offset, or the user's zone when `null`) and leaves `date`/`time` as they are
- [ ] write failing unit tests for `bankSyncRecordedZone`: exactly 3 days → stamped; 3 days and 1 second → `null`; a future-dated row within the window → stamped
- [ ] implement; frontend stores send the viewing zone (vitest updates the two existing expectations)
- [ ] gate: e2e `--testPathPattern='(import-export/(csv-import/detect-duplicates|statement-parser/(execute-import|ai-extraction))|backup/restore/restore-backup|data-export/export-data|bank-data-providers/connection/transaction-sync)\.e2e'`; unit `--testPathPattern='bank-data-providers/utils/recorded-zone'`; frontend `src/stores/import-export.test.ts`

### Task 8: Report day bucketing in the user's zone

**Files:**

- Modify: `packages/backend/package.json` (`@date-fns/tz`, pinned)
- Create: `packages/backend/src/common/lib/time-zones/zoned-days.ts`, `.unit.ts` (`zonedDayStart`, `zonedDayEnd`, `tzOptions({ zone })`)
- Modify: `packages/backend/src/services/stats/{stats-transactions,utils/index,get-cash-flow,get-expenses-history,get-cumulative-data}.ts`, `stats/get-pivot/buckets.ts`, `stats/get-spendings-by-categories/index.ts`, `services/trackers/spending-stats.ts`, `services/budget-plans/{activity/get-plan-activity,date-ranges}.ts` (thread `zone` from `getUserTimeZone`)
- Create: `packages/backend/src/services/stats/time-zone-buckets.e2e.ts`, `packages/backend/src/services/budget-plans/time-zone-activity.e2e.ts`

- [ ] write failing unit tests:
  - `zonedDayStart('2026-10-21', 'Asia/Tbilisi')` = `2026-10-20T20:00Z`;
  - Kiritimati, Pago Pago, a DST day in New York (23 and 25-hour days);
  - month buckets for Tbilisi start at local midnight
- [ ] write failing e2e:
  - a Tbilisi user's expense at `2026-10-20T21:30Z` (01:30 local on the 21st) counts on Oct 21 in cash flow (daily), spending-by-categories for `from=to=2026-10-21`, pivot by day, tracker spending, and the October budget period when it is the first day;
  - a New York user's `2026-11-01T03:30Z` counts on Oct 31;
  - a user without a zone keeps today's results (re-run the existing stats e2e unchanged)
- [ ] implement with `{ in: tz(zone) }` on the date-fns calls and `AT TIME ZONE :zone` in the budget SQL; `Balances` untouched (comment why)
- [ ] gate: unit `--testPathPattern='(time-zones/zoned-days|stats/utils)'`; e2e `--testPathPattern='(stats/(time-zone-buckets|get-cash-flow|get-pivot|get-cumulative-data)|budget-plans/time-zone-activity|trackers/spending-stats)\.e2e'`

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
- Modify: `packages/frontend/src/components/chat/visuals/format-visual-value.ts`, `packages/frontend/src/pages/settings/subpages/ai/pages/chat-applied-changes.vue`, `packages/frontend/src/pages/accounts/integrations/ios-automation/components/{payment-request-summary,unconfirmed-payments}.vue`, `packages/frontend/src/pages/optimizations/reconciliation/components/merge-dialog.vue`, `packages/frontend/src/pages/settings/subpages/general/rows/transaction-rows.vue` (the new optional field's label)
- Specs beside each changed util; i18n `en` + `uk`

- [ ] write failing vitest:
  - `date-field` with `timeZone: 'Asia/Tbilisi'` shows `2026-10-21 16:00` for `12:00Z` and emits `12:00Z` back when 16:00 is typed;
  - `prepareTxCreationParams` sends `timeZone`;
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
  - a transfer selected by one leg gets the zone on both legs;
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

- Modify: `packages/frontend/src/components/records-filters/use-filters-from-query.ts`, `packages/frontend/src/api/stats.ts` (`formatDate` in the viewing zone), the date-preset helpers (`components/lib/ui/date-selector`, `TRANSACTION_DATE_PRESETS` consumers), `components/widgets/{spending-pace-widget/index.vue,balance-trend.vue,latest-records.vue}`
- Specs beside each

- [ ] write failing vitest: "today" for a Tbilisi viewer at `2026-10-20T21:30Z` is Oct 21; the end bound of `end=2026-10-21` is `2026-10-21T19:59:59.999Z` in Tbilisi; `api/stats` sends the viewing-zone calendar day
- [ ] implement with `tz(viewingTimeZone)`
- [ ] gate: frontend the changed spec files

### Task 14: Verify acceptance criteria

- [ ] the Haiku scenario end to end against a mocked model: a Tbilisi user says "coffee 5 GEL at 16:00"; the model calls `create_transaction` with `time: '<today>T16:00'`; the card shows 16:00; approval stores `12:00Z`, `Asia/Tbilisi`, +240; the list tooltip shows 16:00 GMT+4
- [ ] the same chat after switching the setting to manual `Europe/Kyiv`: the list shows 15:00 GMT+3 and a second line "Recorded in Asia/Tbilisi: 16:00 GMT+4"
- [ ] a user without a zone sees no change in reports (the existing stats and budgets e2e suites pass untouched)
- [ ] Playwright flow from the Testing Strategy
- [ ] full backend unit suite, the e2e patterns of Tasks 2–8 and 12 in one serial run, the frontend suite, root `typecheck`, `lint`, `format:check`, `knip`

### Task 15: Documentation

- [ ] user docs (`packages/docs`, via `user-docs`): a "Time zone and clock" settings page; how each source records a zone; the note that balance history uses UTC days
- [ ] `packages/docs/.../integrations/ios-automation.mdx` and `packages/backend/docs/card-payment-ingest.md`: the `timeZone` key and the offset fallback
- [ ] MCP: the guide paragraph and SKILL.md (done in Task 4), checked against the final tool descriptions
- [ ] `.claude/docs/backend-conventions.md`: a short "Times and zones" section (instants in `time`, `resolveRecordedZone` for the zone, `getUserTimeZone` for day bounds, tools never take UTC-only input)
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
