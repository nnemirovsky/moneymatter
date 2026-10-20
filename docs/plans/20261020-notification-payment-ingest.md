# Payment ingest from iOS notifications, with AI parsing and dedup

## Overview

iOS 27 brings two changes to Shortcuts:

- a personal-automation trigger, **"When I receive a notification from <app>"**, with optional Title, Subtitle and Message filters;
- **Unified Automations**: triggers are part of the shortcut itself (`WFWorkflowTriggers` in the plist), and they travel with it when it is shared.

Together they let MoneyMatter log payments that the Wallet **Transaction** automation never sees:

- **Wallet notifications** cover Apple Pay inside apps and on websites, which the tap automation misses (the Apple Pay page says so in its `limitation` callout).
- **Bank notifications** cover plain card payments, ATM withdrawals, transfers, refunds and incoming money. They can arrive as an app push (TBC Bank for the owner), a bank SMS in Messages or a bank email in a mail app, in any bank's format and language.

The plan delivers:

1. **Two downloadable shortcuts:**
   - **iOS 27+:** "MoneyMatter: log payments", with its triggers built in: the Wallet Transaction trigger and a Notification trigger as broad as iOS allows (ideally any app; otherwise Wallet pre-filled, plus instructions to add Messages, bank apps and mail apps). The shortcut stays dumb: it forwards the raw trigger input. An **on-device privacy gate** drops any notification that shows no amount, so chats and other private notifications never leave the phone.
   - **Older iOS:** today's "MoneyMatter: log card payment", with the manual automation steps.
2. **`POST /api/v1/ingest/event`:** one endpoint for both trigger kinds.
   - The server tells a Wallet transaction from a notification by an explicit `kind` or by the payload's shape.
   - Transactions go through the existing card-payment pipeline, synchronously, and answer with a summary.
   - Notifications pass a **server prefilter**: an amount pattern plus obvious OTP and promo markers, checked before anything is stored or sent to an AI. Survivors are queued.
3. **Server-side parsing:** a deterministic parser for Wallet's fixed layout, and an AI parser for the rest. The AI parser is a new AI feature, `notificationParsing`, reusing the AI connections, feature config, model choice and the AI usage cap. Only real money movements are logged.
4. **Privacy, rate and cost limits:**
   - Notifications that are dropped or are not payments are never stored with their text; a per-source counter is all that remains.
   - Each user has a cap on accepted notifications per hour and per day, and on notification AI calls per day.
   - Messaging and mail apps reach the AI only from senders the user has approved.
5. **Account resolution** by the source (app, plus the sender for Messages and mail), the Wallet card name or the card's last digits. A request that matches none of these is parked for the user to link; the server never guesses.
6. **Dedup across sources.** One payment can arrive four or more times: tap, Wallet notification, bank push, bank SMS, minutes to hours apart, spelled differently. It can arrive again later from bank sync or a statement import.
   - A deterministic **twin check** attaches a later source to the existing row and enriches it.
   - An **AI duplicate judge** (new AI feature `duplicateMatching`) handles the ambiguous cases. A high-confidence match between ingest rows merges through the existing **Reconciliation** merge, which records it in history and keeps it restorable. A less certain match becomes a **suggestion** in a new Reconciliation tab.
7. **Setup UI** on the Apple Pay page (Accounts → Apple Pay). It picks the shortcut and instructions for the user's iOS version, detected from the user agent where possible and otherwise chosen by the user.
8. **Docs.**

Out of scope: Android notification listeners, own-account transfer pairing, alerts when the bank's balance and the account balance drift apart (the balance is stored only), and changes to the planned-row settlement rules of the Apple Pay plan.

Work happens in the fork on `feat/notification-ingest` (from `dev`). Names stay generic and nothing is owner-specific, so it can be offered upstream after the Apple Pay ingest.

## Context (from discovery)

- **Ingest pipeline** (`packages/backend/src/services/ingest/card-payment/`, plan `docs/plans/completed/20261017-apple-pay-ingest.md`):
  - Route `routes/ingest.route.ts`: `authenticateIngestToken({ scope: INGEST_SCOPES.transactions })` → `checkBaseCurrencyLock` → `ingestTokenRateLimit` (30/min per token) → `controllers/ingest/card-payment.controller.ts` → `ingestCardPayment` (`services/ingest`).
  - The steps:
    - tx 1 `record-request.ts` writes `IngestRequests`, unique on `(userId, idempotencyKey)`;
    - tx 2 `process-ingest-request.ts` takes a row lock and applies the 120 s repeat window (`findOriginalInWindow`, keyed by `fingerprint.ts`'s `computeFingerprint`, under `pg_advisory_xact_lock`);
    - tx 3 `park-failed-request.ts` parks a request whose processing threw;
    - `process-card-payment.ts` does the mapping, currency (`resolve-currency.ts`, `parse-amount.ts`), conversion, payee (`resolvePayeeForIncomingRow`, threshold 1), history category and `createTransaction`. The row is planned on bank-connected accounts and carries `externalData.cardPayment`.
  - Shared types live in `packages/shared/src/types/ingest/`; card links are `CardAccountMappings` (`services/ingest/card-mappings.service.ts`).
  - Retention runs in `crons/ingest-requests-cleanup.ts` (90 days).
  - Migration `20261017020000-card-payment-ingest.ts` is already on `dev`, so this branch adds a new one (repo rule 11).
- **Reconciliation** (`services/transactions/reconciliation/`, routes `/transactions/reconciliation/*`, controller `controllers/transactions.controller/reconciliation.ts`):
  - `mergeTransactions({ userId, transactionIds, survivorId })` moves tracker, group, subscription and period links to the survivor, then `softDeleteTransactions` sets `deletedAt` + `mergedIntoId`. The other services are `removeTransactions`, `restoreTransactions` and `getReconciliationHistory`.
  - `loadReconcilableRows` **rejects system rows (manual accounts) and planned rows**. `softDeleteTransactions` runs with hooks off, because bank balances are bank-authoritative. On a manual account that would leave the hidden row's amount in the balance: `Transactions` `@BeforeDestroy` calls `updateAccountBalanceForChangedTx` and `Balances.handleTransactionChange` for `ACCOUNT_TYPES.system`.
  - No suggestions are persisted; the user picks rows by hand. Stuck-pending candidates are computed on the fly.
  - MCP tools (`services/mcp/tools/`): `merge-duplicate-transactions`, `remove-duplicate-transactions`, `keep-pending-as-booked`, `restore-removed-transactions`, `get-reconciliation-history`, `list-stuck-pending-transactions`.
  - Frontend: `packages/frontend/src/pages/optimizations/reconciliation/` (tabs, `block-reasons.ts`, `merge-dialog.vue`).
  - The edit-merge policy is `planEditMerge` (`services/bank-data-providers/enablebanking/utils/plan-edit-merge.ts`).
- **Planned settlement:** `services/transactions/planned-matching/` (`findPlannedMatch`, `mergeIntoPlanned`, `isSameShop`, `hasMerchantAffinity`, `CARD_PAYMENT_AMOUNT_TOLERANCE`). Every provider and import passes `matchPlanned`. Import previews flag duplicates through `duplicates-detection/detect-duplicates.service.ts`.
- **AI infrastructure** (`services/ai/`):
  - `AI_FEATURE` in `packages/shared/src/types/ai/settings.ts`; defaults per feature in `resolution-ladder.ts`; the frontend registry is `packages/frontend/src/common/const/ai-features.ts`.
  - `createAIClient({ userId, feature })` returns `null` when nothing can answer. A call uses `generateText` + `Output.object`, `aiCallGuards`, `AI_MAX_OUTPUT_TOKENS`, then `trackAiUsage`, and errors go through `resolveAiExtractionFailure`. `createShortIds` aliases ids in prompts. The template to follow is `services/trackers/smart-tracking/run-tracker-scan.ts`.
  - **AI usage cap** (upstream `008b2cfef`, `services/ai/ai-allowance.ts`): `resolveAIConfiguration` offers server keys only while `isWithinAiAllowance`. `trackAiUsage` → `recordAiSpend` records monthly spend and reports the cap crossing to PostHog (`trackAiCapReached`). `services/ai/connection-failure.ts` tells an exhausted cap apart from a missing connection. Self-hosted instances have no cap.
  - E2E tests mock AI over MSW (`createGeminiMock`, `getCustomEndpointContentMock`). The BullMQ queue pattern is `services/ai-categorization/categorization-queue.ts`; providers emit `DOMAIN_EVENTS.TRANSACTIONS_SYNCED`.
- **Rate limits:** `middlewares/rate-limit.ts` (`createRateLimit`, `perUserNonDevRateLimit`, `RateLimitService` on Redis).
- **Frontend setup UI:** `packages/frontend/src/pages/accounts/integrations/apple-pay/apple-pay-details.vue` (`setup-checklist.vue`, `add-shortcut-button.vue`, `card-links.vue`, `card-link-dialog.vue`, `waiting-payments.vue`, `unconfirmed-payments.vue`, `ingest-devices.vue`), with i18n under `settings.integrations.applePay.*`.
- **Shortcut generator:** `packages/frontend/scripts/shortcuts/build-card-payment-shortcut.ts`. It is a deterministic plist (`SHORTCUT_ACTIONS`/`SHORTCUT_PARAMS`, a spec drift check, and the device fixture `fixtures/transaction-input.xml`), signed into `public/shortcuts/log-card-payment.shortcut`.
- **iOS 27 facts so far** (owner's iPhone, `WFWorkflowClientVersion` 5037.111):
  - A shortcut plist carries `WFWorkflowTriggers`, an array of `{ WFTriggerIdentifier, WFTriggerSerializedParameters, WFTriggerUUID }`.
  - A Notification trigger is `WFNotificationTrigger`. Its filters serialize as `Conditions` → a `WFContentPredicateTableTemplate` whose `WFActionParameterFilterTemplates` entries look like `{ Operator, Property: 'Title', Removable, Values }`.
  - **Unknown:**
    - how the App parameter is serialized (and whether "any app" exists);
    - the Wallet Transaction trigger's identifier and parameters;
    - the property names the Notification input exposes;
    - whether "Run Immediately" travels with a shared shortcut;
    - whether `shortcuts sign` keeps the triggers.
  - One Wallet sample: title `TBC Bank` (the Wallet card name), subtitle `Wolt`, body `GEL 43.60`.

## Decisions

- **One endpoint, two kinds:** `POST /api/v1/ingest/event` (scope `ingest:transactions`).
  - An explicit `kind` (`walletTransaction` | `notification`) wins.
  - Otherwise the shape decides: a non-empty `merchant` or `card` makes a `walletTransaction`; `title`, `subtitle` or `body` makes a `notification`.
  - A `walletTransaction` is mapped onto the card-payment body and handled by `ingestCardPayment`, unchanged: synchronous, with a summary, `notify: true`.
  - `/ingest/card-payment` stays for the older shortcut and for other clients.
  - The iOS 27 shortcut derives the URL from the setup code's `url` by replacing the last path segment (`card-payment` → `event`), so existing setup codes and tokens keep working and the user still pastes one code.
- **Notifications are asynchronous and quiet.**
  - The endpoint answers `202 queued`. A BullMQ job (`ingest-notification`) processes the request after a **15 s delay**, so the synchronous tap usually creates the row first and the notification attaches to it deterministically. Retries with backoff absorb AI outages.
  - The answer carries `notify: false`, and the shortcut shows a banner only when `notify` is true: the bank already notified the user.
  - A payment that needs the user raises one in-app notification per source, not one per request (`services/notifications`).
- **Three layers keep private text from leaving the phone or reaching the AI:**
  1. **On-device gate:** the shortcut sends a notification only when Match Text finds an amount, meaning a number with a currency symbol, an ISO code or a common local currency word next to it. The pattern is defined once in `packages/shared` (`AMOUNT_GATE_PATTERN`, ICU syntax, which Shortcuts and JavaScript both accept, `\p{Sc}` included). The generator embeds it and the server reuses it, so the two cannot drift. A Wallet transaction input (Merchant or Card present) always passes.
  2. **Server prefilter, before the request is stored:**
     - no amount match → dropped (`noAmount`);
     - an OTP marker (a multilingual list: code, OTP, 3-D Secure, password, код, კოდი, …) together with a standalone 4–8 digit code → dropped (`security`). A 3-D Secure message that also shows an amount is a confirmation step, not the payment;
     - a strong promo marker (percent-off, unsubscribe, a promo word list) with no card digits or balance → dropped (`promo`);
     - a source the user muted → dropped (`muted`).

     A dropped notification answers `200 { outcome: 'dropped' }`. It is **not stored**: only the source's counter for that reason and `lastSeenAt` change.
  3. **Messaging and mail apps** (Messages, Mail, Gmail, Outlook, Telegram, WhatsApp, Signal…; a list of bundle ids and names) are conversational. A sender there is a source of its own, `app + title`, and starts out `pending`.
     - A notification from a pending sender that passed the gate and the prefilter is parked as `senderNotApproved`, without an AI call.
     - Approving the sender processes what it parked. Muting it deletes the parked text.
     - Pending requests are deleted after 7 days.
     - The sender's name is the only thing stored about a sender the user never approves.
- **Retention of notification text:**
  - A request the AI classifies as not a payment keeps only its fingerprint hash, kind and reason: title, subtitle, body and `raw` are wiped in the same transaction, and the row is deleted after 7 days.
  - Payment notifications keep their raw text on the request for review and retry, under the existing 90-day retention.
- **Rate limits and cost caps per user:**
  - **Endpoint:** the existing 30/min per token. On top of that, `ingestEventRateLimit` per user allows 120 accepted notifications an hour and 1000 a day, counted after the prefilter so dropped chatter costs nothing. Over the limit, the answer is 429 and the source counter records it.
  - **AI calls:** at most `INGEST_AI_DAILY_LIMIT` notification and judge calls per user per day (default 300, env-configurable, a Redis counter). Over it, the request is parked as `aiLimitReached` and can be retried the next day.
  - **AI usage cap:**
    - Every call goes through `createAIClient` and `trackAiUsage`, so spend counts toward the monthly cap, and the cap crossing is tracked by the upstream code.
    - When the cap stops the server keys, `createAIClient` returns `null`. The request is parked as `aiCapReached` (detected the way `connection-failure.ts` does) instead of `aiUnavailable`.
    - Wallet notifications need no AI and keep working either way.
- **What gets logged** (the AI output's `kind`):
  - `debit` (purchase, hold, ATM, outgoing payment, fee) → **expense**.
  - `credit` (refund, reversal, cashback, incoming transfer, salary, top-up) → **income**. Incoming money is a real balance change. A refund stays a plain income row; linking it to the purchase remains a user action.
  - `declined`, `security`, `promo`, `info`, `other` (including a personal message from an approved sender) → **ignored**: the text is wiped, as above.
  - Own-account transfers (`isOwnAccountTransfer`) are parked as `ownTransfer`, and a parse confidence below 0.6 is parked as `lowConfidence`. Both show **Log anyway** / **Dismiss**.
- **The Wallet notification is parsed in code; everything else goes to the AI.** A notification from Wallet (bundle `com.apple.Passbook`, or a localized app-name list) whose body is only an amount that `parseAmount` accepts is a `debit`, with card = title and merchant = subtitle. Other Wallet text, bank pushes, SMS and email go to `notificationParsing`. With no AI client at all, the request is parked as `aiUnavailable` and retried once AI is set up.
- **Two AI features:** `notificationParsing` (multilingual extraction, high volume, a cheap fast default model) and `duplicateMatching` (comparison, low volume). Like every existing feature, each has its own model choice and usage tracking.
- **Sources** (`NotificationSources`):
  - The key is the bundle id when sent, else the normalized app name; conversational apps append the normalized sender. A source is created on first sight and lists counters per outcome (logged, ignored, dropped by reason, rate-limited).
  - It carries `mode` (`auto` | `pending` | `approved` | `muted`) and an optional `defaultAccountId`.
  - So "Messages · TBC" and the TBC app are separate sources: each has its own account default and its own dedup slot.
- **Account resolution, in order; an AI guess never logs:**
  1. The card name the parser found (the Wallet title) → `CardAccountMappings`, by `normalizeCardLabel`.
  2. The card's last digits → the new `CardAccountMappings.lastDigits` (unique per user), so one link covers the Wallet name and the bank's digits.
  3. The source's `defaultAccountId`.
  4. Otherwise the request parks as `unknownAccount`, and the link dialog is pre-filled with a heuristic guess (matching currency, and the account name shares a token with the source name).
- **Dedup is two-tier and reuses existing state:**
  - **Source slots.** A row holds at most one request per slot: `tap`, `wallet-notification`, `bank:<sourceKey>:<stage>`. The stage is `authorization`, `settlement` or `unknown`, read by the parser, because some banks notify again when the payment settles. A bank's push and its SMS are different sources, so both can attach to one row. Slots are what keep two identical coffees two rows.
  - **Tier 1, deterministic twin**, run at ingest under one per-user advisory lock, by both the tap path and the notification job. A candidate qualifies when all of these hold:
    - same account and direction;
    - its slot for this source is free;
    - the exact amount in the same currency, or the same original amount and currency;
    - within 30 minutes;
    - `isSameShop` does not veto it.

    Exactly one qualifying candidate → **attach**: no new row is created, the request is logged with that `transactionId` and `matchedBy: 'twin'`, and the row is enriched.
  - **Tier 2, AI judge** (`duplicateMatching`): candidates within ±25 % or with the same original amount, up to 72 h apart, with at least one side from ingest.
    - In the notification job: confidence ≥ 0.9 → attach; 0.6–0.9 → log the row and store a **suggestion**; below 0.6 → log the row.
    - In the scan job (after an ambiguous ingest, after `TRANSACTIONS_SYNCED`, after a statement import): ≥ 0.9 → **auto-merge** through `mergeTransactions`, but only when both rows are ingest rows, or an ingest plan meets a booked bank row; everything else becomes a suggestion. Rows the user typed or imported are never auto-merged.
  - Suggestions are persisted (`DuplicateSuggestions`): a dismissed pair never comes back. Merging one reuses `mergeTransactions` and its history.
- **Enrichment when a source attaches or rows merge:**
  - The bank's figure in the account currency replaces a converted tap or Wallet amount; the charged currency is kept as `originalAmount`/`originalCurrencyCode`. The change goes through `updateTransaction`, so a manual account's balance follows.
  - A missing payee is resolved from the new merchant. When the row already has a payee, another spelling becomes its alias (`ensureAliasExists`), unless that text resolves to a different payee.
  - `externalData.ingest = { sources: [{ slot, requestId, receivedAt, merchant }], balanceAfter? }`.
  - User edits are never overwritten. `planEditMerge` decides what moves on a merge, and a conflict downgrades an auto-merge to a suggestion.
- **Reconciliation widens:**
  - **System rows** become reconcilable. Their soft delete withdraws the amount from the balance and from `Balances`, as `@BeforeDestroy` does, and restore puts it back. Bank rows keep today's behavior.
  - **Ingest plans** become reconcilable, but a plan is never the survivor of a merge that includes a booked row. A user-made plan is still rejected.
  - **Survivor:** a booked bank or imported row, else the earliest ingest row.
- **Requests share `IngestRequests`.** `source` is `card-payment` or `notification`. The new status is `ignored`, there are new reasons, and the parse result goes into a new `parsed` JSONB column, so a retry never calls the AI twice. A notification request counts as interrupted only after 30 minutes of `received`.

## Development Approach

- **Testing approach: TDD.** Each task writes its failing tests first (unit, or e2e through HTTP helpers), runs them, and records that they fail on assertions, not on setup. AI is mocked over MSW (`createGeminiMock`, `getCustomEndpointContentMock`) in e2e tests and with `jest.mock('ai')` in unit tests.
- **Prefix every node/npm command** with `export PATH="$(mise where node@24.21.0)/bin:$PATH"`.
- **Commands:**
  - backend unit: `cd packages/backend && npm run test:unit -- --testPathPattern='<regex>'`;
  - backend e2e, never in parallel: `cd packages/backend && lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='<regex>'`;
  - frontend: `cd packages/frontend && npm run test:unit -- --run <path>`;
  - root: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run knip`.
- **Delegation:** tests run through the `test-runner` subagent, lint through `linter`, i18n through `i18n-editor` (`en` and `uk` together), and MCP tools are added with the `add-mcp-tool` skill.
- **Task discipline:** finish each task before starting the next, and every gate names its tests. Repo rules apply: object params, kebab-case files, comments that describe the current code, `Money` everywhere, and one migration for this branch, amended rather than duplicated.
- **Commits:** none by implementing agents unless the owner asks (repo CLAUDE.md rule 10).

## Testing Strategy

- **Unit:**
  - the amount gate pattern, against a shared fixture of positive and negative samples. The same fixture runs in the shortcut spec, so the device and the server agree;
  - the prefilter (OTP, promo, muted, conversational senders);
  - payload shape detection and normalization;
  - the notification fingerprint;
  - the Wallet parser;
  - the AI output validation;
  - the per-user AI daily counter;
  - source keys;
  - account resolution order;
  - slots, the twin rule, judge output mapping, survivor choice and the enrichment planner.
- **E2E (HTTP only):**
  - **endpoint:** the `walletTransaction` kind returns the card-payment summary; `notification` → 202; dropped notifications leave no request row and bump a counter; idempotent replay; 409 on a reused key; dry run; 413; the hourly and daily limits → 429; guard coverage.
  - **processing:**
    - Wallet notification without AI;
    - bank push debit and credit;
    - SMS from an approved sender;
    - pending sender parked, then processed on approval;
    - non-payment text wiped;
    - `aiUnavailable`, `aiCapReached` (allowance mocked as spent) and `aiLimitReached`;
    - `ownTransfer` and `lowConfidence`;
    - `unknownAccount`, then logged after linking by digits or by the source default.
  - **dedup:** tap → Wallet → push → SMS, in different orders; two identical coffees; an FX payment where the bank amount wins; a settlement attaching to its authorization; judge attach, suggestion and none; the scan after sync and after a statement import.
  - **reconciliation:** manual-account merge, remove and restore with correct balances; an ingest plan merged into a booked row; suggestions listed, dismissed and merged; history shows the auto-merge reason.
  - **settings:** notification sources (mode, default account), `lastDigits`.
- **Frontend vitest:** iOS version detection and the manual picker; the right shortcut and checklist per version; sources and pending senders; the Suggestions tab; block reasons.
- **Playwright:** approve a pending sender; merge a suggestion.
- **Manual on the device** (Post-Completion): trigger capture, signing with triggers, a real payment from every source.

## Progress Tracking

- Mark completed items `[x]` immediately; prefix newly discovered tasks with ➕ and blockers with ⚠️.
- After each gate passes, note the command and its result under the task.

## Solution Overview

```
iOS 27 shortcut "MoneyMatter: log payments" (WFWorkflowTriggers: Wallet Transaction + Notification)
  → decode setup code, url := last segment → "event"
  → Wallet transaction input: always send
    notification input: Match Text AMOUNT_GATE_PATTERN on title+subtitle+body, no match → stop
  → POST {kind?, merchant?, amount?, card?, name?, app?, bundleId?, title?, subtitle?, body?, time?, raw?, idempotencyKey}
→ authenticateIngestToken → checkBaseCurrencyLock → ingestTokenRateLimit → event controller
  ├─ walletTransaction → ingestCardPayment (existing, synchronous) → 200 {summary, notify:true}
  └─ notification → prefilter (amount, OTP, promo, muted) ─ dropped → counter only → 200 {dropped}
                  → ingestEventRateLimit (per user, hour/day) → tx 1: IngestRequests row + source upsert
                  → enqueue job (delay 15 s) → 202 {queued, notify:false}

ingest-notification job:
  replay/repeat (key; fingerprint 10 min) → pending sender? park senderNotApproved
  → parse: Wallet layout | AI notificationParsing (daily limit, usage cap) → parsed
  → not a payment: wipe text, ignored | park ownTransfer / lowConfidence / ai*
  → account: card name → last digits → source default → park unknownAccount
  → tx: per-user advisory lock → tier-1 twin → attach + enrich
        | tier-2 judge → attach ≥0.9 | log + suggestion 0.6–0.9 | log
  → logIngestedPayment (shared with the card-payment path)

duplicate-scan job (ambiguous ingest, TRANSACTIONS_SYNCED, statement import)
  → judge → auto-merge (ingest rows only) via mergeTransactions | DuplicateSuggestions
Reconciliation → Suggestions tab → Merge (existing dialog) | Not duplicates
```

- **Data** (one migration, `migrations/20261020120000-notification-ingest.ts`):
  - `IngestRequests`: add `parsed` (JSONB, null) and `sourceId` (FK `NotificationSources`, set null); `status` gains `ignored`.
  - `CardAccountMappings`: add `lastDigits` (varchar 4, null), with a partial unique index on `(userId, lastDigits)`.
  - `NotificationSources`: `id`, `userId` (FK, cascade), `sourceKey`, `appName`, `bundleId`, `sender` (null), `conversational` (bool), `mode`, `defaultAccountId` (FK `Accounts`, set null), `counters` (JSONB: outcome/reason → count), `lastSeenAt`, timestamps. Unique on `(userId, sourceKey)`. Backed up.
  - `DuplicateSuggestions`: `id`, `userId`, `accountId`, `transactionId`, `candidateId` (FKs, cascade), `confidence`, `reason`, `trigger` (`ingest` | `sync` | `import`), `status` (`open` | `merged` | `autoMerged` | `dismissed` | `stale`), `resolvedAt`, timestamps. Unique on the ordered pair. Backed up, and wiped with the user's data.
- **Shared** (`packages/shared/src/types/ingest/`): `amount-gate.ts` (`AMOUNT_GATE_PATTERN`, `AMOUNT_GATE_SAMPLES`), `notification-sources.ts` (the conversational app list, `buildSourceKey`), and the new statuses, reasons and DTOs.
- **Backend services** (`packages/backend/src/services/ingest/`):
  - `event/`: `ingest-event.ts` (kind detection, dispatch), `parse-notification-payload.ts`, `prefilter-notification.ts`, `notification-fingerprint.ts`, `notification-queue.ts`, `process-notification.ts`, `parse-wallet-notification.ts`, `parse-notification-with-ai.ts` (+ prompt), `ai-daily-limit.ts`, `resolve-notification-account.ts`, `notification-sources.service.ts`;
  - `log-ingested-payment.ts`: the logging core of `process-card-payment.ts`, generalized to direction, slot and `externalData`;
  - `dedup/`: `constants.ts`, `source-slots.ts`, `find-twin.ts`, `enrich-twin.ts`, `judge-duplicates.ts` (+ prompt, candidates), `choose-survivor.ts`, `duplicate-scan-queue.ts`, `event-listeners.ts`.
- **Reconciliation:** `helpers.ts` (reconcilable rows, a balance-aware soft delete), `restore-transactions.ts`, `merge-transactions.ts`, the new `duplicate-suggestions.ts`, and `get-history.ts`.

## Technical Details

- **Request body** (JSON, a 16 KB `largePaths` entry in `packages/backend/src/setup-middleware.ts`; unknown keys ignored):
  - `kind`: optional `walletTransaction` | `notification`; `idempotencyKey`: `^[\x21-\x7E]{8,128}$`, required unless `dryRun`.
  - Wallet transaction fields as in the card-payment API: `amount`, `currency`, `merchant`, `card`, `name`.
  - Notification fields:
    - `app` (≤ 100), `bundleId` (≤ 200);
    - `title` (≤ 500), `subtitle` (≤ 500), `body` (≤ 4000);
    - aliases: `appName` and `sourceApp` for `app`; `message` and `text` for `body`.
  - `time`: optional ISO 8601 with an offset; the window rules match card payments. `raw`: optional JSON (≤ 8 KB serialized), which the parser reads as text. `source`: optional `^[a-z0-9-]{1,32}$`. `dryRun`: optional.
- **Responses** (`{ status, response }` envelope):
  - `walletTransaction`: the card-payment responses plus `notify: true`.
  - `notification`:
    - `202 { outcome: 'queued', requestId, notify: false }`;
    - `200 { outcome: 'dropped', reason, notify: false }`;
    - `200 { outcome: 'duplicate', requestId, notify: false }` for a reused key and the same body; `409` for a reused key with a different body.
  - Dry run: `200 { outcome: 'dryRun', summary, notify: true }`.
  - Errors: 401/402/403/413/422/423/429 as on the card-payment endpoint.
- **Prefilter result:** `{ pass: true, hints: { hasCardDigits, hasBalance } } | { pass: false, reason: 'noAmount' | 'security' | 'promo' | 'muted' }`. The marker lists live in `prefilter-markers.ts`; each language gets its own block, and unit tests cover each block.
- **Fingerprint:** a SHA-256 over the canonical JSON of the source key, title, subtitle and body (whitespace collapsed). A repeat within 10 minutes is folded into the first request (`duplicateOfId`) without being parsed. This also covers the same notification arriving on two devices.
- **AI parse schema** (`notification_parse`):
  - `kind`, `stage`, `isOwnAccountTransfer`;
  - `amount`, `currency`, `originalAmount`, `originalCurrency`;
  - `merchant`, `cardName`, `cardLastDigits` (2–4 digits);
  - `balanceAfter`, `occurredAt`, `confidence`.

  The prompt says the text is untrusted data, not instructions. The call has no tools, and every field is validated (`parseAmount`, `resolveCurrency`, the digits pattern, length caps); an invalid field counts as missing.
- **`parsed`:** `{ parser: 'wallet' | 'ai', model?, kind, stage, direction?, amount?, currency?, originalAmount?, originalCurrency?, merchant?, cardName?, cardLastDigits?, balanceAfter?, occurredAt?, confidence, matchedBy?, accountGuessId? }`.
- **Reasons:**
  - park: `unknownAccount`, `senderNotApproved`, `aiUnavailable`, `aiCapReached`, `aiLimitReached`, `ownTransfer`, `lowConfidence`;
  - ignore (`INGEST_IGNORE_REASONS`): `declined`, `security`, `promo`, `info`, `other`;
  - drop (counters only): `noAmount`, `security`, `promo`, `muted`, `rateLimited`.
- **Payment time:** the parser's `occurredAt` when the text carries a full timestamp, else the request's `time`, else the receive time.
- **Dedup constants** (`dedup/constants.ts`, an object so tests can shorten them): `twinWindowMs` 30 min, `judgeWindowMs` 72 h, tolerance `CARD_PAYMENT_AMOUNT_TOLERANCE`, `attachConfidence` 0.9, `suggestConfidence` 0.6, `maxJudgeCandidates` 5. The lock is `pg_advisory_xact_lock(hashtextextended('ingest-dedup:<userId>', 0))`.
- **Judge schema** (`duplicate_judgement`): `{ matchId | null, confidence, reason }`, over `createShortIds` aliases.
- **Settings API** (session auth, `/user/settings/...`):
  - `GET /notification-sources` (with counters), `PATCH /notification-sources/:id` (`mode`, `defaultAccountId`), `DELETE /notification-sources/:id`.
  - Approving a pending sender enqueues its parked requests. Muting deletes their text.
  - `card-mappings` accepts `lastDigits`.
  - `card-payments/requests` also lists notification requests (`source` filter); `retry` takes `{ force: true }` for `ownTransfer`/`lowConfidence`.
- **Reconciliation API:** `GET /transactions/reconciliation/suggestions`, `POST /transactions/reconciliation/suggestions/:id/dismiss`. A merge marks the pair's suggestion `merged`; a deleted row marks its suggestions `stale`. MCP adds `list-duplicate-suggestions` and `dismiss-duplicate-suggestion`.
- **Guards:** `POST /ingest/event` and suggestion dismiss carry `checkBaseCurrencyLock`. The notification-source `PATCH`/`DELETE` are exempt, with a reason: settings, no money.
- **Retention** (`crons/ingest-requests-cleanup.ts`):
  - `ignored` and pending-sender requests: 7 days;
  - payment requests: 90 days, as now;
  - suggestions: `merged`/`autoMerged`/`stale` after 90 days; `dismissed` stay.

## What Goes Where

- **Implementation Steps:**
  - backend: schema, endpoint, prefilter, parsing, limits, dedup, reconciliation, settings and tests;
  - frontend: the Reconciliation page and the Apple Pay page;
  - the shortcut generator with triggers, after the device capture;
  - docs.
- **Post-Completion:** the device capture and samples, signing, the Cloudflare Access path, deployment, upstream.

## Implementation Steps

### Task 1: Schema and shared types

**Files:**

- Create: `packages/backend/src/migrations/20261020120000-notification-ingest.ts`, `packages/backend/src/models/{notification-sources,duplicate-suggestions}.model.ts`
- Modify: `packages/backend/src/models/{ingest-requests,card-account-mappings}.model.ts`
- Modify/Create: `packages/shared/src/types/ingest/{index,amount-gate,notification-sources}.ts`, reconciliation suggestion DTOs next to `ReconciliationHistoryEvent`
- Modify: `packages/backend/src/services/backup/registry.ts`, `packages/backend/src/services/user/wipe-user-data.service.ts`

- [ ] write failing tests: `registry.unit.ts` lists the new models; a restore round-trip keeps a source and a dismissed suggestion (`backup/restore/restore-backup.e2e.ts`); `amount-gate.unit.ts` runs `AMOUNT_GATE_SAMPLES` (GEL/₾/USD/$/€/грн/zł, both sides of the number, locale separators; negatives: plain codes, phone numbers, dates, chat text with no currency)
- [ ] migration (tables, columns, partial unique, ordered-pair unique, `down`); models; shared constants, statuses, reasons, DTOs, `buildSourceKey`, conversational app list
- [ ] backup entries with reasons; wipe covers both tables
- [ ] gate: unit `--testPathPattern='(backup/registry|amount-gate)'`; e2e `--testPathPattern='backup/restore/restore-backup.e2e'`; typecheck

### Task 2: Event endpoint, prefilter and limits

**Files:**

- Create: `packages/backend/src/services/ingest/event/{ingest-event,parse-notification-payload,prefilter-notification,prefilter-markers,notification-fingerprint,notification-queue,notification-sources.service}.ts` + unit specs
- Create: `packages/backend/src/controllers/ingest/event.controller.ts`; Modify: `packages/backend/src/routes/ingest.route.ts`, `packages/backend/src/setup-middleware.ts`, `packages/backend/src/middlewares/rate-limit.ts` (`ingestEventRateLimit`, applied in the service after the prefilter), `packages/backend/src/routes/base-currency-guard-coverage.e2e.ts`
- Create: `packages/backend/src/services/ingest/event/ingest-event.e2e.ts`; Modify: `packages/backend/src/tests/helpers/ingest.ts` (`ingestEvent`)

- [ ] write failing unit tests: kind detection (explicit, by shape, ambiguous → 422); payload aliases and caps; prefilter blocks per language (OTP with a code → `security`; 3-D Secure with an amount → `security`; percent-off promo → `promo`; payment text with card digits and a promo word passes); fingerprint stability
- [ ] write failing e2e:
  - a `walletTransaction` logs through the card-payment pipeline and answers its summary with `notify: true`;
  - a notification → 202 with a stored row and the source created;
  - `noAmount`/`security`/`promo`/`muted` → 200 `dropped`, **no** `IngestRequests` row, and the source counter bumped;
  - key replay and 409;
  - dry run;
  - 413;
  - hourly limit → 429 with the counter, and a dropped request does not count;
  - guard coverage
- [ ] implement detection, prefilter, source upsert with counters, tx 1, and the enqueue with a 15 s delay and `jobId = requestId`. Queue: 4 attempts with exponential backoff, and the final failure parks `processingFailed`. The worker calls a stub until Task 5.
- [ ] gate: unit `--testPathPattern='ingest/event'`; e2e `--testPathPattern='(ingest/event/ingest-event|ingest/card-payment/ingest-card-payment|routes/base-currency-guard-coverage).e2e'`

### Task 3: AI features `notificationParsing` and `duplicateMatching`

**Files:**

- Modify: `packages/shared/src/types/ai/settings.ts`, `packages/backend/src/services/ai/resolution-ladder.ts`, `packages/frontend/src/common/const/ai-features.ts` + i18n `common.aiFeatures.*`, `settings.ai.modelGuide.*` (`en` + `uk`)
- Modify: `packages/backend/src/services/user-settings/ai-feature-settings.e2e.ts`, `packages/backend/src/services/ai/ai-model-resolver.unit.ts`, `packages/frontend/src/composable/use-ai-feature-access.test.ts`

- [ ] write failing tests: both features listed, saved and resolved; ladder defaults; the frontend registry covers every `AI_FEATURE`
- [ ] enum values `notification_parsing` and `duplicate_matching`; cheap fast ladder defaults; copy (the owner approves it)
- [ ] gate: unit `--testPathPattern='ai-model-resolver'`; e2e `--testPathPattern='user-settings/ai-feature-settings.e2e'`; frontend `--run src/composable/use-ai-feature-access.test.ts`

### Task 4: Parsers and the AI daily limit

**Files:**

- Create: `packages/backend/src/services/ingest/event/{parse-wallet-notification,parse-notification-with-ai,notification-prompt,classify-notification,ai-daily-limit}.ts` + unit specs, `fixtures/notifications.ts` (Wallet; Georgian, Russian, Ukrainian and English bank pushes, SMS and an email; debit, credit, decline, promo, FX, settlement, a personal message with an amount)

- [ ] write failing unit tests (`jest.mock('ai')`):
  - the Wallet parser accepts the amount layouts and rejects refunds and other apps;
  - the AI output maps kinds to directions; a confidence below 0.6 → `lowConfidence`; invalid fields are treated as missing;
  - no client → `aiUnavailable`; a spent allowance → `aiCapReached`; the daily counter at its limit → `aiLimitReached`, and the AI is not called
- [ ] `parseWalletNotification`. `parseNotificationWithAi` uses `createAIClient(notificationParsing)`, `generateText` + `Output.object`, `aiCallGuards`, `trackAiUsage` (spend counts toward the cap) and `resolveAiExtractionFailure`. `classifyNotification` composes the parsers and returns `parsed`. `aiDailyLimit` is a Redis counter, also used by the judge.
- [ ] gate: unit `--testPathPattern='ingest/event/(parse|classify|ai-daily-limit|notification-prompt)'`

### Task 5: Processing job and the shared logging core

**Files:**

- Create: `packages/backend/src/services/ingest/log-ingested-payment.ts`; Modify: `packages/backend/src/services/ingest/card-payment/process-card-payment.ts`
- Create: `packages/backend/src/services/ingest/event/{process-notification,resolve-notification-account}.ts`
- Modify: `packages/backend/src/services/ingest/card-payment/{process-ingest-request,list-requests,retry-request,format-summary}.ts`, `packages/backend/src/crons/ingest-requests-cleanup.ts`
- Create: `packages/backend/src/services/ingest/event/process-notification.e2e.ts`

- [ ] write failing e2e (AI over MSW, delay shortened):
  - a Wallet notification is logged with no AI;
  - a bank push debit becomes an expense and a credit becomes income, with payee and history category;
  - non-payment kinds are stored `ignored` with title, subtitle, body and `raw` wiped;
  - an SMS from a pending sender parks without an AI call; approving the sender logs it; muting deletes the text;
  - the `aiUnavailable`, `aiCapReached` and `aiLimitReached` parks, each followed by a successful retry;
  - `ownTransfer`/`lowConfidence` parks, and `force` logs them;
  - FX with `originalAmount`;
  - a connected account → a planned row;
  - retention deletes `ignored` and pending requests after 7 days
- [ ] write failing e2e for account resolution: Wallet title → card link; digits → `lastDigits`; source default; none → `unknownAccount` with a guess, then logged after linking
- [ ] extract `logIngestedPayment`; the existing card-payment e2e tests stay green without changes
- [ ] `processNotification`, with pass-through dedup hooks until Tasks 7–8; one in-app notification per source for `unknownAccount` and for a new pending sender
- [ ] gate: e2e `--testPathPattern='(ingest/event/process-notification|ingest/card-payment/(ingest-card-payment|processing|requests|ai-categorization)|crons/ingest-requests-cleanup).e2e'`; unit `--testPathPattern='ingest'`

### Task 6: Source and card-link settings

**Files:**

- Create: `packages/backend/src/controllers/ingest/notification-sources.controller.ts`; Modify: `packages/backend/src/routes/user.route.ts`, `packages/backend/src/services/ingest/card-mappings.service.ts`, `packages/backend/src/controllers/ingest/card-mappings.controller.ts`
- Create: `packages/backend/src/services/ingest/event/notification-sources.e2e.ts`; Modify: `packages/backend/src/services/ingest/card-mappings.e2e.ts`

- [ ] write failing e2e: list sources (empty, then with counters); set the mode and default account (only owned, active accounts; 404 for another user's); delete; `lastDigits` validation and a 409 on a duplicate
- [ ] implement; guard exemptions with reasons
- [ ] gate: e2e `--testPathPattern='ingest/(event/notification-sources|card-mappings).e2e'`

### Task 7: Tier-1 twin and enrichment

**Files:**

- Create: `packages/backend/src/services/ingest/dedup/{constants,source-slots,find-twin,enrich-twin}.ts` + unit specs, `twin.e2e.ts`
- Modify: `packages/backend/src/services/ingest/log-ingested-payment.ts`, `packages/backend/src/services/ingest/event/process-notification.ts`

- [ ] write failing unit tests: slots for tap, Wallet notifications, bank sources with a stage, and legacy `externalData.cardPayment` rows; the twin rule (exact amount, original amount, window, taken slot, `isSameShop` veto, ambiguity)
- [ ] write failing e2e:
  - tap → Wallet → push → SMS ends as one row with four sources, and other orders give the same result;
  - two identical coffees stay two rows;
  - a USD tap on a GEL manual account takes the bank's GEL amount, and the balance moves by the difference;
  - the payee is filled and a second spelling becomes an alias;
  - a settlement attaches to its authorization;
  - the request records `matchedBy: 'twin'`
- [ ] implement under the per-user lock in both paths; attach through `updateTransaction`
- [ ] gate: unit `--testPathPattern='ingest/dedup'`; e2e `--testPathPattern='ingest/(dedup/twin|card-payment/(ingest-card-payment|processing)|event/process-notification).e2e'`

### Task 8: AI duplicate judge

**Files:**

- Create: `packages/backend/src/services/ingest/dedup/{judge-duplicates,judge-prompt,find-judge-candidates}.ts` + unit spec, `judge.e2e.ts`; Modify: `packages/backend/src/services/ingest/event/process-notification.ts`

- [ ] write failing unit tests: short-id round trip, unknown ids dropped, clamping, threshold mapping, no client or a spent limit → no match
- [ ] write failing e2e: 0.95 → attach (`matchedBy: 'ai'`); 0.7 → a new row plus an `open` suggestion; 0.3 → a new row; candidates exclude taken slots and other accounts
- [ ] implement with `AI_FEATURE.duplicateMatching`; usage is tracked and counted against the daily limit
- [ ] gate: unit `--testPathPattern='ingest/dedup/judge'`; e2e `--testPathPattern='ingest/dedup/(judge|twin).e2e'`

### Task 9: Reconciliation for manual accounts and ingest plans

**Files:**

- Modify: `packages/backend/src/services/transactions/reconciliation/{helpers,merge-transactions,restore-transactions,get-history}.ts`, `reconciliation.e2e.ts`, i18n `transactions.reconciliation.*` (`en` + `uk`)
- Create: `packages/backend/src/services/ingest/dedup/choose-survivor.ts` + unit spec
- Modify: `packages/frontend/src/pages/optimizations/reconciliation/block-reasons.ts` + test

- [ ] write failing e2e:
  - on a manual account, merge and remove change the balance and `Balances` history, and restore reverses both;
  - bank rows stay as they are today;
  - an ingest plan merges into a booked row, and the reverse is rejected;
  - a user plan is still rejected;
  - `planEditMerge` moves a manual category, and a conflict rejects the merge
- [ ] implement; history entries carry the suggestion's confidence, reason and `auto` flag; the frontend block reasons mirror the backend rules
- [ ] gate: e2e `--testPathPattern='transactions/reconciliation/reconciliation.e2e'`; unit `--testPathPattern='choose-survivor'`; frontend `--run src/pages/optimizations/reconciliation`

### Task 10: Suggestions and the scan job

**Files:**

- Create: `packages/backend/src/services/transactions/reconciliation/duplicate-suggestions.ts` + e2e, `packages/backend/src/services/ingest/dedup/{duplicate-scan-queue,event-listeners}.ts`
- Modify: `packages/backend/src/controllers/transactions.controller/{reconciliation,reconciliation-schemas}.ts`, `packages/backend/src/routes/transactions.route.ts`, `packages/backend/src/services/transactions/delete-transaction.ts`, `packages/backend/src/services/import-export/statement-parser/execute-import.service.ts`, `packages/backend/src/tests/helpers/reconciliation.ts`
- MCP: `list-duplicate-suggestions`, `dismiss-duplicate-suggestion` through the `add-mcp-tool` skill

- [ ] write failing e2e:
  - list (empty, then open pairs with the suggested survivor);
  - dismiss for good;
  - a merge marks the suggestion `merged`, and a delete marks it `stale`;
  - a sync next to an unsettled ingest plan produces a suggestion;
  - two ingest rows at 0.95 are auto-merged and show in history;
  - an imported row is only ever suggested
- [ ] implement the scan: only accounts with ingest rows in the window; the AI only when SQL finds candidates; the daily limit applies
- [ ] gate: e2e `--testPathPattern='(transactions/reconciliation/(duplicate-suggestions|reconciliation)|ingest/dedup/(judge|twin)).e2e'`; unit `--testPathPattern='(reconciliation-tools|mcp)'`

### Task 11: Frontend: Reconciliation Suggestions tab

**Files:**

- Create: `packages/frontend/src/pages/optimizations/reconciliation/components/{suggestions-tab,suggestion-card}.vue` + specs; `packages/frontend/e2e/tests/reconciliation/suggestions.spec.ts`
- Modify: `index.vue`, `use-reconciliation.ts`, `components/{merge-dialog,history-tab}.vue`, `packages/frontend/src/api/transactions.ts`, `packages/frontend/src/common/const/vue-query.ts`

- [ ] failing vitest:
  - a count badge on the tab;
  - pairs shown side by side with sources, confidence and reason;
  - **Merge** opens the existing dialog with the suggested survivor; **Not duplicates** dismisses;
  - an empty state;
  - history shows "Merged automatically" with the reason
- [ ] implement (container queries); i18n `optimizations.reconciliation.suggestions.*` (`en` + `uk`)
- [ ] Playwright: merge a suggestion, then restore it from history
- [ ] gate: `npm run test:unit -- --run src/pages/optimizations/reconciliation`; typecheck, lint

### Task 12: Frontend: version-aware setup on the Apple Pay page

**Files:**

- Create: `packages/frontend/src/pages/accounts/integrations/apple-pay/components/{ios-version-picker,triggered-shortcut-setup,notification-sources,pending-senders}.vue` + specs, `composables/use-ios-version.ts` + spec
- Modify: `apple-pay-details.vue`, `apple-pay.ts`, `components/{setup-checklist,add-shortcut-button,card-link-dialog,card-links,waiting-payments,payment-request-summary}.vue`, `packages/frontend/src/api/ingest.ts`
- Create: `packages/frontend/e2e/tests/integrations/notification-sources.spec.ts`

- [ ] failing vitest:
  - **version:**
    - the iOS version is read from the user agent (`iPhone OS 27_…`); on other devices the user chooses "iOS 27 or later" or "Earlier", and the choice is remembered in `localStorage` behind try/catch;
    - iOS 27+: **Add Shortcut** for `log-payments.shortcut` plus a checklist:
      - turn on the built-in triggers (Wallet transaction; notifications from Wallet);
      - add apps to the notification trigger: the bank's app, Messages for bank SMS, the mail app for bank email;
      - set **Run Immediately** if iOS asks.

      It also explains the on-device amount gate and what is sent.
    - earlier iOS: today's file and three-step checklist; the `limitation` callout points to iOS 27;
    - each file's button stays hidden while the file is missing (HEAD probe, as today)
  - **sources:** app or app · sender, mode, default account, counters, last seen, mute/delete; **Pending senders** with Approve/Mute and the number of waiting notifications;
  - **lists:** the card link dialog's **Last digits** field; waiting and recent lists show notification kinds, the new reasons, **Log anyway**, and a link to the AI settings for `aiUnavailable`/`aiCapReached`
- [ ] i18n `settings.integrations.applePay.notifications.*` (`en` + `uk`; the owner approves the copy)
- [ ] Playwright: an SMS from a pending sender (AI mocked over the API) is approved and logged
- [ ] gate: `npm run test:unit -- --run src/pages/accounts/integrations`; typecheck, lint

### Task 13: iOS 27 shortcut with built-in triggers

⚠️ Blocked on a fuller device sample from iOS 27, exported as XML. It must show:

- the Wallet Transaction trigger (identifier and parameters, all cards);
- the Notification trigger with the App parameter set: one app, several apps, and "any app" if iOS offers it;
- the Notification input's property names (app, bundle id, title, subtitle, body, date);
- whether "Run Immediately" is part of the trigger;
- whether `shortcuts sign` keeps `WFWorkflowTriggers` and the import keeps them active.

**Files:**

- Create: `packages/frontend/scripts/shortcuts/shortcut-plist.ts` (helpers moved out of `build-card-payment-shortcut.ts`), `packages/frontend/scripts/shortcuts/build-payments-shortcut.ts` + spec, `fixtures/triggers-input.xml` (the device capture), `packages/frontend/shortcuts/log-payments.plist`
- Modify: `packages/frontend/package.json` (`shortcuts:build` builds both shortcuts), `packages/frontend/public/shortcuts/README.md`, the Task 4 fixtures (real samples)

- [ ] failing spec:
  - XML drift check;
  - `WFWorkflowTriggers` holds a Wallet Transaction trigger and a `WFNotificationTrigger`, serialized like the fixture;
  - the URL rewrite (`card-payment` → `event`) on a decoded setup code;
  - the embedded gate equals `AMOUNT_GATE_PATTERN`, and `AMOUNT_GATE_SAMPLES` pass through the same regex;
  - a run with no input sends `dryRun`
- [ ] generator flow:
  1. setup code → decode → URL rewrite;
  2. no input → dry run;
  3. a Wallet transaction input (Merchant or Card present) → send its fields with `kind: walletTransaction`;
  4. otherwise Match Text with the gate on title + subtitle + body; no match → Stop; a match → send app, bundle id, title, subtitle, body, date and the remaining properties as `raw`, with `kind: notification`;
  5. key = SHA-256 of `<input fields>|<date, or the run time to the minute>`;
  6. POST, then show `summary` only when `notify` is true
- [ ] add the real samples to the parser fixtures and re-run Task 4's tests
- [ ] gate: `npm run test:unit -- --run scripts/shortcuts`; backend unit `--testPathPattern='(ingest/event|amount-gate)'`

### Task 14: Verify acceptance criteria

- [ ] a payment seen by tap, Wallet notification, bank push and bank SMS, in any order, leaves one row with every source, the bank's amount and the Wallet merchant's payee
- [ ] an online Apple Pay payment is logged from the Wallet notification alone; a chat, an OTP and a promo never create a stored request with text
- [ ] the limits hold: hourly/daily → 429, AI daily → `aiLimitReached`, usage cap → `aiCapReached`; Wallet still logs without AI
- [ ] an ambiguous pair is merged from the Suggestions tab; an auto-merge shows in history and restores; the manual account's balance is right after each
- [ ] a bank sync and a statement import next to ingest rows create no duplicate rows (the plan is settled) or a suggestion
- [ ] backend: `npm run test:unit` (full); e2e `--testPathPattern='(ingest|transactions/reconciliation|planned-matching|duplicates-detection|ai-categorization|user-settings/ai-feature-settings|backup|mcp|crons/ingest-requests-cleanup|routes/base-currency-guard-coverage)'`
- [ ] frontend: typecheck, lint, `npm run test:unit -- --run`; Playwright `integrations/` and `reconciliation/` when the dev stack is up
- [ ] root: `npm run format:check`, `npm run knip`

### Task 15: [Final] Update documentation

- [ ] `packages/docs/src/content/docs/integrations/notifications.mdx` (new, per the `user-docs` skill):
  - iOS 27 and the built-in triggers;
  - which apps to add (bank app, Messages, mail);
  - what is logged, ignored, dropped and parked;
  - account matching (card name, last digits, source default);
  - privacy: the on-device gate, the server prefilter, pending senders, what reaches the AI provider, what is stored and for how long;
  - limits;
  - troubleshooting
- [ ] `integrations/apple-pay.mdx`: the two shortcuts and which iOS each one is for
- [ ] `transactions/reconciliation.mdx`: Suggestions, automatic merges, manual-account rows
- [ ] `packages/backend/docs/card-payment-ingest.md`: the event endpoint, kinds, prefilter, limits, slots, the twin rule, the judge and the scan; `services/bank-data-providers/docs/architecture.md`: reconciliation now covers manual rows and ingest plans
- [ ] `self-hosting/docs/environment-reference.md`: `INGEST_AI_DAILY_LIMIT` and the event rate limits
- [ ] `cd packages/docs && npm run build` with the link validator passing
- [ ] move this plan to `docs/plans/completed/` after Task 14 passes (Task 13 may stay open under ⚠️)

## Post-Completion

_Items requiring manual work or external systems; no checkboxes._

**Device capture (owner, with the orchestrator), before Task 13:** export from the Mac, as XML, a shortcut that has:

- the Wallet Transaction trigger;
- a Notification trigger with one app, then several apps (Wallet, Messages, TBC Bank, a mail app), and "any app" if offered;
- a body that saves the Shortcut Input so its property names show.

Also collect real texts: Wallet (in-store, in-app, online, refund), a TBC push, a TBC SMS, a TBC email (card payment, transfer out, incoming transfer, OTP, decline, promo, settlement). Redact codes and balances before committing.

**Signing:** sign `log-payments.plist` on the Mac as in `public/shortcuts/README.md`. Import it on the phone and check that the triggers survive signing and import, then run it once by hand for the dry-run line.

**Cloudflare Access for `money.nemirovsky.dev`:** the path-scoped Service Auth app covers `/api/v1/ingest/card-payment`. Widen it to `/api/v1/ingest/` with the same service token, then check that an anonymous request gets 403 and one with the headers reaches the app.

**Deployment:** build images from this branch, back up the database and migrate. Configure AI connections for `notificationParsing` and `duplicateMatching`, or rely on the defaults, and set `INGEST_AI_DAILY_LIMIT` if 300 does not fit.

**Upstream:** offer it after the Apple Pay ingest lands, in four parts: the endpoint, parsing and dedup (Tasks 1–10); the reconciliation UI (Task 11); the setup UI and the shortcut (Tasks 12–13); the docs.
