# Payment ingest from iOS notifications, with AI parsing and dedup

## Overview

On iOS 27 and later, Shortcuts has a personal-automation trigger **"When I receive a notification from <app>"** (optional Title, Subtitle and Message filters). It lets MoneyMatter log payments that the Wallet **Transaction** automation never sees:

- **Apple Wallet notifications** cover Apple Pay inside apps and on websites, which today's tap automation misses (the Apple Pay page says so in its `limitation` callout).
- **Bank-app notifications** (TBC Bank for the owner, but any bank, any language) cover plain card payments, ATM withdrawals, transfers, refunds and incoming money.

The plan delivers:

1. **`POST /api/v1/ingest/notification`:** a dumb, flexible endpoint. The shortcut forwards the raw notification (app, title, subtitle, body, time, plus whatever else the trigger exposes) with the same ingest token and Cloudflare Access headers as the card-payment shortcut. The endpoint records the request and answers at once; a queued job does the work.
2. **Server-side parsing:** a deterministic parser for Wallet's fixed layout, and an AI parser (new AI feature `notificationParsing`, reusing the AI connections, feature config and model choice) for everything else. Each notification is classified; only real money movements are logged.
3. **Account resolution:** the Wallet card name or the card's last digits through the existing card links, else a per-app default account, else the request is parked for the user to link (never guessed).
4. **Dedup across sources:** one payment can arrive up to three times (tap automation, Wallet notification, bank notification), minutes to hours apart, spelled differently, and later again from bank sync or a statement import.
   - A deterministic **twin check** at ingest attaches a later source to the row that already exists and enriches it, without creating a second row.
   - Ambiguous cases go to an **AI duplicate judge** (new AI feature `duplicateMatching`). A high-confidence match between ingest rows merges through the existing **Reconciliation** merge (recorded in its history, restorable). Anything less certain becomes a **suggestion** in a new Reconciliation tab for the user to merge or dismiss.
5. **Setup UI** on the existing Apple Pay page (Accounts → Apple Pay): iOS 27+ users are guided to set up both the tap automation and notification automations (Wallet + each bank app); older iOS keeps the tap automation only.
6. **A second signed shortcut**, "MoneyMatter: log notification", built late because it depends on what the iOS 27 trigger exposes.
7. **Docs.**

Out of scope: Android notification listeners, SMS ingest, own-account transfer pairing (see Decisions), balance-drift alerts from the notification balance (stored only), and changes to the planned-row settlement rules of the Apple Pay plan.

Work happens in the fork on `feat/notification-ingest` (from `dev`), generic names only, nothing owner-specific, so it can be offered upstream after the Apple Pay ingest.

## Context (from discovery)

- **Ingest pipeline** (`packages/backend/src/services/ingest/card-payment/`, plan `docs/plans/completed/20261017-apple-pay-ingest.md`):
  - Route `routes/ingest.route.ts`: `authenticateIngestToken({ scope: INGEST_SCOPES.transactions })` → `checkBaseCurrencyLock` → `ingestTokenRateLimit` → `controllers/ingest/card-payment.controller.ts`.
  - `ingest-card-payment.ts` → tx 1 `record-request.ts` (`IngestRequests`, unique `(userId, idempotencyKey)`), tx 2 `process-ingest-request.ts` (row lock, `findOriginalInWindow` repeat window keyed by `fingerprint.ts`'s `computeFingerprint`, 120 s, under `pg_advisory_xact_lock`), tx 3 `park-failed-request.ts`.
  - `process-card-payment.ts` does mapping → currency (`resolve-currency.ts`, `parse-amount.ts`) → conversion (`convert-to-account-currency.ts`) → payee (`resolvePayeeForIncomingRow`, threshold 1) → history category → `createTransaction` (planned on bank-connected accounts) with `externalData.cardPayment`.
  - Shared types in `packages/shared/src/types/ingest/` (`INGEST_REQUEST_STATUSES`, `CARD_PAYMENT_PARK_REASONS`, `CARD_PAYMENT_REJECTION_REASONS`, `IngestRequestReason`, DTOs, `normalizeCardLabel`).
  - Card links: `CardAccountMappings` (`cardLabel`, `normalizedLabel`, `accountId`), service `services/ingest/card-mappings.service.ts`.
  - Migration `20261017020000-card-payment-ingest.ts` is already on `dev`, so this branch adds a new one (repo rule 11).
- **Reconciliation** (`services/transactions/reconciliation/`, routes `/transactions/reconciliation/*` in `routes/transactions.route.ts`, controller `controllers/transactions.controller/reconciliation.ts`):
  - `mergeTransactions({ userId, transactionIds, survivorId })` moves tracker, group, subscription and period links to the survivor, then `softDeleteTransactions` sets `deletedAt` + `mergedIntoId`. `removeTransactions`, `restoreTransactions`, `getReconciliationHistory` (removed rows grouped by `deletedAt`, `type: merge | remove`).
  - `loadReconcilableRows` **rejects system rows (manual accounts) and planned rows** (`transactions.reconciliation.systemNotAllowed` / `plannedNotAllowed`). `softDeleteTransactions` runs with hooks off because "provider balances are bank-authoritative": on a manual account, hiding a row would leave its amount in the balance (`Transactions` `@BeforeDestroy` calls `updateAccountBalanceForChangedTx` + `Balances.handleTransactionChange` for `ACCOUNT_TYPES.system`).
  - No persisted suggestions: the Transactions tab is a filtered list where the user selects rows by hand. `stuck-pending.ts` + `match-stuck-pending.ts` compute EnableBanking candidates on the fly.
  - MCP tools: `merge-duplicate-transactions`, `remove-duplicate-transactions`, `keep-pending-as-booked`, `restore-removed-transactions`, `get-reconciliation-history`, `list-stuck-pending-transactions` (`services/mcp/tools/`, drift-checked by the `add-mcp-tool` skill's metafiles).
  - Frontend: `packages/frontend/src/pages/optimizations/reconciliation/` (tabs `transactions`, `stuck-pending`, `history`; `block-reasons.ts` mirrors the backend checks; `merge-dialog.vue`).
  - Edit-merge policy: `planEditMerge` in `services/bank-data-providers/enablebanking/utils/plan-edit-merge.ts` decides which user edits (note, category with manual stamp, payment type, payee) move to the survivor or block the merge.
- **Planned settlement:** `services/transactions/planned-matching/` (`findPlannedMatch`, `mergeIntoPlanned`, `isSameShop`, `hasMerchantAffinity`, `isWithinCardPaymentTolerance`, `generic-merchant-words.ts`). Every provider and import passes `matchPlanned`, so a booked row settles an ingest plan on a connected account.
- **Import duplicate check:** `services/transactions/duplicates-detection/detect-duplicates.service.ts` (date + amount) flags duplicates in the statement and CSV import previews.
- **AI infrastructure** (`services/ai/`):
  - `AI_FEATURE` enum in `packages/shared/src/types/ai/settings.ts`; per-feature defaults in `services/ai/resolution-ladder.ts`; frontend registry `packages/frontend/src/common/const/ai-features.ts` (name, description, model-guide keys); `ai-feature-settings.e2e.ts` and `ai-model-resolver.unit.ts` cover features; billing entitlement defaults to `operator_ai` (`getAiFeatureEntitlement`).
  - `createAIClient({ userId, feature })` returns `null` when nothing can answer. Calls use `generateText` with `Output.object({ schema })`, `aiCallGuards`, `AI_MAX_OUTPUT_TOKENS`, then `trackAiUsage`; `isWithinAiAllowance` gates operator-key use; `resolveAiExtractionFailure` classifies failures; `createShortIds` aliases ids in prompts. Template: `services/trackers/smart-tracking/run-tracker-scan.ts` (scored suggestions with auto-link and suggest thresholds, `TrackerSuggestions`).
  - E2E mocks AI over MSW: `createGeminiMock({ rawText })` (`tests/mocks/gemini/mock-api`), `getCustomEndpointContentMock` (`tests/mocks/openai-compatible/mock-api`).
  - Queues: BullMQ pattern in `services/ai-categorization/categorization-queue.ts`. Events: `DOMAIN_EVENTS.TRANSACTIONS_SYNCED` (`services/common/event-bus.ts`), emitted by providers.
- **Frontend setup UI:** `packages/frontend/src/pages/accounts/integrations/apple-pay/apple-pay-details.vue` (setup section, `setup-checklist.vue`, `add-shortcut-button.vue`, `card-links.vue`, `card-link-dialog.vue`, `unlinked-cards.vue`, `waiting-payments.vue`, `unconfirmed-payments.vue`, `ingest-devices.vue`); i18n chunk `settings/integrations.json` (`settings.integrations.applePay.*`).
- **Shortcut:** `packages/frontend/scripts/shortcuts/build-card-payment-shortcut.ts` (deterministic plist, `SHORTCUT_ACTIONS`/`SHORTCUT_PARAMS`, spec drift check, device-captured fixture `fixtures/transaction-input.xml`), signed `public/shortcuts/log-card-payment.shortcut`, `public/shortcuts/README.md`.
- **iOS facts:** what the Notification trigger hands the shortcut (property names, whether the app's bundle id and the notification date are available) is **not known** until the owner's phone runs iOS 27. One Wallet sample seen: title `TBC Bank` (the Wallet card name), subtitle `Wolt`, body `GEL 43.60`.

## Decisions

- **The shortcut stays dumb; the endpoint is asynchronous.**
  - It forwards raw fields and an idempotency key; the server parses. A change in a bank's wording needs no shortcut update.
  - The endpoint answers `202 queued` within milliseconds and a BullMQ job (`ingest-notification`) processes the request after a **15 s delay**. The delay lets the tap automation (synchronous, usually first) create the row, so the notification attaches to it deterministically instead of needing the AI judge. Retries with backoff absorb AI outages.
  - The notification shortcut shows **no notification of its own** by default (the bank already did, and three MoneyMatter banners per payment would be noise). The response carries `notify: false`; only a dry run sets it. A payment that needs the user (unknown account) raises one in-app notification per source app through `services/notifications`, not per request.
- **Classification and what gets logged** (AI output `kind`):
  - `debit` (card purchase, hold, ATM withdrawal, outgoing payment, fee) → **expense**.
  - `credit` (refund, reversal, cashback, incoming transfer, salary, top-up) → **income**. Incoming money is a real balance change, so it is logged, not ignored. A refund is a plain income row; linking it to the purchase stays a user action (existing refund linking).
  - `declined`, `security` (OTP, 3-D Secure code, login or device alerts), `promo`, `info` (statement ready, balance-only message), `other` → **ignored**: the request is stored as `ignored` with the kind as reason, nothing is logged. A declined card payment moved no money; an OTP is not a transaction.
  - **Own-account transfers** (`isOwnAccountTransfer: true`) are **parked** with reason `ownTransfer` and shown in the waiting list with **Log anyway** / **Dismiss**: logging one leg as expense or income would inflate both totals, and pairing legs into a transfer is out of scope.
  - Parse confidence below 0.6 on a `debit`/`credit` parks with `lowConfidence` (log or dismiss in the waiting list).
- **Privacy:** a `security` notification's title, subtitle and body are replaced by `[redacted]` in the stored payload as soon as it is classified, and `ignored` requests are deleted after 7 days instead of 90. A notification with no digit at all is ignored before any AI call (`notTransaction`). The docs suggest the trigger's Message filter (for example "contains GEL") where a bank's wording allows it.
- **Deterministic Wallet parser first, AI second.** A notification from Wallet (bundle `com.apple.Passbook`, or an app name in a small localized list) whose body is nothing but an amount `parseAmount` accepts is a `debit`: card = title, merchant = subtitle. No AI call, so Wallet works even with no AI configured. Any other Wallet text (refunds, Apple Cash) and every bank notification go to the AI parser. Without an AI client, they park as `aiUnavailable` and are retried from the waiting list once AI is set up.
- **Two AI features, not one:** `notificationParsing` (multilingual extraction, high volume, cheap fast default) and `duplicateMatching` (comparison, low volume). Separate entries keep the model choice and usage tracking per job, as every existing feature does.
- **Account resolution, in order; an AI guess never logs:**
  1. The card name the parser found (Wallet title) → `CardAccountMappings` by `normalizeCardLabel`, the same links the tap automation uses.
  2. The card's last digits (`*1234`, `карта ...1234`) → a new optional `lastDigits` on `CardAccountMappings`, unique per user, so one link covers the Wallet name and the bank's digits.
  3. The source app's default account (`NotificationSources.defaultAccountId`), for banks that print no card at all.
  4. Else park `unknownAccount`. The link dialog is pre-filled with a heuristic guess (accounts whose currency matches and whose name shares a token with the app name). A wrong account silently corrupts a balance; the first payment per card or app costs one click, every later one is automatic.
- **Dedup is two-tier, and every tier reuses existing state:**
  - **Source slots.** Each request fills a slot on the row it logs or attaches to: `tap` (the card-payment endpoint), `wallet-notification`, `bank-notification:<app>:<stage>` (`stage` = `authorization` | `settlement` | `unknown`, from the parser, because some banks notify again when the payment settles). A row holds at most one request per slot. This is what tells two identical coffees apart: the second tap cannot attach to a row whose `tap` slot is taken.
  - **Tier 1, deterministic twin (at ingest, both endpoints):** under a per-user advisory lock, a candidate on the same account and direction, with a free slot, the exact amount in the same currency (or the same original amount and currency), within 30 minutes, and no `isSameShop` veto. Exactly one such candidate → **attach**: no new row, the request is `logged` with that `transactionId` and `matchedBy: 'twin'`, and the row is enriched. The tap endpoint runs the same check, so the order of arrival does not matter.
  - **Tier 2, AI judge (notification job, and a scan job after ingest, bank sync and statement import):** candidates within ±25 % or the same original amount, up to 72 h apart, where at least one side came from ingest. The judge returns `{ matchId, confidence, reason }`.
    - In the notification job before logging: confidence ≥ 0.9 → attach as in tier 1 (`matchedBy: 'ai'`); 0.6–0.9 → log a new row and store a **suggestion**; below → log a new row.
    - In the scan job, both rows already exist: ≥ 0.9 and both rows are ingest rows (or an ingest plan and a booked bank row) → **auto-merge** through `mergeTransactions`, which writes the Reconciliation history entry and stays restorable; otherwise a suggestion. Rows the user typed or imported are never auto-merged.
  - **Suggestions are persisted** (`DuplicateSuggestions`): a dismissed pair never comes back, and the Reconciliation page lists open ones with confidence and reason. Merging a suggestion reuses `mergeTransactions` and its history; there is no second merge path.
- **Enrichment when a source attaches or a merge happens:**
  - The bank's account-currency amount is authoritative: a tap or Wallet row in USD (converted at the day's rate) takes the bank's GEL figure, keeping the USD as `originalAmount`/`originalCurrencyCode`. The update goes through `updateTransaction`, so the manual account's balance follows.
  - A missing payee is resolved from the new merchant; when a payee exists, the other spelling becomes its alias (`ensureAliasExists`), skipped when the text resolves to another payee, as the planned merge does.
  - `externalData.ingest = { sources: [{ slot, requestId, receivedAt, merchant }], balanceAfter? }` records every source and the bank's balance after the payment (stored and shown, not acted on).
  - User edits are never overwritten: on merge, `planEditMerge` decides which edits move to the survivor and a conflict blocks the auto-merge (the pair becomes a suggestion).
- **Reconciliation widens to manual accounts and ingest plans**, because notification rows on a manual account are system rows and on a connected account are plans:
  - System rows become reconcilable. Their soft delete withdraws the amount from the balance and `Balances` (what `@BeforeDestroy` does), and restore puts it back. Bank rows keep today's no-balance behavior.
  - A planned row is reconcilable only when it is an ingest plan (`externalData.cardPayment` or `externalData.ingest`), and it can never be the survivor of a merge that includes a booked row. Planned rows move no balance.
  - Survivor choice for auto-merges and the suggested survivor in the dialog: a booked bank or imported row, else the earliest ingest row.
- **Requests share `IngestRequests`.** `source` tells card-payment and notification requests apart. New status `ignored`; new reasons; the parse result is stored in a new `parsed` JSONB column, so a retry never calls the AI twice and the UI can show what was read. A notification request stays `received` while its job is pending; it counts as interrupted only after 30 minutes (the card-payment threshold of 1 minute stays).
- **The notification URL is derived, not a new setup-code field.** The notification shortcut replaces the last path segment of the setup code's `url` (`card-payment`) with `notification`, so existing setup codes and tokens keep working and one code serves both shortcuts.

## Development Approach

- **Testing approach: TDD.** Each task first writes its failing tests (unit, or e2e through HTTP helpers), runs them and records that they fail on assertions, not setup. AI calls are mocked over MSW (`createGeminiMock`, `getCustomEndpointContentMock`) in e2e and by `jest.mock('ai')` in unit tests, as existing AI specs do.
- **Prefix every node/npm command** with `export PATH="$(mise where node@24.21.0)/bin:$PATH"`.
- **Commands:**
  - Backend unit: `cd packages/backend && npm run test:unit -- --testPathPattern='<regex>'`.
  - Backend e2e, never in parallel: `cd packages/backend && lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='<regex>'`.
  - Frontend: `cd packages/frontend && npm run test:unit -- --run <path>`.
  - Root: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run knip`.
- Tests through the `test-runner` subagent, lint through `linter`, i18n through `i18n-editor` (`en` + `uk` together), MCP tools through the `add-mcp-tool` skill.
- Complete each task before the next; every gate names its tests. Repo rules apply: object params, kebab-case files, comments describe current code, `Money` everywhere, one migration for this branch amended rather than duplicated.
- **Commits:** none by implementing agents unless the owner asks (repo CLAUDE.md rule 10).

## Testing Strategy

- **Unit:** payload normalization (aliases, size limits, `raw` passthrough); notification fingerprint; Wallet deterministic parser (localized app names, amount-only body, rejects other text); AI parse output validation (amount, currency, kind mapping, confidence floor, redaction); account resolution order; slot computation; twin rule (exact amount, original amount, window, slot taken, `isSameShop` veto, ambiguity); judge prompt building and output mapping; survivor choice; enrichment planner.
- **E2E (HTTP only):**
  - endpoint: auth, dry run, idempotent replay, body limit, validation, `202 queued`;
  - processing: Wallet notification logged without AI; bank debit and credit via mocked AI; OTP, promo and decline ignored and OTP redacted; no AI client → `aiUnavailable`, then retry; own transfer and low confidence parked; unknown account parked, then logged after linking by digits or app default;
  - dedup permutations: tap → Wallet → bank, bank → tap, Wallet → tap, two identical coffees, FX payment where the bank amount replaces the converted one, settlement notification attaching to the authorization row;
  - AI judge: attach, suggestion, no match; scan job after `TRANSACTIONS_SYNCED` and statement import;
  - reconciliation: merge and remove on a manual account move the balance and restore reverses it; ingest plan merged into a booked row; non-ingest plan still rejected; suggestions list, dismiss, merge; history shows the auto-merge reason;
  - settings: notification sources CRUD, `lastDigits` on card links; base-currency guard coverage.
- **Frontend vitest:** Suggestions tab, block reasons, notification sources list, last-digits field, iOS-version guidance, request rows for notification kinds.
- **Playwright:** merge a suggestion from the Reconciliation page; link a parked notification by last digits.
- **Manual on the device** (Post-Completion): capture the trigger's input, sample notifications from Wallet and TBC, end-to-end with all three sources.

## Progress Tracking

- Mark completed items `[x]` immediately; prefix newly discovered tasks with ➕ and blockers with ⚠️.
- After each gate passes, note the command and its result under the task.

## Solution Overview

```
Bank/Wallet notification → iOS 27 Notification automation → shortcut "MoneyMatter: log notification"
  → decode setup code, url := url with last segment → "notification"
  → POST {app, bundleId?, title, subtitle, body, time?, raw?, idempotencyKey}  (Bearer + CF Access headers)
→ authenticateIngestToken → checkBaseCurrencyLock → ingestTokenRateLimit → notification controller
→ tx 1: IngestRequests row (source "notification", status received) → enqueue job (delay 15 s) → 202 {queued}

ingest-notification job:
  replay/repeat checks (key, fingerprint window 10 min)
  → parse: no digit → ignored | Wallet layout → debit | else AI (notificationParsing) → `parsed`
  → ignore / redact / park (ownTransfer, lowConfidence, aiUnavailable)
  → resolve account: card name → last digits → app default → park unknownAccount
  → tx: advisory lock (user) → tier-1 twin → attach + enrich
        | tier-2 AI judge (duplicateMatching) → attach (≥0.9) | log + suggestion (0.6–0.9) | log
  → logIngestedPayment (shared with the card-payment path) → request logged

card-payment endpoint (tap): unchanged flow + the same locked tier-1 twin check before createTransaction,
  and a scan job enqueued when an ambiguous candidate exists.

duplicate-scan job (after ambiguous ingest, TRANSACTIONS_SYNCED, statement import):
  candidates → AI judge → auto-merge via mergeTransactions (ingest rows only) | DuplicateSuggestions row
Reconciliation page → Suggestions tab → Merge (existing merge dialog) | Not duplicates (dismiss)
```

- **Data** (one migration, `migrations/20261020120000-notification-ingest.ts`):
  - `IngestRequests` + `parsed` (JSONB, null), `sourceApp` (varchar 100, null); `status` gains `ignored`.
  - `CardAccountMappings` + `lastDigits` (varchar 4, null), partial unique `(userId, lastDigits) WHERE lastDigits IS NOT NULL`.
  - `NotificationSources`: `id`, `userId` (FK cascade), `sourceKey` (normalized bundle id, else app name), `displayName`, `defaultAccountId` (FK `Accounts`, set null), `muted` (bool, default false: requests from it are stored as `ignored`/`muted` without parsing), `lastSeenAt`, timestamps; unique `(userId, sourceKey)`. Created on first sight. Backed up (settings).
  - `DuplicateSuggestions`: `id`, `userId`, `accountId`, `transactionId`, `candidateId` (both FK `Transactions`, cascade), `confidence` (float), `reason` (text), `trigger` (`ingest` | `sync` | `import`), `status` (`open` | `merged` | `autoMerged` | `dismissed` | `stale`), `resolvedAt`, timestamps; unique on the ordered pair `(userId, LEAST(id1,id2), GREATEST(id1,id2))`. Backed up (dismissals must survive a restore). Deleted by `wipe-user-data.service.ts` with the user's transactions.
- **Services** (`packages/backend/src/services/ingest/`):
  - `notification/`: `parse-notification-payload.ts`, `notification-fingerprint.ts`, `ingest-notification.ts` (tx 1 + enqueue), `notification-queue.ts`, `process-notification.ts`, `parse-wallet-notification.ts`, `parse-notification-with-ai.ts` (+ `notification-prompt.ts`), `resolve-notification-account.ts`, `notification-sources.service.ts`.
  - `log-ingested-payment.ts`: the account-currency conversion, payee, history category and `createTransaction` part of `process-card-payment.ts`, extracted and generalized to direction, slot and source-specific `externalData`; `process-card-payment.ts` calls it.
  - `dedup/`: `source-slots.ts`, `find-twin.ts`, `enrich-twin.ts`, `judge-duplicates.ts` (+ prompt), `duplicate-scan-queue.ts`, `choose-survivor.ts`.
- **Reconciliation** (`services/transactions/reconciliation/`): `helpers.ts` (reconcilable rows, balance-aware soft delete), `restore-transactions.ts`, `merge-transactions.ts` (survivor rules, `planEditMerge` enrichment), new `duplicate-suggestions.ts` (list, dismiss, mark merged, stale on delete), `get-history.ts` (suggestion reason on auto-merges).

## Technical Details

- **Request body** (`POST /api/v1/ingest/notification`, JSON, limit 16 KB via a `largePaths` entry in `setup-middleware.ts`; unknown keys ignored):
  - `idempotencyKey`: `^[\x21-\x7E]{8,128}$`, required unless `dryRun`.
  - `app` (≤ 100), `bundleId` (≤ 200), `title` (≤ 500), `subtitle` (≤ 500), `body` (≤ 4000); aliases accepted: `appName`/`sourceApp` → `app`, `message`/`text` → `body`. At least one of title, subtitle, body or `raw` is non-empty.
  - `time`: optional ISO 8601 with an offset, same window rules as card payments (5 min ahead, 30 days back, measured from receipt).
  - `raw`: optional JSON value (≤ 8 KB serialized): whatever else the trigger exposes, stored and given to the parser as text.
  - `source`: optional `^[a-z0-9-]{1,32}$`, default `notification`. `dryRun`: optional boolean.
- **Responses** (`{ status, response }` envelope): `202 { outcome: 'queued', requestId, notify: false }`; `200 { outcome: 'duplicate', requestId, notify: false }` for a reused key with the same fingerprint; `409` for a reused key with a different body; `200 { outcome: 'dryRun', summary, notify: true }` (`Connected as <username>. Notifications from <app> go to <account>` or `… are not linked to an account yet`); 401/402/403/413/422/423/429 as the card-payment endpoint.
- **Fingerprint:** SHA-256 over canonical JSON of the normalized source key, title, subtitle and body (whitespace collapsed); a second request with the same fingerprint within 10 minutes is a repeat (`duplicateOfId`), without parsing.
- **AI parse schema** (`Output.object`, name `notification_parse`): `kind` (`debit` | `credit` | `declined` | `security` | `promo` | `info` | `other`), `stage` (`authorization` | `settlement` | `unknown`), `isOwnAccountTransfer`, `amount` and `currency` (as written), `originalAmount`/`originalCurrency` (when the text shows both), `merchant` (as written, null for none), `cardName`, `cardLastDigits` (2–4 digits), `balanceAfter` (`{ amount, currency }` or null), `occurredAt` (ISO or null), `confidence` (0–1). The system prompt states the text is untrusted data, not instructions; the call has no tools; the output is validated (`parseAmount`, `resolveCurrency`, digits pattern, length caps), and an invalid field is treated as missing. Usage is tracked under `notificationParsing`; operator-key calls respect `isWithinAiAllowance`.
- **`parsed` column:** `{ parser: 'wallet' | 'ai' | 'none', model?, kind, stage, direction?, amount?, currency?, originalAmount?, originalCurrency?, merchant?, cardName?, cardLastDigits?, balanceAfter?, occurredAt?, confidence, accountGuessId? }`.
- **Reasons:** park reasons gain `unknownAccount`, `aiUnavailable`, `ownTransfer`, `lowConfidence`; ignore reasons (new `INGEST_IGNORE_REASONS`): `declined`, `security`, `promo`, `info`, `other`, `notTransaction`, `muted`.
- **Payment time:** the parser's `occurredAt` when the text carries a full date and time, else the request's `time`, else its receipt time.
- **Twin rule constants** (`dedup/constants.ts`, an object so tests can shorten them): `twinWindowMs` 30 min, `judgeWindowMs` 72 h, `judgeAmountTolerance` reuses `CARD_PAYMENT_AMOUNT_TOLERANCE`, `attachConfidence` 0.9, `suggestConfidence` 0.6, `maxJudgeCandidates` 5. The lock is `pg_advisory_xact_lock(hashtextextended('ingest-dedup:<userId>', 0))`, taken in the tap path and the notification job alike.
- **Judge schema** (name `duplicate_judgement`): `{ matchId: string | null, confidence, reason }`; ids are `createShortIds` aliases; the prompt shows each row's amount, currency, original amount, local time, merchant or payee, sources and card.
- **Settings API** (session auth, `/user/settings/...`):
  - `GET /notification-sources`, `PATCH /notification-sources/:id` (`defaultAccountId`, `muted`), `DELETE /notification-sources/:id`.
  - `card-mappings` create/patch accept `lastDigits`.
  - `card-payments/requests` lists notification requests too (`source` filter); retry works for the new park reasons; `ownTransfer`/`lowConfidence` retry takes `{ force: true }` to log as parsed.
- **Reconciliation API** (`/transactions/reconciliation/...`): `GET /suggestions` (open, with both rows serialized and the suggested survivor), `POST /suggestions/:id/dismiss`. `POST /merge` with both ids marks the matching suggestion `merged`. Deleting a transaction marks its open suggestions `stale`.
- **MCP:** `list-duplicate-suggestions` and `dismiss-duplicate-suggestion` tools; the existing merge tool marks suggestions as the HTTP merge does.
- **Guard classification:** `POST /ingest/notification`, `POST /reconciliation/suggestions/:id/dismiss` carry `checkBaseCurrencyLock` (the first writes transactions); the notification-source `PATCH`/`DELETE` go to `GUARD_EXEMPT_ROUTES` (settings, no money).
- **Retention:** the existing `ingest-requests-cleanup` cron deletes `ignored` requests after 7 days, and `merged`/`autoMerged`/`stale` suggestions after 90 days; `dismissed` stay.

## What Goes Where

- **Implementation Steps:** backend schema, endpoint, parsing, dedup, reconciliation, settings API and tests; frontend Reconciliation and Apple Pay page; notification shortcut generator (after device capture); docs.
- **Post-Completion:** device capture and samples, signing the shortcut, Cloudflare Access path, deployment, upstream.

## Implementation Steps

### Task 1: Schema and shared types

**Files:**

- Create: `packages/backend/src/migrations/20261020120000-notification-ingest.ts`
- Create: `packages/backend/src/models/{notification-sources,duplicate-suggestions}.model.ts`
- Modify: `packages/backend/src/models/{ingest-requests,card-account-mappings}.model.ts`
- Modify: `packages/shared/src/types/ingest/index.ts` (statuses, reasons, `NotificationIngestResponse`, `NotificationSourceDto`, `lastDigits` on `CardMappingDto`), new `packages/shared/src/types/reconciliation-suggestions.ts` (or the file holding `ReconciliationHistoryEvent`)
- Modify: `packages/backend/src/services/backup/registry.ts`, `packages/backend/src/services/user/wipe-user-data.service.ts`

- [ ] write failing tests: `registry.unit.ts` drift guard lists the two new models; a restore round-trip e2e keeps a `NotificationSources` row and a dismissed `DuplicateSuggestions` row (`backup/restore/restore-backup.e2e.ts`)
- [ ] migration: the columns and tables in Solution Overview → Data, with the partial unique index and the ordered-pair unique index; `down` reverses it
- [ ] models with object-param statics; `IngestRequests.status` accepts `ignored`
- [ ] shared types and constants; `IngestRequestReason` includes the new park and ignore reasons
- [ ] backup registry entries with reasons; wipe deletes both new tables
- [ ] gate: `npm run test:unit -- --testPathPattern='backup/registry'`; e2e `--testPathPattern='backup/restore/restore-backup.e2e'`; typecheck

### Task 2: Notification endpoint (record and enqueue)

**Files:**

- Create: `packages/backend/src/services/ingest/notification/{parse-notification-payload,notification-fingerprint,ingest-notification,notification-queue}.ts` + `parse-notification-payload.unit.ts`, `notification-fingerprint.unit.ts`
- Create: `packages/backend/src/controllers/ingest/notification.controller.ts`
- Modify: `packages/backend/src/routes/ingest.route.ts`, `packages/backend/src/setup-middleware.ts` (16 KB `largePaths` entry), `packages/backend/src/routes/base-currency-guard-coverage.e2e.ts`
- Create: `packages/backend/src/services/ingest/notification/ingest-notification.e2e.ts`; Modify: `packages/backend/src/tests/helpers/ingest.ts` (`ingestNotification`)

- [ ] write failing unit tests: field aliases, length caps, `raw` size cap, empty-notification rejection, key rule, time window; fingerprint stable across whitespace and key order
- [ ] write failing e2e: 202 `queued` with a stored `received` row and `sourceApp`; same key and body → `duplicate`; same key, other body → 409; dry run with and without a known source; 401 without token; 413 over 16 KB; 422 empty notification; guard coverage includes the route
- [ ] `parseNotificationPayload` (no database), `computeNotificationFingerprint`
- [ ] `ingestNotification`: tx 1 insert `ON CONFLICT DO NOTHING`, upsert `NotificationSources` (`lastSeenAt`), enqueue `{ requestId }` with `delay` and `jobId = requestId` after commit
- [ ] `notification-queue.ts` (queue + worker registration following `categorization-queue.ts`; the worker calls Task 5's `processNotification`, a no-op stub until then); attempts 4, exponential backoff; on the final failure the request is parked `processingFailed`
- [ ] controller and route (`authenticateIngestToken`, `checkBaseCurrencyLock`, `ingestTokenRateLimit`)
- [ ] gate: unit `--testPathPattern='ingest/notification'`; e2e `--testPathPattern='(ingest/notification/ingest-notification|routes/base-currency-guard-coverage).e2e'`; typecheck, lint

### Task 3: AI features `notificationParsing` and `duplicateMatching`

**Files:**

- Modify: `packages/shared/src/types/ai/settings.ts`, `packages/backend/src/services/ai/resolution-ladder.ts` (cheap fast defaults, like `trackerMatching`)
- Modify: `packages/frontend/src/common/const/ai-features.ts` + i18n `common.aiFeatures.*`, `settings.ai.modelGuide.*` (`en` + `uk`)
- Modify: `packages/backend/src/services/user-settings/ai-feature-settings.e2e.ts`, `packages/backend/src/services/ai/ai-model-resolver.unit.ts`, `packages/frontend/src/composable/use-ai-feature-access.test.ts`

- [ ] write failing tests: the feature settings endpoint lists, saves and resolves both features; resolver falls back to the ladder default; the frontend registry has an entry for every `AI_FEATURE`
- [ ] enum values `notification_parsing`, `duplicate_matching`; ladder defaults; frontend entries and copy (ask the owner for wording if unclear)
- [ ] gate: unit `--testPathPattern='ai-model-resolver'`; e2e `--testPathPattern='user-settings/ai-feature-settings.e2e'`; frontend `--run src/composable/use-ai-feature-access.test.ts`; typecheck

### Task 4: Notification parsers (Wallet and AI)

**Files:**

- Create: `packages/backend/src/services/ingest/notification/{parse-wallet-notification,parse-notification-with-ai,notification-prompt,classify-notification}.ts` + unit specs
- Create: `packages/backend/src/services/ingest/notification/fixtures/notifications.ts` (sample texts: the Wallet sample, Georgian, Russian, Ukrainian and English bank debits, a credit, an OTP, a decline, a promo, an FX payment, a settlement notice)

- [ ] write failing unit tests: Wallet parser accepts `GEL 43.60`, `₾43.60`, `43,60 GEL` and rejects refund text and non-Wallet apps; `classifyNotification` returns `ignored/notTransaction` for digit-free text without an AI call; AI output mapping (kinds → direction, confidence floor → `lowConfidence`, invalid amount → missing, digits pattern, `[redacted]` for `security`), with `jest.mock('ai')`
- [ ] `parseWalletNotification`; `parseNotificationWithAi` (`createAIClient({ feature: AI_FEATURE.notificationParsing })`, `generateText` + `Output.object`, `aiCallGuards`, `trackAiUsage`, `resolveAiExtractionFailure`; `null` client → `aiUnavailable`); `classifyNotification` composes them and returns the `parsed` shape
- [ ] prompt: language-agnostic instructions, the untrusted-text rule, the kind definitions from Decisions, examples drawn from the fixtures
- [ ] gate: unit `--testPathPattern='ingest/notification/(parse|classify|notification-prompt)'`

### Task 5: Processing job and the shared logging core

**Files:**

- Create: `packages/backend/src/services/ingest/log-ingested-payment.ts`; Modify: `packages/backend/src/services/ingest/card-payment/process-card-payment.ts` (delegates to it)
- Create: `packages/backend/src/services/ingest/notification/{process-notification,resolve-notification-account}.ts`
- Modify: `packages/backend/src/crons/ingest-requests-cleanup.ts` (7-day `ignored` retention, suggestion cleanup), `packages/backend/src/services/ingest/card-payment/{process-ingest-request,list-requests,retry-request,format-summary}.ts` (shared waiting rules, new reasons, the 30-minute interrupted threshold for notification requests)
- Create: `packages/backend/src/services/ingest/notification/process-notification.e2e.ts`

- [ ] write failing e2e (AI mocked over MSW, job run through the queue with the delay shortened by the timings object): Wallet notification logged with no AI connection; bank debit logged as expense and credit as income with merchant, payee and history category; OTP stored `ignored/security` with a redacted payload; decline and promo ignored; muted source ignored without parsing; no AI → `aiUnavailable`, then logged by retry after an AI connection is added; own transfer and low confidence parked, `force` retry logs them; FX payment logged with `originalAmount`; connected account → planned row
- [ ] write failing e2e for resolution: Wallet title → card link; `*1234` → `lastDigits` link; app default account; nothing → `unknownAccount` with `accountGuessId`, then logged after linking
- [ ] extract `logIngestedPayment` (direction, slot, `externalData.ingest`; the card-payment path keeps `externalData.cardPayment` as well); existing card-payment e2e stays green unchanged
- [ ] `processNotification`: lock row → replay/repeat → parse once into `parsed` → ignore/park → resolve account → (Task 6/8 dedup hooks, pass-through until then) → log → `logged`; one in-app notification per source app for `unknownAccount`
- [ ] gate: e2e `--testPathPattern='ingest/(notification/process-notification|card-payment/(ingest-card-payment|processing|requests|ai-categorization)).e2e'`; unit `--testPathPattern='ingest'`

### Task 6: Account-resolution settings (notification sources, last digits)

**Files:**

- Create: `packages/backend/src/controllers/ingest/notification-sources.controller.ts`; Modify: `packages/backend/src/routes/user.route.ts`, `packages/backend/src/services/ingest/card-mappings.service.ts`, `packages/backend/src/controllers/ingest/card-mappings.controller.ts`
- Create: `packages/backend/src/services/ingest/notification/notification-sources.e2e.ts`; Modify: `packages/backend/src/services/ingest/card-mappings.e2e.ts`

- [ ] write failing e2e: sources list (empty state, after a notification), set default account (owned, active accounts only; 404 for another user's), mute, delete; `lastDigits` create/patch, 2–4 digits, conflict on a second link with the same digits (409)
- [ ] implement endpoints and validation; guard exemptions with reasons
- [ ] gate: e2e `--testPathPattern='ingest/(notification/notification-sources|card-mappings).e2e'`

### Task 7: Tier-1 deterministic twin and enrichment

**Files:**

- Create: `packages/backend/src/services/ingest/dedup/{constants,source-slots,find-twin,enrich-twin}.ts` + `source-slots.unit.ts`, `find-twin.unit.ts`
- Modify: `packages/backend/src/services/ingest/log-ingested-payment.ts` (lock, twin check, attach), `packages/backend/src/services/ingest/notification/process-notification.ts`
- Create: `packages/backend/src/services/ingest/dedup/twin.e2e.ts`

- [ ] write failing unit tests: slot derivation for tap, Wallet, bank (with stage) and for legacy rows that carry only `externalData.cardPayment`; twin selection (exact amount, same original amount, 30-minute window, taken slot, `isSameShop` veto, two candidates → none)
- [ ] write failing e2e: tap → Wallet → bank yields one row with three sources; bank first, then tap attaches; two identical coffees two minutes apart stay two rows; a USD tap on a GEL manual account takes the bank's GEL amount and the balance moves by the difference; a missing payee is filled and the second spelling becomes an alias; a settlement notification attaches to the row holding the authorization; the request is `logged` with `matchedBy: 'twin'` in `parsed`
- [ ] implement under the per-user advisory lock in both paths; attach updates through `updateTransaction` (amount, original amount, payee) and merges `externalData.ingest`
- [ ] gate: unit `--testPathPattern='ingest/dedup'`; e2e `--testPathPattern='ingest/(dedup/twin|card-payment/(ingest-card-payment|processing)|notification/process-notification).e2e'`

### Task 8: AI duplicate judge

**Files:**

- Create: `packages/backend/src/services/ingest/dedup/{judge-duplicates,judge-prompt,find-judge-candidates}.ts` + `judge-duplicates.unit.ts`
- Modify: `packages/backend/src/services/ingest/notification/process-notification.ts`
- Create: `packages/backend/src/services/ingest/dedup/judge.e2e.ts`

- [ ] write failing unit tests (`jest.mock('ai')`): short-id round trip, unknown ids dropped, confidence clamped, thresholds map to attach/suggest/none, no AI client → none
- [ ] write failing e2e (MSW): a bank notification with a different merchant spelling and an amount within tolerance attaches at 0.95 (`matchedBy: 'ai'`); at 0.7 it logs a new row and stores an `open` suggestion; at 0.3 it logs a new row only; candidates never include rows whose slot is taken or rows on another account
- [ ] `findJudgeCandidates` (SQL: account, direction, tolerance or original amount, 72 h, at least one ingest side, no existing suggestion for the pair); `judgeDuplicates` (`AI_FEATURE.duplicateMatching`, usage tracked)
- [ ] gate: unit `--testPathPattern='ingest/dedup/judge'`; e2e `--testPathPattern='ingest/dedup/(judge|twin).e2e'`

### Task 9: Reconciliation for manual accounts and ingest plans

**Files:**

- Modify: `packages/backend/src/services/transactions/reconciliation/{helpers,merge-transactions,restore-transactions,get-history}.ts`
- Create: `packages/backend/src/services/ingest/dedup/choose-survivor.ts` + unit spec
- Modify: `packages/backend/src/services/transactions/reconciliation/reconciliation.e2e.ts`, i18n `transactions.reconciliation.*` (`en` + `uk`)
- Modify: `packages/frontend/src/pages/optimizations/reconciliation/block-reasons.ts` + test

- [ ] write failing e2e: merge and remove on a manual account change the balance and `Balances` history by the removed amounts, restore reverses them; bank rows keep balance unchanged (existing tests); an ingest plan merges into a booked row; a booked row cannot merge into a plan survivor; a user-created plan is still rejected; `planEditMerge` moves a manual category from the removed row and a conflict rejects with its reason
- [ ] `loadReconcilableRows`: admit system rows and ingest plans; `softDeleteTransactions`/restore apply the system-row balance changes; merge applies `planEditMerge` values to the survivor
- [ ] `chooseSurvivor` (booked bank or imported row, else earliest ingest row); history entries carry the suggestion (confidence, reason, `auto`) when one exists
- [ ] frontend `block-reasons.ts` mirrors the new rules (`notBankConnected` becomes "manual row from another source"; ingest plans allowed)
- [ ] gate: e2e `--testPathPattern='transactions/reconciliation/reconciliation.e2e'`; unit `--testPathPattern='choose-survivor'`; frontend `--run src/pages/optimizations/reconciliation`

### Task 10: Duplicate suggestions and the scan job

**Files:**

- Create: `packages/backend/src/services/transactions/reconciliation/duplicate-suggestions.ts`, `packages/backend/src/services/ingest/dedup/duplicate-scan-queue.ts`, `packages/backend/src/services/ingest/dedup/event-listeners.ts`
- Modify: `packages/backend/src/controllers/transactions.controller/{reconciliation,reconciliation-schemas}.ts`, `packages/backend/src/routes/transactions.route.ts`, `packages/backend/src/services/transactions/delete-transaction.ts` (stale), `packages/backend/src/services/import-export/statement-parser/execute-import.service.ts` (enqueue a scan for imported rows)
- Create: `packages/backend/src/services/transactions/reconciliation/duplicate-suggestions.e2e.ts`; Modify: `packages/backend/src/tests/helpers/reconciliation.ts`
- MCP: `list-duplicate-suggestions`, `dismiss-duplicate-suggestion` through the `add-mcp-tool` skill (tool files, server registration, drift metafiles, `reconciliation-tools.unit.ts`)

- [ ] write failing e2e: suggestions list (empty state, open pair with both rows and the suggested survivor); dismiss hides it for good (a rescan does not recreate it); merging the pair marks it `merged`; deleting a row makes it `stale`; a synced booked row next to an unsettled ingest plan with a different merchant script yields a suggestion after `TRANSACTIONS_SYNCED`; two existing ingest rows judged at 0.95 are auto-merged and appear in history with the reason; a statement import row next to an ingest row yields a suggestion, never an auto-merge
- [ ] scan job: only accounts with ingest rows in the window, AI only when SQL finds candidates, batches of 5 candidates per row; auto-merge rules from Decisions; `planEditMerge` conflict → suggestion
- [ ] endpoints, MCP tools, base-currency guard on dismiss
- [ ] gate: e2e `--testPathPattern='(transactions/reconciliation/(duplicate-suggestions|reconciliation)|ingest/dedup/(judge|twin)).e2e'`; unit `--testPathPattern='(reconciliation-tools|mcp)'`

### Task 11: Frontend: Reconciliation Suggestions tab

**Files:**

- Create: `packages/frontend/src/pages/optimizations/reconciliation/components/{suggestions-tab,suggestion-card}.vue` + specs
- Modify: `packages/frontend/src/pages/optimizations/reconciliation/{index.vue,use-reconciliation.ts}`, `components/{merge-dialog,history-tab}.vue`, `packages/frontend/src/api/transactions.ts`, `packages/frontend/src/common/const/vue-query.ts`
- Create: `packages/frontend/e2e/tests/reconciliation/suggestions.spec.ts`

- [ ] failing vitest: tab with a count badge (as stuck-pending), side-by-side rows with sources, confidence and reason; **Merge** opens the existing merge dialog with both rows and the suggested survivor; **Not duplicates** dismisses; empty state; history shows "Merged automatically" with the reason
- [ ] implement (container queries, `frontend-rules`); i18n `optimizations.reconciliation.suggestions.*` (`en` + `uk`)
- [ ] Playwright: merge one suggestion, restore it from history
- [ ] gate: `npm run test:unit -- --run src/pages/optimizations/reconciliation`; frontend typecheck, lint

### Task 12: Frontend: notification setup on the Apple Pay page

**Files:**

- Create: `packages/frontend/src/pages/accounts/integrations/apple-pay/components/{notification-setup,notification-sources,notification-checklist}.vue` + specs, `composables/use-ios-version.ts` + spec
- Modify: `apple-pay-details.vue`, `apple-pay.ts` (reason labels), `components/{card-link-dialog,card-links,waiting-payments,payment-request-summary,add-shortcut-button}.vue`, `packages/frontend/src/api/ingest.ts`
- Create: `packages/frontend/e2e/tests/integrations/notification-sources.spec.ts`

- [ ] failing vitest:
  - a **Notifications (iOS 27 or later)** section after the tap setup: why (in-app and online Apple Pay, any bank card), **Add Shortcut** for `log-notification.shortcut` (hidden while the file is missing, as today), and a checklist: one automation for **Wallet** and one per bank app, each "When I receive a notification from <app>" → **Run Immediately** → "MoneyMatter: log notification"; a tip about the Message filter;
  - iOS detection from the user agent: below 27 the section collapses behind "Requires iOS 27"; desktop shows both;
  - the `limitation` callout points to the notification section;
  - notification sources: app, last seen, default account picker, mute, delete; empty state;
  - card link dialog: optional **Last digits**;
  - waiting and recent lists show notification requests with the parsed amount, merchant and kind, the new reasons, **Log anyway** for `ownTransfer`/`lowConfidence`, and an AI-setup link for `aiUnavailable`; `unknownAccount` offers linking with the guess pre-selected
- [ ] i18n `settings.integrations.applePay.notifications.*` (`en` + `uk`; owner approves the copy)
- [ ] Playwright: a parked notification (ingested through the API with AI mocked off: a Wallet sample with an unlinked card) is linked by last digits and logged
- [ ] gate: `npm run test:unit -- --run src/pages/accounts/integrations`; frontend typecheck, lint

### Task 13: The notification shortcut (depends on iOS 27 facts)

⚠️ Blocked until the owner's iPhone runs iOS 27 and a shortcut using the Notification trigger has been captured: the property names of the trigger's input, whether it exposes the app's bundle id and the notification's date, and real sample texts from Wallet and TBC Bank.

**Files:**

- Create: `packages/frontend/scripts/shortcuts/shortcut-plist.ts` (shared helpers moved out of `build-card-payment-shortcut.ts`), `packages/frontend/scripts/shortcuts/build-notification-shortcut.ts` + spec, `packages/frontend/scripts/shortcuts/fixtures/notification-input.xml` (device capture), `packages/frontend/shortcuts/log-notification.plist`
- Modify: `packages/frontend/package.json` (`shortcuts:build` builds both), `packages/frontend/public/shortcuts/README.md`
- Modify: `packages/backend/src/services/ingest/notification/fixtures/notifications.ts` (real samples) and the Task 4 specs that use them

- [ ] failing spec: drift check of the committed XML; the URL rewrite (`card-payment` → `notification`) applied to a decoded setup code; the body maps every captured input property; no-input run sends `dryRun`
- [ ] generator: setup-code text → decode → dictionary → URL rewrite → if no input: dry run → read the notification's properties (app, bundle id, title, subtitle, body, date, everything else into `raw`) → key = SHA-256 of `<app>|<title>|<subtitle>|<body>|<date or run time to the minute>` → POST → show `summary` only when `notify` is true
- [ ] add the real samples to the parser fixtures and re-run Task 4's tests
- [ ] gate: `npm run test:unit -- --run scripts/shortcuts`; backend unit `--testPathPattern='ingest/notification'`

### Task 14: Verify acceptance criteria

- [ ] one payment through all three sources (tap, Wallet notification, bank notification, in each order) leaves one row with three sources, the bank amount and the Wallet merchant's payee
- [ ] an online Apple Pay payment (Wallet notification only) is logged; an OTP and a promo are ignored, the OTP redacted
- [ ] an ambiguous match becomes a suggestion and is merged from the Reconciliation page; an auto-merge shows in history and restores, and the manual account's balance is right after both
- [ ] a bank sync and a statement import next to ingest rows produce no duplicate rows (plan settled) or a suggestion
- [ ] backend: `npm run test:unit` (full); e2e `--testPathPattern='(ingest|transactions/reconciliation|planned-matching|duplicates-detection|ai-categorization|user-settings/ai-feature-settings|backup|mcp|routes/base-currency-guard-coverage)'`
- [ ] frontend: typecheck, lint, `npm run test:unit -- --run`; Playwright `integrations/` and `reconciliation/` when the dev stack is up
- [ ] root `npm run format:check` and `npm run knip`

### Task 15: [Final] Update documentation

- [ ] `packages/docs/src/content/docs/integrations/notifications.mdx` (new, sidebar next to `apple-pay.mdx`, per the `user-docs` skill): iOS 27 requirement; which automations to create (Wallet + each bank app) with exact iOS labels; what is logged, ignored and parked and why; how accounts are matched (card name, last digits, app default); privacy (what is sent to the server and the AI provider, OTP redaction, 7-day retention of ignored requests, the Message filter tip); troubleshooting
- [ ] `integrations/apple-pay.mdx`: on iOS 27+ add the notification automations; the in-app limitation is covered by them
- [ ] `transactions/reconciliation.mdx`: the Suggestions tab, automatic merges, manual-account rows
- [ ] `packages/backend/docs/card-payment-ingest.md`: the notification endpoint, slots, the twin rule, the judge thresholds and the scan job; `services/bank-data-providers/docs/architecture.md`: a short note that reconciliation now covers manual rows and ingest plans
- [ ] `cd packages/docs && npm run build` with the link validator passing
- [ ] move this plan to `docs/plans/completed/` after Task 14 passes (Task 13 may stay open under ⚠️ if iOS 27 is still pending)

## Post-Completion

_Items requiring manual work or external systems; no checkboxes._

**Device capture (owner, with the orchestrator), before Task 13:**

- On iOS 27, create a Notification automation for Wallet that runs a scratch shortcut which saves its Shortcut Input to a file (or shows it with Quick Look), export that shortcut from the Mac as XML for `fixtures/notification-input.xml`, and note every property name.
- Collect real notification texts: Wallet (in-store tap, in-app, online, refund), TBC Bank (card payment, transfer out, incoming transfer, OTP, decline, promo, settlement, if it sends one). Redact OTP codes and balances before committing.

**Signing:** `shortcuts sign --mode anyone --input shortcuts/log-notification.plist --output public/shortcuts/log-notification.shortcut` on the Mac, as for the card-payment shortcut; AirDrop, import, paste the setup code, run once by hand for the dry-run line.

**Cloudflare Access for `money.nemirovsky.dev`:** the path-scoped Service Auth app covers `/api/v1/ingest/card-payment`; widen it to `/api/v1/ingest/` (or add `/api/v1/ingest/notification`) with the same service token. Verify that an anonymous request gets 403 and one with the headers reaches the app.

**Deployment:** build images from this branch, back up the database, migrate, configure an AI connection for `notificationParsing` and `duplicateMatching` (or rely on the defaults), then create the automations on the phone.

**Upstream:** offer after the Apple Pay ingest lands: endpoint + parsing + dedup (Tasks 1–10), reconciliation UI (Task 11), setup UI + shortcut (Tasks 12–13), docs.
