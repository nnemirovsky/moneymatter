# Payment ingest from iOS notifications, with AI parsing and dedup

## Overview

iOS 27 brings two changes to Shortcuts:

- the personal-automation trigger **"When I receive a notification from <app>"** (with optional Title, Subtitle and Message filters);
- **Unified Automations**: triggers live inside the shortcut (`WFWorkflowTriggers` in the plist) and travel with it when it is shared.

With both, MoneyMatter can log payments that the Wallet **Transaction** trigger never sees. Wallet notifications cover Apple Pay inside apps and on websites. Bank notifications cover plain card payments, ATM withdrawals, transfers, refunds and incoming money, whether they come as an app push (TBC Bank for the owner), a bank SMS in Messages or a bank email, in any format and language.

The plan delivers:

1. **Two downloadable shortcuts:**
   - **iOS 27+:** one shortcut, "MoneyMatter: log payments", carrying **both triggers**: the Wallet Transaction trigger, and one Notification trigger as broad as iOS allows. If the device cannot express "any app", the fallback is a short list of apps the user picks (Wallet, Messages, the bank's app, the mail app).
     - The shortcut stays dumb. It forwards the raw input with a `kind` that says which trigger fired.
     - An **on-device privacy gate** made of the built-in **Match Text** (regex) and **If** actions drops notifications that show no amount. The gate works **without Apple Intelligence**; no "Use Model" or other Apple Intelligence action is involved.
   - **Older iOS:** today's tap-only "MoneyMatter: log card payment" and its manual automation steps, unchanged.
2. **`POST /api/v1/ingest/event`:**
   - `kind: walletTransaction` runs the existing card-payment pipeline.
   - `kind: notification` passes a **server prefilter** (an amount pattern, OTP and promo markers) before anything is stored or sent to an AI, then is processed by a job.
   - The request waits up to a budget for the result, so the shortcut shows **a banner** like the tap one ("Logged …", "Already logged …", "Queued, will appear shortly"). Ignored notifications show none.
3. **Parsing:** Wallet's fixed layout is parsed in code, everything else by a new AI feature, `notificationParsing`. It reuses the AI connections, the feature config, the model choice, the monthly usage cap and the usage tracking. The same AI step **resolves the payee** against the user's existing payees and aliases, and records new spellings as aliases so the next match needs no AI.
4. **Privacy and limits:**
   - Dropped and non-payment notifications are never stored with their text; only per-source counters remain.
   - Per-user caps apply: 120 an hour and 1000 a day, plus 300 AI calls a day shared by parsing and the duplicate judge.
   - Senders in messaging and mail apps reach the AI only after the user approves them.
   - The gate's strictness is configurable.
5. **Account resolution** by Wallet card name, the card's last digits or the source's default account. A request matched by none of these waits for the user; the server never guesses an account.
6. **Dedup.** One payment can arrive four or more times (tap, Wallet notification, bank push, bank SMS), minutes to hours apart, and again later from bank sync or a statement import.
   - Only the deterministic **exact twin** acts automatically: it attaches a later source to the existing row and enriches it.
   - Every **AI-judged** match (new AI feature `duplicateMatching`) becomes a **suggestion**. Accepting it uses the existing **Reconciliation** merge, history and restore. There is no AI auto-merge.
7. **Automation inbox:** a MoneyMatter-owned chat thread where everything that needs the user arrives as a **proposal card**: own-account transfers, unknown accounts, low-confidence parses, new senders and duplicate suggestions.
   - The thread is **pinned**, and it cannot be deleted while it is live.
   - Cards use the existing approve/edit/reject flow.
8. **Web push for the assistant:** a new push group, `assistant` (on by default), covering:
   - finished AI chat replies and waiting chat cards, sent only when the user is not viewing that thread;
   - new inbox items, collapsed into one push with a count;
   - parked ingests that have no card.

   Pushes are debounced per thread, deep-link to the thread or page, and can be turned off with the group's toggle in notification settings.
9. **Bank balances** in notifications are stored with an `authoritative` flag. When the same bank holds several non-zero currency balances, the stated balance is probably a total and stays informational.
10. **Setup UI** on the page renamed from "Apple Pay" to **"iOS Automation"** (Accounts → iOS Automation). It shows the shortcut and instructions for the user's iOS version, detected from the user agent where possible, otherwise picked by the user.
11. **Docs.**

Out of scope: Android, own-account transfer pairing, balance-drift alerts (the balance is stored only), and changes to the planned-row settlement rules of the Apple Pay plan.

Work happens in the fork on `feat/notification-ingest` (from `dev`). Names stay generic and nothing is owner-specific, so it can go upstream after the Apple Pay ingest.

## Context (from discovery)

- **Ingest pipeline** (`packages/backend/src/services/ingest/card-payment/`, plan `docs/plans/completed/20261017-apple-pay-ingest.md`):
  - Route `routes/ingest.route.ts`: `authenticateIngestToken({ scope: INGEST_SCOPES.transactions })` → `checkBaseCurrencyLock` → `ingestTokenRateLimit` (30/min per token) → `controllers/ingest/card-payment.controller.ts` → `ingestCardPayment`.
  - The pipeline runs in three transactions:
    - tx 1, `record-request.ts`, writes `IngestRequests` (unique `(userId, idempotencyKey)`);
    - tx 2, `process-ingest-request.ts`, takes a row lock and applies the 120 s repeat window (`computeFingerprint`, `pg_advisory_xact_lock`);
    - tx 3, `park-failed-request.ts`.
  - `process-card-payment.ts` does mapping, currency, conversion, payee (`resolvePayeeForIncomingRow`, threshold 1), history category, then `createTransaction` (planned on connected accounts, `externalData.cardPayment`).
  - The answer waits up to `cardPaymentTimings.aiWaitBudgetMs` (8 s, polling every 250 ms) for AI categorization.
  - Shared types live in `packages/shared/src/types/ingest/`.
  - The setup code (`card-payment-setup-code.ts`) is `v1.` + base64 JSON `{ v, url, token, cfAccessId?, cfAccessSecret? }`. The decoder ignores unknown keys, so new optional keys stay compatible.
  - `IngestSettings` holds the Cloudflare Access headers. Card links are `CardAccountMappings`.
  - Retention: `crons/ingest-requests-cleanup.ts`.
  - Migration `20261017020000-card-payment-ingest.ts` is already on `dev`, so this branch adds a new one (repo rule 11).
- **Payees:**
  - `Payees`, plus `PayeeAliases` (`payeeId`, `rawName`, `normalizedName`) and `PayeeIgnoredNames`.
  - `services/payees/`: `normalizePayeeName`, `resolveNormalizedName` (exact name/alias lookup), `ensureAliasExists`, `isPayeeNameIgnored`, the Fuse matcher (`buildHaystack`, `buildFuzzyIndex`, `fuzzyFindBestMatch`, `FUZZY_MATCH_THRESHOLD` 0.4), and `resolvePayeeForRawMerchant`.
  - MCP tools: `update-payee` (renaming keeps the old name as an alias), `delete-payee-alias`, and the payee chat previews (`merge-payees`, `ignore-payee-name`).
  - No `pg_trgm` index exists.
- **Reconciliation** (`services/transactions/reconciliation/`, routes `/transactions/reconciliation/*`):
  - Services: `mergeTransactions`, `removeTransactions`, `restoreTransactions`, `getReconciliationHistory`.
  - `loadReconcilableRows` rejects **system rows (manual accounts)** and **planned rows**.
  - `softDeleteTransactions` skips hooks, so on a manual account the removed amount would stay in the balance (`@BeforeDestroy` is what normally calls `updateAccountBalanceForChangedTx` + `Balances.handleTransactionChange` for `ACCOUNT_TYPES.system`).
  - Nothing is persisted as a suggestion.
  - MCP tools `merge-duplicate-transactions` and `remove-duplicate-transactions` back the chat tools `merge_duplicate_transactions` and `remove_duplicate_transactions`. Their preview lives in `services/chat/proposals/previews/reconciliation.ts`, which refuses planned rows.
  - Frontend: `pages/optimizations/reconciliation/` (`block-reasons.ts`, `merge-dialog.vue`). Edit-merge policy: `planEditMerge`.
- **Chat proposals** (`services/chat/proposals/`):
  - `ChatProposals` (`threadId`, `messageId`, `toolName`, `args`, `preview` with `before`/`after`, `snapshot`, `status`, `expiresAt`) are created by `createProposal({ run, policy, args, meta, refs, sources })`, which needs a toolkit run.
  - `approve`, `edit`, `reject`, `card-expiry`, the policies (`services/chat/policies/`, with the `chat-capabilities-drift.unit.ts` drift guard) and preview resolvers (`previews/`).
  - `ChatThreads` has no kind column and an optional `connectionId`. `ChatMessages.role` is `user | assistant`.
  - Frontend routes: `chat`, `chatThread`.
- **Notifications and web push:**
  - `services/notifications` creates a row and calls `enqueueWebPushAfterCommit`.
  - `NOTIFICATION_TYPES` and `NOTIFICATION_PUSH_GROUP` / `PUSH_GROUPS` live in `packages/shared/src/types/{notifications,web-push}.ts`; `isPushGroupEnabled` holds the per-group preference.
  - The frontend deep link is built by `components/notifications-popover/build-notification-route.ts`.
  - **Push groups today:** `reminders`, `bankSync`, `sharing`, `system`, `releases`.
    - `NOTIFICATION_PUSH_GROUP` is total, so a new type does not compile until it has a group.
    - `render-push-body.ts` renders per type, `build-push-payload.ts` sets `tag: notification.id`, and `push-queue.ts` runs a fan-out job and then a delivery job.
    - The settings toggles are `pages/settings/subpages/notifications/components/push-groups-card.vue`.
    - There is no chat or ingest type yet.
  - **No presence signal for a thread:**
    - `services/common/sse/sse-manager.ts` keeps one SSE connection per user (`/events`), not per thread;
    - chat runs stream on their own endpoint, `GET /chat/runs/:runId/events` (`runs/tail-hub.ts`);
    - `pageContext` is stored per user message, for the prompt only.
- **Chat threads:**
  - `ChatThreads.pinned` exists: pinned threads list first (`threads/list.service.ts`) and never expire (`computeThreadExpiry`).
  - `PATCH /chat/threads/:id` updates the title and the pin, and `DELETE` removes a thread.
  - There is no archive.
- **AI:**
  - `createAIClient`, `generateText` + `Output.object`, `aiCallGuards`, `trackAiUsage` → `recordAiSpend`.
  - Monthly usage cap (upstream `008b2cfef`, `ai-allowance.ts`): the resolver offers server keys only while `isWithinAiAllowance`, and `connection-failure.ts` tells an exhausted cap apart from a missing connection.
  - `createShortIds`.
  - E2E tests mock AI over MSW (`createGeminiMock`, `getCustomEndpointContentMock`).
  - Template: `services/trackers/smart-tracking/run-tracker-scan.ts`.
- **Accounts:** `Accounts.bankDataProviderConnectionId` links accounts of one connection. User-defined groups live in `models/accounts-groups/`. Each account has one currency.
- **Frontend setup page:** route `/accounts/integrations/apple-pay` (`ROUTES_NAMES.accountApplePay`, `pages/accounts/integrations/apple-pay/apple-pay-details.vue`). The settings route `integrations/*` redirects to it. Its i18n lives in the `settings/integrations` chunk (`settings.integrations.applePay.*`). Docs: `packages/docs/src/content/docs/integrations/apple-pay.mdx`.
- **Shortcut generator:** `packages/frontend/scripts/shortcuts/build-card-payment-shortcut.ts`, a deterministic plist with a drift spec and the device fixture `fixtures/transaction-input.xml`. The signed file is `public/shortcuts/log-card-payment.shortcut`.
- **iOS 27 facts so far** (owner's iPhone, `WFWorkflowClientVersion` 5037.111):
  - **Known:**
    - `WFWorkflowTriggers` is an array of `{ WFTriggerIdentifier, WFTriggerSerializedParameters, WFTriggerUUID }`.
    - The Notification trigger is `WFNotificationTrigger`.
    - Its filters serialize as `Conditions` → `WFContentPredicateTableTemplate` with `WFActionParameterFilterTemplates` entries of the form `{ Operator, Property: 'Title', Removable, Values }`.
  - **Unknown:**
    - the App parameter's serialization, and whether "any app" exists;
    - the Wallet Transaction trigger's identifier;
    - the Notification input's property names;
    - whether "Run Immediately" is stored in the trigger;
    - whether signing keeps the triggers.
  - Wallet sample: title `TBC Bank` (the Wallet card name), subtitle `Wolt`, body `GEL 43.60`.

## Decisions

- **One iOS 27 shortcut, both triggers.**
  - The shortcut branches on its input. Input with a Merchant or a Card means a Wallet transaction, and the shortcut sends `kind: walletTransaction` with those fields. Otherwise it treats the input as a notification: it runs the gate, then sends `kind: notification`. `kind` is required on the event endpoint, so the server never guesses.
  - The Notification trigger is configured as "any app" if iOS allows it; otherwise it is pre-filled with Wallet, and the checklist asks the user to add Messages, their bank's app and their mail app to the same trigger.
  - The URL comes from the setup code: its `url` with the last path segment replaced (`card-payment` → `event`). Existing setup codes keep working, and the user pastes one code.
  - iOS < 27 keeps the tap-only shortcut and the manual automation; nothing changes for it.
- **The banner answer: record, enqueue, then wait on a budget.** The event endpoint records the request (tx 1), enqueues the `ingest-notification` job with `jobId = requestId` and **no delay**, then polls the request row for up to `notificationWaitBudgetMs` (10 s, 250 ms steps). This mirrors `aiWaitBudgetMs`. The outcome decides the banner:

  | Outcome | Banner | `notify` |
  |---|---|---|
  | logged | "Logged 43.60 GEL at Wolt → Food" | true |
  | attached to a twin | "Already logged 43.60 GEL at Wolt" | true |
  | parked | "Needs your OK in MoneyMatter: 43.60 GEL at Wolt" | true |
  | still running | "Queued, will appear shortly" | true |
  | ignored or dropped | — | false |

  - **Why a job plus a wait, not inline processing:** the job gives retries with backoff for AI outages, survives a process crash, serializes AI calls through the queue's concurrency, and is the same path a retry from the UI takes. The request only waits on it. A synchronous AI call inside the request would lose the payment on a timeout and hold an HTTP worker for the AI's latency.
  - **Why no delay:** the tier-1 twin check runs under one per-user lock in both the tap path and the notification job, so arrival order does not matter. AI never attaches anything, so no settling time is needed.
- **Three privacy layers:**
  1. **On-device gate.** The shortcut runs **Match Text** on title + subtitle + body; **If** there is no match, it stops. This uses only built-in Shortcuts actions and needs no Apple Intelligence.
     - The regex is defined once in `packages/shared` (`amount-gate.ts`, ICU syntax, which Shortcuts and JavaScript both accept, `\p{Sc}` included). It comes with a shared sample fixture.
     - The setup code carries the user's pattern in a new optional `gate` field. The shortcut falls back to the built-in standard pattern when the field is missing, so changing strictness needs a new setup code, not a new signed file.
  2. **Server prefilter**, run before anything is stored, against the same pattern:
     - no amount → dropped (`noAmount`);
     - an OTP marker (code, OTP, 3-D Secure, password, код, კოდი, … in per-language lists) together with a standalone 4–8 digit code → dropped (`security`). This includes 3-D Secure confirmations that show the amount;
     - a strong promo marker with no card digits or balance → dropped (`promo`);
     - a muted source → dropped (`muted`).

     A dropped notification is answered `200 dropped` and **not stored**; only the source's counter for that reason and its `lastSeenAt` change.
  3. **Conversational apps** (Messages, mail apps, messengers; a list of bundle ids and names):
     - each sender is its own source (app + title) and starts as `pending`;
     - a notification from a pending sender parks as `senderNotApproved` without an AI call, and an inbox card asks whether to approve the sender;
     - approving processes what the sender parked; muting deletes it;
     - pending requests are deleted after 7 days.
- **Configurable gate strictness** (`IngestSettings.gateStrictness`, default `standard`):
  - `strict`: an ISO code or currency symbol right next to the number;
  - `standard`: also local currency words (грн, руб, лари, zł, kr, Kč, …) and a symbol or code up to 3 characters away;
  - `loose`: also a decimal number with two decimals and no currency, for banks that never print one.

  The server prefilter uses the user's level. The UI warns that `loose` lets more private text through and that a new setup code is needed after a change.
- **Retention:**
  - Non-payment notifications the AI classifies keep only the fingerprint hash, kind and reason. Their title, subtitle, body and `raw` are wiped in the same transaction, and the row is deleted after 7 days.
  - Payment notifications keep their raw text for review and retry under the existing 90-day retention.
- **Limits:**
  - The existing 30/min per token stays.
  - `ingestEventRateLimit` per user: 120 accepted notifications an hour and 1000 a day, counted after the prefilter. Over it, the answer is 429 and the source counter records it.
  - `INGEST_AI_DAILY_LIMIT`: 300 calls per user per day (env-configurable, a Redis counter), shared by parsing and the duplicate judge. Over it, the request parks as `aiLimitReached`.
  - When the monthly usage cap stops server keys, `createAIClient` returns `null`. The request parks as `aiCapReached`, detected as `connection-failure.ts` does, instead of `aiUnavailable`.
  - Every call goes through `trackAiUsage`, so spend counts toward the cap and cap hits are tracked. Wallet notifications need no AI.
- **What gets logged** (AI `kind`):
  - `debit` → expense;
  - `credit` (refund, cashback, incoming transfer, salary, top-up) → income, because incoming money is real;
  - `declined`, `security`, `promo`, `info`, `other` → ignored, with the text wiped.
  - **Own-account transfers park for approval** (`ownTransfer`), as do parses with confidence below 0.6 (`lowConfidence`). Both arrive as inbox cards.
- **Wallet is parsed in code, everything else by AI.** A Wallet notification (bundle `com.apple.Passbook` or a localized app-name list) whose body is only an amount `parseAmount` accepts is a `debit`, with card = title and merchant = subtitle, and the payee is resolved by the existing `resolvePayeeForIncomingRow`. Other Wallet text, bank pushes, SMS and email go to `notificationParsing`. With no AI client at all, the request parks as `aiUnavailable`.
- **Two AI features:** `notificationParsing` and `duplicateMatching`, each with its own model choice and usage tracking, like every existing feature.
- **Payee resolution inside the parse call:**
  1. Before the call: if the raw merchant text already resolves through `resolveNormalizedName` (an exact name or alias), that payee is used and the AI's payee answer is ignored. Each saved alias therefore makes the next match deterministic.
  2. Otherwise the prompt gets up to 15 candidates (id alias, name, aliases):
     - payees whose name or alias shares a distinctive token with the notification text (tokens of 3 or more characters that are not digits and not `generic-merchant-words`; an `ILIKE` on `PayeeAliases.normalizedName` and `Payees` names, enough at personal-ledger scale without `pg_trgm`);
     - the Fuse top matches (`buildFuzzyIndex`) for each such token;
     - the 5 payees most recently logged from this source.
  3. The AI returns `payee: { candidateId } | { newName }`. The prompt has explicit rules:
     - pick a candidate only when it is the same business;
     - ignore processor prefixes (`SP *`, `SQ *`, `PAYPAL *`, `GOOGLE *`), domains (`.COM`), city or country suffixes, store numbers and casing;
     - never match on a generic word alone;
     - otherwise propose a clean display name: brand casing, no prefixes or locations.
  4. After the call: a chosen candidate gives the `payeeId`. When the raw merchant text normalizes differently from that payee's name, the server saves it with `ensureAliasExists`, unless it is ignored (`isPayeeNameIgnored`) or already resolves to another payee. With `newName`, the server creates the payee through the payee service, adds the raw text as its alias, and enqueues logo resolution as the resolver does.
- **Bank balances are not always authoritative.** `parsed.balanceAfter = { amount, currency, authoritative, scopeHint }`.
  - **"Same bank" for account A** is the union of: accounts on A's bank connection (`bankDataProviderConnectionId`); accounts the same source has logged to or defaults to; and accounts in A's account group.
  - **Authoritative** only when every same-bank account in another currency has a zero balance, or A has no same-bank account in another currency.
  - **The prompt is told** the currencies of the source's known accounts that hold non-zero balances. The AI then reports `scopeHint: 'total' | 'account' | 'unknown'`, and `total` always makes the balance non-authoritative.
  - A non-authoritative balance is informational only, never used for checks or reconciliation. Nothing uses an authoritative balance yet either; it is stored for a later drift check.
- **Sources** (`NotificationSources`): the key is the bundle id or the normalized app name, plus the sender for conversational apps. Each source has `mode` (`auto` | `pending` | `approved` | `muted`), `defaultAccountId` and counters. "Messages · TBC" and the TBC app are separate sources.
- **Account resolution, in order; an AI guess never logs:**
  1. Wallet card name → `CardAccountMappings`.
  2. Last digits → the new `CardAccountMappings.lastDigits`.
  3. The source's `defaultAccountId`.
  4. Otherwise park `unknownAccount`, with a heuristic guess (currency match plus a shared token with the source name) pre-filled in the inbox card's editable account field.
- **Dedup:**
  - **Source slots.** A row holds at most one request per slot: `tap`, `wallet-notification`, or `bank:<sourceKey>:<stage>` (`authorization` | `settlement` | `unknown`). Slots keep two identical coffees as two rows and let a bank's push and its SMS both attach to one row.
  - **Tier 1, exact twin: the only automatic attach.** It runs under a per-user advisory lock in both paths. A candidate qualifies only if all of these hold:
    - the same account and direction;
    - a free slot;
    - the exact amount in the same currency, or the same original amount and currency;
    - within 30 minutes;
    - no `isSameShop` veto;
    - and it is the only candidate that qualifies.

    The new request then attaches to that row (`matchedBy: 'twin'`), and the row is enriched.
  - **Tier 2, AI judge: suggestions only.** Candidates are within ±25 % or have the same original amount, up to 72 h apart, with at least one side from ingest.
    - In the notification job, a judged match with confidence ≥ 0.6 logs the row **and** stores a suggestion; below that, the row is simply logged.
    - The scan job (after `TRANSACTIONS_SYNCED` and after a statement import) only creates suggestions.
    - **There is no AI auto-attach and no AI auto-merge.**
  - **One record, shown in two places.** A `DuplicateSuggestions` row has a `proposalId` for its inbox card. Merging in Reconciliation or approving the card resolves both; dismissing or rejecting either dismisses both. A dismissed pair never comes back.
- **Enrichment on an attach or an accepted merge:**
  - The bank's account-currency amount replaces a converted tap or Wallet amount, and the charged currency stays as `originalAmount`. The change goes through `updateTransaction`, so the balance follows.
  - A missing payee is filled.
  - Spellings that differ become aliases.
  - `externalData.ingest.sources[]` lists every source; `balanceAfter` carries its flag.
  - User edits win. `planEditMerge` decides what moves on a merge, and a conflict blocks the merge with its reason.
- **Reconciliation widens:**
  - System rows become reconcilable, with balance-aware soft delete and restore (as `@BeforeDestroy` does).
  - Ingest plans become reconcilable, but never as the survivor when a booked row is in the merge.
  - The suggested survivor is a booked bank or imported row, else the earliest ingest row.
  - The chat preview `reconciliation.ts` follows the same rules.
- **Automation inbox (a MoneyMatter-owned chat thread):**
  - **The thread.** `ChatThreads.kind` is `chat` (the default) or `automationInbox`. An inbox thread has a fixed title ("Automation inbox"), `connectionId` null and **no AI runs**: it only shows cards, so it needs no AI connection. The composer is hidden and replaced by a link to start a normal chat. Each item is one `assistant` message (`provider` null, a short text from a template) plus one card.
  - **Live thread and rollover.** At most one inbox thread per user is **live**: the newest one, while it has at least one pending card or is less than 7 days old, and holds fewer than 200 cards. A new item goes into the live thread. When there is none, a new inbox thread is created and becomes live.
  - **Pinned.** The live thread uses the existing `pinned` flag, so it lists first and never expires. On rollover, one transaction unpins the old thread (its `expiresAt` is then computed by `computeThreadExpiry` as for any chat) and pins the new one.
  - **What the user can do:**
    - The live thread **cannot be deleted or unpinned**: `DELETE` and `PATCH { pinned: false }` answer 409 with a reason.
    - **Clear resolved** (`POST /chat/threads/:id/clear-resolved`) deletes the messages whose cards are no longer pending. The records behind those cards are untouched; they live in Reconciliation and the waiting list.
    - **Archive** (`POST /chat/threads/:id/archive`) ends the live thread early. It unpins the thread, and the next item opens a new one. It is refused with 409 while a card is still pending, so a pending card is never hidden.
    - A non-live inbox thread behaves like any chat thread: it can be deleted or pinned by hand.
  - **Cards** are created by a new `createSystemProposal({ userId, threadId, toolName, args })`. It resolves the policy and runs `computeCardState` (preview with `before`/`after`, snapshot) like `createProposal`, without a toolkit run. Inbox cards expire after 30 days; the underlying record stays open in Reconciliation or in the waiting list.

    | Item | Tool | Approve | Edit | Reject |
    |---|---|---|---|---|
    | duplicate suggestion | `merge_duplicate_transactions` (existing; the suggested survivor pre-set) | merge | — | dismiss the suggestion |
    | unknown account, own transfer, low confidence | new `log_ingest_request` (`requestId`, `accountId`, `direction`) | log it | account, direction | dismiss the request |
    | new conversational sender | new `set_notification_source` (`sourceId`, `mode`, `defaultAccountId`) | approve | default account | mute |
  - **Two-way sync.** One service (`inbox-items.ts`) links each card to its record: `DuplicateSuggestions.proposalId`, `IngestRequests.proposalId`, `NotificationSources.proposalId`. Resolving the record elsewhere (Reconciliation tab, waiting list, sources list) marks the card `rejected` with `statusReason: 'resolvedElsewhere'`.
  - **Push:** see the next decision; inbox items use the `automationInbox` type.
- **Web push for the assistant.** A new push group `assistant` (default **on**; `PUSH_GROUP_DEFAULTS`). Its notification types reuse the in-app `Notifications` → `enqueueWebPushAfterCommit` → `push-queue.ts` path, so each push is also an entry in the bell.

  | Type | When | Deep link | Collapse |
  |---|---|---|---|
  | `chatReplyReady` | an AI run in a `chat` thread finished, or failed, while the user was not viewing that thread | `chatThread` | one push per thread per 5 min |
  | `chatCardsWaiting` | a run in a `chat` thread left pending cards and the user was not viewing that thread | `chatThread` | merged with `chatReplyReady` for that run: one push that says "reply ready, 2 cards to approve" |
  | `automationInbox` | new inbox items | `chatThread` (the live inbox) | one push per 10 min with a count ("3 items need your OK") |
  | `ingestAttention` | a parked ingest **without a card**: `aiCapReached`, `aiLimitReached`, `aiUnavailable`, `rateUnavailable`, `processingFailed`, and the tap path's `unknownCard` | `accountIosAutomation`, waiting list | one push per reason per day |

  - **No double push.** An item that has an inbox card (unknown account, own transfer, low confidence, a sender pending, a duplicate suggestion) pushes only as `automationInbox`.
  - **Presence.** Neither existing signal tells which thread the user is looking at, so the frontend sends a heartbeat: `PUT /chat/presence { threadId }` every 20 s while a thread page is visible and focused (`document.visibilityState` + `focus`), and `DELETE` when it leaves.
    - The heartbeat sets a Redis key `chat:presence:<userId>:<threadId>` with a 45 s TTL.
    - A push for a thread is skipped while its key exists. A run whose events stream is being read through the run endpoint counts as viewed too.
  - **Debounce.**
    - The first event for `(type, userId, threadId or reason)` schedules one delayed BullMQ job (`assistant-push`, delay 60 s, `jobId` = the collapse key plus the window start). Later events in the window only increment a Redis counter.
    - The job re-checks presence and whether the items are still pending, then creates one notification carrying the count.
    - A cooldown key enforces the per-row interval.
    - The web-push `tag` is `assistant:<threadId>` (or `assistant:ingest:<reason>`), so the OS replaces an older banner instead of stacking a new one. `build-push-payload.ts` takes a per-type tag.
  - **Read state.** Opening a thread marks its `chatReplyReady`, `chatCardsWaiting` and `automationInbox` notifications read (by `payload.threadId`). Opening the iOS Automation page marks `ingestAttention` read.
  - **Bodies** are rendered in the user's locale by `render-push-body.ts`. They never contain the AI's reply text or notification text, only counts, the thread title and the reason.
- **The page is renamed "iOS Automation":**
  - Route `/accounts/integrations/ios-automation` (`ROUTES_NAMES.accountIosAutomation`). `/accounts/integrations/apple-pay` and the settings `integrations/*` redirect there.
  - The folder moves `pages/accounts/integrations/apple-pay/` → `ios-automation/`, and i18n moves `settings.integrations.applePay.*` → `settings.integrations.iosAutomation.*` (`en` + `uk`; other locales fall back to English until Crowdin syncs).
  - The docs page moves to `integrations/ios-automation.mdx`, with a redirect from `apple-pay` in `astro.config.mjs`.
  - "Apple Pay" stays as the name of the tap trigger inside the page.
- **Requests share `IngestRequests`.** `source` is `card-payment` or `notification`. New status `ignored`; new reasons; `parsed` JSONB; `proposalId`. A notification request counts as interrupted after 30 minutes of `received`.

## Development Approach

- **Testing approach: TDD.** Each task writes failing tests first (unit, or e2e through HTTP helpers), runs them and records that they fail on assertions. In e2e, AI is mocked over MSW (`createGeminiMock`, `getCustomEndpointContentMock`); in unit tests, with `jest.mock('ai')`.
- **Node path:** prefix every node/npm command with `export PATH="$(mise where node@24.21.0)/bin:$PATH"`.
- **Commands:**
  - backend unit: `cd packages/backend && npm run test:unit -- --testPathPattern='<regex>'`;
  - backend e2e (never in parallel): `cd packages/backend && lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='<regex>'`;
  - frontend: `cd packages/frontend && npm run test:unit -- --run <path>`;
  - root: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run knip`.
- **Subagents and skills:** `test-runner` for tests, `linter` for lint, `i18n-editor` for i18n (`en` + `uk`), and the `add-mcp-tool` skill for MCP tools (the chat tools follow from their policies).
- **One task at a time.** Each gate names its tests. Repo rules apply: object params, kebab-case, comments describe the current code, `Money` everywhere, one migration for this branch.
- **Commits:** none by implementing agents unless the owner asks (repo CLAUDE.md rule 10).

## Testing Strategy

- **Unit:**
  - the gate patterns per strictness against the shared fixture (the same fixture runs in the shortcut spec);
  - the prefilter blocks;
  - kind validation and payload normalization;
  - the fingerprint;
  - the Wallet parser;
  - AI output validation, including payee choice and balance scope;
  - the payee candidate shortlist;
  - the balance authority rule;
  - the AI daily counter;
  - source keys;
  - account resolution order;
  - slots and the twin rule;
  - the judge mapping (suggestions only);
  - survivor choice;
  - the inbox rollover rule;
  - the push debounce and collapse keys;
  - presence key handling;
  - the push bodies for the new types (`render-push-body.unit.ts`).
- **E2E:**
  - **Endpoint:**
    - each banner outcome within the budget, and "Queued" when the job is slower;
    - `walletTransaction` through the card-payment pipeline;
    - dropped requests leave no row;
    - limits → 429;
    - 413 for a body over 16 KB, 409 for a reused key with a different body;
    - guard coverage.
  - **Processing:**
    - a Wallet notification without AI;
    - a bank push (debit and credit) and an SMS from an approved sender;
    - a pending sender, then approval;
    - text wiped for non-payments;
    - `aiUnavailable`, `aiCapReached` and `aiLimitReached`;
    - `ownTransfer` and `lowConfidence`;
    - `unknownAccount`, then linking.
  - **Payees:**
    - `WOLT.COM TBILISI` with an existing "Wolt" adds an alias, and the next one resolves without the AI's payee answer;
    - `SP *COFFEE LAB` with no candidate creates "Coffee Lab" with the raw alias;
    - an ignored name is never aliased.
  - **Balances:** a single-currency bank → authoritative; GEL + USD non-zero → informational; a zero USD sibling → authoritative.
  - **Dedup:**
    - tap → Wallet → push → SMS in different orders;
    - two identical coffees;
    - an FX amount taken from the bank;
    - a settlement attaching to its authorization;
    - an AI-judged match becomes a suggestion, never an attach;
    - the scan after sync and after a statement import.
  - **Reconciliation:** manual-account merge, remove and restore with balances; an ingest plan merged into a booked row; suggestions list, dismiss and merge.
  - **Inbox:**
    - cards are created per item type;
    - approve, edit and reject run the tool and resolve the record;
    - resolving in Reconciliation or the waiting list closes the card;
    - rollover after all cards are resolved and 7 days have passed, with the pin moving to the new thread;
    - the live thread refuses delete, unpin and archive while a card is pending; clear-resolved keeps pending cards;
    - no AI connection needed.
  - **Assistant push:**
    - a chat run finishing with no viewer → one `chatReplyReady` (merged with `chatCardsWaiting` when cards are pending); a fresh presence key → no push;
    - a burst of inbox items → one push with the count, and the cooldown holds;
    - an item with a card never also pushes `ingestAttention`;
    - the group toggle off → no delivery;
    - opening the thread marks its notifications read;
    - the bodies contain no reply or notification text.
  - **Settings:** sources, `lastDigits`, gate strictness and the setup code's `gate`.
- **Frontend vitest:** the `assistant` push toggle; the presence heartbeat (sent only while visible and focused, stopped on leave); deep links for the new types; the inbox pin, clear-resolved and archive actions; iOS version detection and picker; per-version setup; renamed route and redirects; sources; the Suggestions tab; the inbox thread view (no composer, cards only); block reasons.
- **Playwright:** approve an inbox card for an unknown account; merge a suggestion from Reconciliation and see the inbox card resolved.
- **Manual on the device** (Post-Completion).

## Progress Tracking

- Mark completed items `[x]` immediately; prefix new tasks with ➕ and blockers with ⚠️.
- After each gate passes, note the command and its result under the task.

## Solution Overview

```
iOS 27 shortcut "MoneyMatter: log payments" (WFWorkflowTriggers: Wallet Transaction + Notification)
  decode setup code → url := last segment → "event", gate := code.gate ?? built-in standard
  ├─ input has Merchant/Card → POST {kind:"walletTransaction", amount, merchant, card, name, key}
  └─ else Match Text(gate, title+subtitle+body) → If no match: Stop
       → POST {kind:"notification", app, bundleId, title, subtitle, body, time, raw, key}
  → If response.notify: Show Notification(response.summary)

/ingest/event → auth → base-currency lock → token rate limit → controller
  ├─ walletTransaction → ingestCardPayment (existing) → 200 {summary, notify:true}
  └─ notification → prefilter (user's strictness) ─dropped→ counter → 200 {dropped, notify:false}
       → per-user hour/day limit → tx 1: IngestRequests + source upsert → enqueue job (no delay)
       → poll the row ≤ 10 s → 200 {logged|attached|parked|queued, summary, notify} | {ignored, notify:false}

ingest-notification job:
  repeat (fingerprint, 10 min) → pending sender? park + inbox card
  → parse: Wallet layout | AI notificationParsing (+ payee candidates, balance context; daily limit, usage cap)
  → not a payment: wipe text → ignored | park ownTransfer / lowConfidence / ai* (+ inbox card)
  → account: card name → last digits → source default → park unknownAccount (+ inbox card)
  → tx: per-user lock → tier-1 exact twin → attach + enrich
        | log (logIngestedPayment) → tier-2 judge → suggestion (+ inbox card) when ≥ 0.6

duplicate-scan job (TRANSACTIONS_SYNCED, statement import) → judge → suggestions (+ inbox cards)
Inbox thread (kind automationInbox, no AI) ⇄ Reconciliation Suggestions tab ⇄ waiting list: same records
```

- **Data** (one migration, `migrations/20261020120000-notification-ingest.ts`):
  - `IngestRequests`: add `parsed` (JSONB), `sourceId` (FK `NotificationSources`, set null) and `proposalId` (FK `ChatProposals`, set null); `status` gains `ignored`.
  - `IngestSettings`: add `gateStrictness` (varchar 16, default `standard`).
  - `CardAccountMappings`: add `lastDigits` (varchar 4), with a partial unique index on `(userId, lastDigits)`.
  - `ChatThreads`: add `kind` (varchar 24, default `chat`), and an index on `(userId, kind, createdAt)`. The live inbox uses the existing `pinned` column.
  - `NotificationSources`: `id`, `userId`, `sourceKey`, `appName`, `bundleId`, `sender`, `conversational`, `mode`, `defaultAccountId` (FK, set null), `counters` (JSONB), `proposalId` (FK, set null), `lastSeenAt`, timestamps. Unique on `(userId, sourceKey)`. Backed up.
  - `DuplicateSuggestions`: `id`, `userId`, `accountId`, `transactionId`, `candidateId` (FKs, cascade), `confidence`, `reason`, `trigger` (`ingest` | `sync` | `import`), `status` (`open` | `merged` | `dismissed` | `stale`), `proposalId` (FK, set null), `resolvedAt`, timestamps. Unique on the ordered pair. Backed up, and wiped with the user's data.
- **Shared** (`packages/shared/src/types/`):
  - `ingest/amount-gate.ts`: `AMOUNT_GATE_PATTERNS` per strictness, plus samples;
  - `ingest/notification-sources.ts`: the conversational app list and `buildSourceKey`;
  - the new statuses, reasons and DTOs;
  - `notifications.ts` and `web-push.ts`: `chatReplyReady`, `chatCardsWaiting`, `automationInbox` and `ingestAttention` in the new `assistant` group;
  - chat: the thread `kind`.
- **Backend services:**
  - `ingest/event/`: `ingest-event.ts`, `wait-for-outcome.ts`, `parse-notification-payload.ts`, `prefilter-notification.ts` + `prefilter-markers.ts`, `notification-fingerprint.ts`, `notification-queue.ts`, `process-notification.ts`, `parse-wallet-notification.ts`, `parse-notification-with-ai.ts` + `notification-prompt.ts`, `payee-candidates.ts`, `apply-payee-choice.ts`, `balance-authority.ts`, `ai-daily-limit.ts`, `resolve-notification-account.ts`, `notification-sources.service.ts`;
  - `ingest/log-ingested-payment.ts`, extracted from `process-card-payment.ts`;
  - `ingest/dedup/`: `constants.ts`, `source-slots.ts`, `find-twin.ts`, `enrich-twin.ts`, `judge-duplicates.ts` + prompt + candidates, `choose-survivor.ts`, `duplicate-scan-queue.ts`, `event-listeners.ts`;
  - `chat/inbox/`: `inbox-thread.ts` (alive rule, rollover), `create-system-proposal.ts`, `inbox-items.ts` (create, sync, resolve);
  - `assistant-push/`: `presence.ts` (heartbeat keys), `assistant-push-queue.ts` (debounce, cooldown, count), `emit-assistant-push.ts` (the entry point the run recorder, inbox and ingest call);
  - `transactions/reconciliation/`: the widened helpers, merge and restore, plus `duplicate-suggestions.ts`.

## Technical Details

- **Request body** (16 KB `largePaths` entry in `packages/backend/src/setup-middleware.ts`; unknown keys ignored):
  - `kind`: required, `walletTransaction` | `notification`.
  - `idempotencyKey`: `^[\x21-\x7E]{8,128}$`, required unless `dryRun`.
  - `walletTransaction` fields: those of the card-payment API.
  - `notification` fields:
    - `app` (≤ 100), `bundleId` (≤ 200);
    - `title` (≤ 500), `subtitle` (≤ 500), `body` (≤ 4000); aliases `appName`/`sourceApp` → `app`, `message`/`text` → `body`;
    - `time` (ISO 8601 with offset; the card-payment window rules apply);
    - `raw` (JSON, ≤ 8 KB serialized, read by the parser as text).
  - `source`, `dryRun`: optional.
- **Responses:** `{ outcome, summary?, requestId?, reason?, notify }`.
  - `walletTransaction` gets the card-payment outcomes.
  - `notification` gets `logged` | `attached` | `parked` | `queued` (200), `ignored` | `dropped` (200, `notify: false`), `duplicate` (200; the stored outcome is replayed), or 409.
  - `dryRun` → `notify: true`.
  - Errors: 401/402/403/413/422/423/429.
- **Prefilter:** `{ pass: true, hints: { hasCardDigits, hasBalance } } | { pass: false, reason: 'noAmount' | 'security' | 'promo' | 'muted' }`. Marker lists are kept per language in `prefilter-markers.ts`.
- **Fingerprint:** SHA-256 over the canonical JSON of the source key, title, subtitle and body (whitespace collapsed). A repeat within 10 minutes is folded into the first request without parsing; this also covers one notification arriving on two devices.
- **AI parse schema** (`notification_parse`):
  - `kind`, `stage`, `isOwnAccountTransfer`;
  - `amount`, `currency`, `originalAmount`, `originalCurrency`;
  - `merchant` (raw), `payee` (`{ candidateId }` | `{ newName }` | null);
  - `cardName`, `cardLastDigits`;
  - `balanceAfter` (`{ amount, currency, scopeHint }`);
  - `occurredAt`, `confidence`.

  The system prompt has the kind definitions, the payee rules (Decisions), the balance rule ("this bank holds non-zero balances in: GEL, USD; a single stated balance is probably a total unless labeled per account"), and a rule that the text is untrusted data. There are no tools, and every field is validated (`parseAmount`, `resolveCurrency`, the digits pattern, length caps, `candidateId` ∈ the candidate aliases).
- **`parsed`:** the validated parse plus `parser`, `model`, `direction`, `payeeId`, `payeeAction` (`exact` | `candidate` | `created` | `resolver`), `aliasAdded`, `balanceAfter.authoritative`, `matchedBy`, `accountGuessId`.
- **Reasons:**
  - park: `unknownAccount`, `senderNotApproved`, `aiUnavailable`, `aiCapReached`, `aiLimitReached`, `ownTransfer`, `lowConfidence`;
  - ignore: `declined`, `security`, `promo`, `info`, `other`;
  - drop counters: `noAmount`, `security`, `promo`, `muted`, `rateLimited`.
- **Constants** (objects, so tests can shorten them):
  - `notificationTimings`: `waitBudgetMs` 10 s, `pollMs` 250, `repeatWindowMs` 10 min, `interruptedAfterMs` 30 min;
  - `dedupConfig`: `twinWindowMs` 30 min, `judgeWindowMs` 72 h, tolerance `CARD_PAYMENT_AMOUNT_TOLERANCE`, `suggestConfidence` 0.6, `maxJudgeCandidates` 5;
  - `inboxConfig`: `aliveDays` 7, `maxCards` 200, `cardTtlDays` 30;
  - `assistantPushConfig`: `debounceMs` 60 s, `threadCooldownMs` 5 min, `inboxCooldownMs` 10 min, `ingestCooldownMs` 24 h, `presenceTtlMs` 45 s, `heartbeatMs` 20 s.
- **Lock:** `pg_advisory_xact_lock(hashtextextended('ingest-dedup:<userId>', 0))`.
- **Settings API** (`/user/settings/...`):
  - `GET|PATCH|DELETE /notification-sources[/:id]` (`mode`, `defaultAccountId`);
  - `card-mappings` gets `lastDigits`;
  - `PUT /card-payments/gate-strictness`;
  - the setup-code endpoint adds `gate`;
  - `card-payments/requests` lists notification requests; `retry` takes `force` for `ownTransfer`/`lowConfidence`.
- **Reconciliation API:** `GET /transactions/reconciliation/suggestions`, `POST /transactions/reconciliation/suggestions/:id/dismiss`.
- **MCP tools** (through `add-mcp-tool`; the chat tools come from their policies): `list-duplicate-suggestions`, `dismiss-duplicate-suggestion`, `log-ingest-request`, `set-notification-source`.
- **Chat:** the toolkit never lists `automationInbox` threads as a target for AI runs; posting a message to one is a 409. Thread listing shows the inbox pinned first while it is alive.
- **Guards:** `POST /ingest/event`, suggestion dismiss and `log-ingest-request` carry `checkBaseCurrencyLock`. Source, strictness and setup-code writes are exempt (settings).
- **Retention:** `ignored` and pending-sender requests are kept 7 days; payment requests 90 days; `merged`/`stale` suggestions 90 days; `dismissed` suggestions stay.

## What Goes Where

- **Implementation Steps:** backend (schema, endpoint, prefilter, parsing, payees, balances, limits, dedup, reconciliation, inbox, assistant push, settings, tests); frontend (push settings and presence, rename, setup UI, Reconciliation tab, inbox thread view); the triggered-shortcut generator after the device capture; docs.
- **Post-Completion:** device capture and samples, signing, the Cloudflare Access path, deployment, upstream.

## Implementation Steps

### Task 1: Schema and shared types

**Files:**

- Create: `packages/backend/src/migrations/20261020120000-notification-ingest.ts`, `packages/backend/src/models/{notification-sources,duplicate-suggestions}.model.ts`
- Modify: `packages/backend/src/models/{ingest-requests,ingest-settings,card-account-mappings,chat-threads}.model.ts`
- Modify/Create: `packages/shared/src/types/ingest/{index,amount-gate,notification-sources}.ts`, `packages/shared/src/types/{notifications,web-push}.ts`, the chat thread types, the reconciliation suggestion DTOs
- Modify: `packages/backend/src/services/backup/registry.ts`, `packages/backend/src/services/user/wipe-user-data.service.ts`

- [ ] write failing tests:
  - `registry.unit.ts` lists the new models;
  - a restore round-trip keeps a source and a dismissed suggestion;
  - `amount-gate.unit.ts` runs the samples per strictness: GEL/₾/$/€/грн/zł on both sides of the number with locale separators. Negatives for `strict`/`standard`: plain codes, phone numbers, dates, chat text without a currency;
- [ ] migration with `down`; models; shared constants and types
- [ ] backup entries with reasons; the wipe covers both new tables
- [ ] gate: unit `--testPathPattern='(backup/registry|amount-gate|web-push)'`; e2e `--testPathPattern='backup/restore/restore-backup.e2e'`; typecheck

### Task 2: Event endpoint, prefilter, limits and the banner wait

**Files:**

- Create: `packages/backend/src/services/ingest/event/{ingest-event,wait-for-outcome,parse-notification-payload,prefilter-notification,prefilter-markers,notification-fingerprint,notification-queue,notification-sources.service}.ts` + unit specs
- Create: `packages/backend/src/controllers/ingest/event.controller.ts`
- Modify: `packages/backend/src/routes/ingest.route.ts`, `packages/backend/src/setup-middleware.ts`, `packages/backend/src/middlewares/rate-limit.ts`, `packages/backend/src/routes/base-currency-guard-coverage.e2e.ts`, `packages/backend/src/services/ingest/{create-setup-code.ts,access-headers.service.ts}` (gate, strictness), `packages/shared/src/types/ingest/card-payment-setup-code.ts` (optional `gate`)
- Create: `packages/backend/src/services/ingest/event/ingest-event.e2e.ts`; Modify: `packages/backend/src/tests/helpers/ingest.ts`

- [ ] write failing unit tests:
  - `kind` is required and validated; aliases and caps;
  - the prefilter blocks per language: OTP with a code → `security`; 3-D Secure with an amount → `security`; percent-off promo → `promo`; payment text with card digits and a promo word passes;
  - strictness levels;
  - fingerprint stability;
  - the setup code round-trips `gate`, and an old code without it still decodes
- [ ] write failing e2e:
  - `walletTransaction` → the card-payment summary with `notify: true`;
  - a notification whose (stubbed) job finishes in time → `logged` with the summary; a slow job → `queued`;
  - each drop reason → `200 dropped`, **no** row, and the counter bumped;
  - key replay and 409;
  - dry run;
  - 413;
  - hour limit → 429, and dropped requests don't count;
  - strictness `PUT` with a 422 on an unknown level;
  - guard coverage
- [ ] implement:
  - detection-free dispatch on `kind`;
  - prefilter, source upsert with counters, tx 1;
  - the enqueue (no delay, `jobId = requestId`; 4 attempts with backoff; the final failure parks `processingFailed`);
  - `waitForOutcome` (poll the row; the summary from `formatSummary`)
- [ ] gate: unit `--testPathPattern='(ingest/event|setup-code)'`; e2e `--testPathPattern='(ingest/event/ingest-event|ingest/card-payment/ingest-card-payment|ingest/setup-code|routes/base-currency-guard-coverage).e2e'`

### Task 3: AI features `notificationParsing` and `duplicateMatching`

**Files:**

- Modify: `packages/shared/src/types/ai/settings.ts`, `packages/backend/src/services/ai/resolution-ladder.ts`, `packages/frontend/src/common/const/ai-features.ts` + i18n `common.aiFeatures.*`, `settings.ai.modelGuide.*` (`en` + `uk`)
- Modify: `packages/backend/src/services/user-settings/ai-feature-settings.e2e.ts`, `packages/backend/src/services/ai/ai-model-resolver.unit.ts`, `packages/frontend/src/composable/use-ai-feature-access.test.ts`

- [ ] write failing tests: both features are listed, saved and resolved; ladder defaults; the registry covers every `AI_FEATURE`
- [ ] enum values `notification_parsing` and `duplicate_matching`; cheap, fast defaults; the copy (the owner approves it)
- [ ] gate: unit `--testPathPattern='ai-model-resolver'`; e2e `--testPathPattern='user-settings/ai-feature-settings.e2e'`; frontend `--run src/composable/use-ai-feature-access.test.ts`

### Task 4: Parsers, payee candidates, balance authority and the AI daily limit

**Files:**

- Create: `packages/backend/src/services/ingest/event/{parse-wallet-notification,parse-notification-with-ai,notification-prompt,classify-notification,payee-candidates,apply-payee-choice,balance-authority,ai-daily-limit}.ts` + unit specs, `fixtures/notifications.ts`. The fixtures cover Wallet; Georgian, Russian, Ukrainian and English bank pushes, SMS and an email; debit, credit, decline, promo, FX and settlement texts; `WOLT.COM TBILISI`, `SP *COFFEE LAB`; a total balance across currencies; and a personal message with an amount.

- [ ] write failing unit tests (`jest.mock('ai')`):
  - the Wallet parser;
  - kind mapping; confidence < 0.6 → `lowConfidence`; invalid fields are dropped; a `candidateId` outside the list is dropped;
  - the prompt contains the payee rules, the candidate block and the balance context (snapshot of its sections);
  - `payeeCandidates` takes token matches, Fuse matches and the source's recent payees, without duplicates, capped at 15, skipping generic words;
  - `balanceAuthority`: single currency → true; another non-zero currency at the same bank → false; zero siblings → true; `scopeHint: 'total'` → false;
  - no client → `aiUnavailable`; a spent allowance → `aiCapReached`; the daily counter at its limit → `aiLimitReached` with no AI call
- [ ] implement `parseWalletNotification`, `parseNotificationWithAi` (`createAIClient(notificationParsing)`, `Output.object`, `aiCallGuards`, `trackAiUsage`, `resolveAiExtractionFailure`), `classifyNotification`, `payeeCandidates`, `balanceAuthority` and `aiDailyLimit`, which the judge shares
- [ ] gate: unit `--testPathPattern='ingest/event/(parse|classify|payee-candidates|balance-authority|ai-daily-limit|notification-prompt)'`

### Task 5: Processing job, payee choice and the shared logging core

**Files:**

- Create: `packages/backend/src/services/ingest/log-ingested-payment.ts`; Modify: `packages/backend/src/services/ingest/card-payment/process-card-payment.ts`
- Create: `packages/backend/src/services/ingest/event/{process-notification,resolve-notification-account}.ts`; finish `apply-payee-choice.ts`
- Modify: `packages/backend/src/services/ingest/card-payment/{process-ingest-request,list-requests,retry-request,format-summary}.ts`, `packages/backend/src/crons/ingest-requests-cleanup.ts`
- Create: `packages/backend/src/services/ingest/event/{process-notification,payee-resolution}.e2e.ts`

- [ ] write failing e2e (AI over MSW):
  - a Wallet notification is logged without AI;
  - a push debit and credit are logged with payee and history category;
  - non-payments are `ignored` with the text wiped;
  - pending sender → parked without AI; approval logs it; mute deletes it;
  - `aiUnavailable`, `aiCapReached` and `aiLimitReached`, each followed by a successful retry;
  - `ownTransfer`/`lowConfidence` park, and `force` logs them;
  - FX → `originalAmount`;
  - a connected account → planned;
  - retention: 7 days for `ignored` and pending
- [ ] write failing e2e for payees:
  - `WOLT.COM TBILISI` + an existing "Wolt" → `payeeId` Wolt and the alias added. A second notification resolves by the alias even when the AI mock answers `newName: "Something"`;
  - `SP *COFFEE LAB` with no candidate → a payee "Coffee Lab" with the raw alias;
  - an ignored raw name gets no alias;
  - a raw name that already belongs to another payee is not re-aliased
- [ ] write failing e2e for accounts and balances: Wallet title → card link; digits → `lastDigits`; source default; none → `unknownAccount` with a guess; GEL + USD non-zero at the same connection → `authoritative: false` on the row
- [ ] implement:
  - extract `logIngestedPayment` (the existing card-payment e2e tests stay green);
  - `applyPayeeChoice` (exact lookup → candidate → create, via the payee service, `ensureAliasExists` and the logo queue);
  - `processNotification`, with pass-through dedup and inbox hooks until Tasks 7, 8 and 11
- [ ] gate: e2e `--testPathPattern='(ingest/event/(process-notification|payee-resolution)|ingest/card-payment/(ingest-card-payment|processing|requests|ai-categorization)|crons/ingest-requests-cleanup).e2e'`; unit `--testPathPattern='ingest'`

### Task 6: Source, card-link and strictness settings

**Files:**

- Create: `packages/backend/src/controllers/ingest/notification-sources.controller.ts`
- Modify: `packages/backend/src/routes/user.route.ts`, `packages/backend/src/services/ingest/card-mappings.service.ts`, `packages/backend/src/controllers/ingest/{card-mappings,access-headers}.controller.ts`
- Create: `packages/backend/src/services/ingest/event/notification-sources.e2e.ts`; Modify: `packages/backend/src/services/ingest/card-mappings.e2e.ts`

- [ ] write failing e2e:
  - sources: list (empty, then with counters), mode, default account (owned and active only; 404 for another user's), delete;
  - `lastDigits`: validation, and 409 on a duplicate;
  - strictness: read and update
- [ ] implement; guard exemptions with reasons
- [ ] gate: e2e `--testPathPattern='ingest/(event/notification-sources|card-mappings).e2e'`

### Task 7: Tier-1 exact twin and enrichment

**Files:**

- Create: `packages/backend/src/services/ingest/dedup/{constants,source-slots,find-twin,enrich-twin}.ts` + unit specs, `twin.e2e.ts`
- Modify: `packages/backend/src/services/ingest/log-ingested-payment.ts`, `packages/backend/src/services/ingest/event/process-notification.ts`

- [ ] write failing unit tests: slots (including legacy `externalData.cardPayment` rows); the twin rule (exact amount, original amount, window, taken slot, `isSameShop` veto, ambiguity → none)
- [ ] write failing e2e:
  - tap → Wallet → push → SMS gives one row with four sources, in any order;
  - two identical coffees stay two rows;
  - a USD tap on a GEL manual account takes the bank's GEL, and the balance moves by the difference;
  - the payee is filled and the spelling aliased;
  - a settlement attaches to its authorization;
  - the banner reads "Already logged …"
- [ ] implement under the per-user lock in both paths; attach through `updateTransaction`
- [ ] gate: unit `--testPathPattern='ingest/dedup'`; e2e `--testPathPattern='ingest/(dedup/twin|card-payment/(ingest-card-payment|processing)|event/process-notification).e2e'`

### Task 8: AI duplicate judge (suggestions only)

**Files:**

- Create: `packages/backend/src/services/ingest/dedup/{judge-duplicates,judge-prompt,find-judge-candidates}.ts` + unit spec, `judge.e2e.ts`
- Modify: `packages/backend/src/services/ingest/event/process-notification.ts`

- [ ] write failing unit tests: short ids; unknown ids dropped; clamping; confidence ≥ 0.6 → a suggestion, below → none; no client or a spent limit → none
- [ ] write failing e2e: 0.95 → a **new row and an `open` suggestion** (no attach); 0.3 → a new row only; candidates exclude taken slots and other accounts
- [ ] implement with `AI_FEATURE.duplicateMatching`; usage is tracked and counted against the daily limit
- [ ] gate: unit `--testPathPattern='ingest/dedup/judge'`; e2e `--testPathPattern='ingest/dedup/(judge|twin).e2e'`

### Task 9: Reconciliation for manual accounts and ingest plans

**Files:**

- Modify: `packages/backend/src/services/transactions/reconciliation/{helpers,merge-transactions,restore-transactions,get-history}.ts`, `reconciliation.e2e.ts`, `packages/backend/src/services/chat/proposals/previews/reconciliation.ts`, i18n `transactions.reconciliation.*` (`en` + `uk`)
- Create: `packages/backend/src/services/ingest/dedup/choose-survivor.ts` + unit spec
- Modify: `packages/frontend/src/pages/optimizations/reconciliation/block-reasons.ts` + test

- [ ] write failing e2e:
  - on a manual account, merge and remove change the balance and `Balances`, and restore reverses them;
  - bank rows are unchanged;
  - an ingest plan merges into a booked row, and the reverse is rejected;
  - a user plan is still rejected;
  - `planEditMerge` moves a manual category, and a conflict rejects the merge;
  - the chat merge preview accepts the same rows
- [ ] implement; the frontend block reasons mirror the backend rules
- [ ] gate: e2e `--testPathPattern='transactions/reconciliation/reconciliation.e2e'`; unit `--testPathPattern='(choose-survivor|chat/proposals)'`; frontend `--run src/pages/optimizations/reconciliation`

### Task 10: Suggestions and the scan job

**Files:**

- Create: `packages/backend/src/services/transactions/reconciliation/duplicate-suggestions.ts` + e2e, `packages/backend/src/services/ingest/dedup/{duplicate-scan-queue,event-listeners}.ts`
- Modify: `packages/backend/src/controllers/transactions.controller/{reconciliation,reconciliation-schemas}.ts`, `packages/backend/src/routes/transactions.route.ts`, `packages/backend/src/services/transactions/delete-transaction.ts`, `packages/backend/src/services/import-export/statement-parser/execute-import.service.ts`, `packages/backend/src/tests/helpers/reconciliation.ts`
- MCP: `list-duplicate-suggestions`, `dismiss-duplicate-suggestion`

- [ ] write failing e2e:
  - list (empty, then open pairs with the suggested survivor);
  - dismiss for good;
  - a merge marks the suggestion `merged`, and a delete marks it `stale`;
  - a sync next to an unsettled ingest plan → a suggestion;
  - two ingest rows judged 0.95 → a suggestion, **not** merged;
  - a statement import → a suggestion
- [ ] implement the scan: only accounts with ingest rows in the window; AI only when SQL finds candidates; the daily limit applies
- [ ] gate: e2e `--testPathPattern='(transactions/reconciliation/(duplicate-suggestions|reconciliation)|ingest/dedup/(judge|twin)).e2e'`; unit `--testPathPattern='(reconciliation-tools|mcp)'`

### Task 11: Automation inbox thread and cards

**Files:**

- Create: `packages/backend/src/services/chat/inbox/{inbox-thread,create-system-proposal,inbox-items}.ts` + unit specs, `inbox.e2e.ts`
- Create: chat policies and preview resolvers for `log_ingest_request` and `set_notification_source` (`services/chat/policies/explicit.ts`, `services/chat/proposals/previews/ingest-requests.ts`); MCP tools `log-ingest-request` and `set-notification-source` (`add-mcp-tool`)
- Modify: `packages/backend/src/services/chat/threads/{list.service,to-chat-thread,update.service,delete.service}.ts` (kind; the live inbox refuses delete and unpin), `packages/backend/src/routes/chat.route.ts` + controllers (`clear-resolved`, `archive`), the message-post path (409 for inbox threads), `packages/backend/src/services/ingest/event/process-notification.ts`, `packages/backend/src/services/transactions/reconciliation/duplicate-suggestions.ts`, `packages/backend/src/services/ingest/event/notification-sources.service.ts`, `packages/backend/src/services/ingest/card-payment/{retry-request,dismiss-request}.ts`

- [ ] write failing unit tests: the live rule (a pending card keeps a thread live past 7 days; a fully resolved thread older than 7 days rolls over; 200 cards roll over)
- [ ] write failing e2e:
  - each item type creates one assistant message and a card with `preview.before` showing the request, the sender or both transactions;
  - approve runs the tool (logs the request, approves the sender, merges the pair) and resolves the record;
  - edit changes the account or default account before approval;
  - reject dismisses or mutes;
  - resolving in the Reconciliation tab or the waiting list marks the card `rejected`/`resolvedElsewhere`;
  - a user with no AI connection still gets cards and can approve them;
  - posting a message to the inbox thread → 409;
  - the live inbox is pinned; a rollover unpins the old thread (it gets an `expiresAt`) and pins the new one in one transaction;
  - `DELETE` and `PATCH { pinned: false }` on the live inbox → 409; on a non-live inbox they work;
  - `clear-resolved` deletes only messages whose cards are not pending; `archive` → 409 with a pending card, otherwise unpins and the next item opens a new thread
- [ ] implement `createSystemProposal` on top of `computeCardState`/`storeProposal`; wire the inbox hooks in processing, the judge, the scan and the sources
- [ ] gate: unit `--testPathPattern='chat/(inbox|policies)'`; e2e `--testPathPattern='(chat/inbox/inbox|chat/threads/threads|chat/proposals/(approve|card-actions)|ingest/event/process-notification|transactions/reconciliation/duplicate-suggestions).e2e'`

### Task 12: Assistant push group (backend)

**Files:**

- Modify: `packages/shared/src/types/{notifications,web-push}.ts` (`assistant` group, `PUSH_GROUP_DEFAULTS.assistant = true`, the four types and their payloads)
- Create: `packages/backend/src/services/assistant-push/{presence,assistant-push-queue,emit-assistant-push}.ts` + unit specs, `assistant-push.e2e.ts`
- Create: `packages/backend/src/controllers/chat/presence.controller.ts`; Modify: `packages/backend/src/routes/chat.route.ts` (`PUT|DELETE /chat/presence`)
- Modify: `packages/backend/src/services/web-push/{render-push-body,build-push-payload}.ts` + unit specs (bodies, per-type tag), `packages/backend/src/background-jobs.ts` (worker), the backend i18n `notifications.push.*` (`en` + `uk`)
- Modify (callers): `packages/backend/src/services/chat/runs/run-recorder.ts` (run finished or failed in a `chat` thread), `packages/backend/src/services/chat/inbox/inbox-items.ts`, `packages/backend/src/services/ingest/event/process-notification.ts` and `packages/backend/src/services/ingest/card-payment/process-ingest-request.ts` (parks without a card), the thread `get` service and the in-app notifications service (mark read by `payload.threadId`)

- [ ] write failing unit tests:
  - collapse keys and windows per type;
  - the count is carried into the notification;
  - the cooldown;
  - presence get/set/expiry;
  - the bodies for each type in `en` and `uk`, with no message or notification text in them;
  - the tag per type;
  - `NOTIFICATION_PUSH_GROUP` places every new type in `assistant`
- [ ] write failing e2e (push delivery mocked as in `web-push/push-delivery.e2e.ts`):
  - a chat run finishing with no presence → one `chatReplyReady` delivered, deep-linking to its thread; with pending cards, one push that mentions them;
  - a presence heartbeat for that thread → no notification;
  - three inbox items within the window → one `automationInbox` with count 3; a fourth inside the cooldown → none until the cooldown ends;
  - an unknown-account park (it has a card) → only `automationInbox`; `aiCapReached` → one `ingestAttention`, and a second the same day → none;
  - the `assistant` group switched off → the in-app entry exists but nothing is delivered;
  - `GET` on the thread marks its assistant notifications read;
  - `PUT /chat/presence` for another user's thread → 404
- [ ] implement on the existing `createNotification` → `enqueueWebPushAfterCommit` → `push-queue.ts` path; the debounce queue only decides when to create the notification
- [ ] gate: unit `--testPathPattern='(assistant-push|web-push)'`; e2e `--testPathPattern='(assistant-push/assistant-push|web-push/push-delivery|notifications/notifications|chat/runs/run-stream).e2e'`

### Task 13: Frontend: assistant push settings, presence and deep links

**Files:**

- Modify: `packages/frontend/src/pages/settings/subpages/notifications/components/push-groups-card.vue` + spec (the `assistant` toggle with its description)
- Create: `packages/frontend/src/composable/use-chat-presence.ts` + test; use it in the chat thread page
- Modify: `packages/frontend/src/components/notifications-popover/build-notification-route.ts` + test, the notification item rendering for the new types, `packages/frontend/src/api/chat.ts`
- i18n: `settings.notifications.push.groups.assistant.*`, `notifications.types.{chatReplyReady,chatCardsWaiting,automationInbox,ingestAttention}.*` (`en` + `uk`)

- [ ] failing vitest:
  - the toggle renders and saves the `assistant` group;
  - the heartbeat is sent every 20 s only while the thread page is visible and focused; it stops on blur, hide and route leave, and `DELETE` is sent on leave;
  - the three thread types route to `chatThread` with their `threadId`; `ingestAttention` routes to the iOS Automation page's waiting list;
  - the bell items show the counts
- [ ] gate: `npm run test:unit -- --run src/pages/settings/subpages/notifications src/composable/use-chat-presence.test.ts src/components/notifications-popover`; typecheck, lint

### Task 14: Frontend: rename to "iOS Automation" and version-aware setup

**Files:**

- Move: `packages/frontend/src/pages/accounts/integrations/apple-pay/` → `ios-automation/` (`apple-pay-details.vue` → `ios-automation-details.vue`, specs follow)
- Modify: `packages/frontend/src/routes/{index,constants}.ts` (`accountIosAutomation`, redirects from `/accounts/integrations/apple-pay` and the settings `integrations/*`), `packages/frontend/src/pages/accounts/accounts.vue`, `pages/accounts/integrations/components/add-integration-dialog.vue`, `packages/frontend/src/components/sync-status-tooltip.vue`, `components/ui-header.vue`
- Create: `ios-automation/components/{ios-version-picker,triggered-shortcut-setup,gate-strictness,notification-sources,pending-senders}.vue` + specs, `composables/use-ios-version.ts` + spec
- Modify: `components/{setup-checklist,add-shortcut-button,card-link-dialog,card-links,waiting-payments,payment-request-summary}.vue`, `packages/frontend/src/api/ingest.ts`; i18n `settings.integrations.applePay.*` → `settings.integrations.iosAutomation.*` (`en` + `uk`)
- Create: `packages/frontend/e2e/tests/integrations/ios-automation.spec.ts` (and update the Apple Pay specs' paths)

- [ ] failing vitest:
  - routes: the redirects from both old paths, and the page title "iOS Automation";
  - version: read from the user agent (`iPhone OS 27_…`); elsewhere the user picks, remembered in `localStorage` (try/catch);
    - iOS 27+: **Add Shortcut** for `log-payments.shortcut`, plus a checklist: turn on the built-in triggers; if iOS asks, choose the notification apps (Wallet, Messages, the bank's app, the mail app); Run Immediately. It also explains the gate ("only notifications that show an amount leave your phone; no Apple Intelligence needed");
    - earlier iOS: today's file and checklist;
    - each file's button is hidden while the file is missing;
  - gate strictness with its warning and "generate a new setup code";
  - sources, pending senders (approve/mute), the last-digits field;
  - waiting/recent lists show notification kinds and the new reasons, with a link to the inbox card
- [ ] Playwright: the old URL redirects; an unknown-account notification is resolved from the waiting list
- [ ] gate: `npm run test:unit -- --run src/pages/accounts src/routes`; typecheck, lint

### Task 15: Frontend: Reconciliation Suggestions tab and the inbox thread view

**Files:**

- Create: `packages/frontend/src/pages/optimizations/reconciliation/components/{suggestions-tab,suggestion-card}.vue` + specs; `packages/frontend/e2e/tests/reconciliation/suggestions.spec.ts`
- Modify: `reconciliation/{index.vue,use-reconciliation.ts}`, `components/{merge-dialog,history-tab}.vue`, `packages/frontend/src/api/transactions.ts`, `packages/frontend/src/common/const/vue-query.ts`
- Modify: the chat thread page and thread list (an inbox badge, no composer, the pin shown as locked while live, **Clear resolved** and **Archive** actions with their disabled reasons)

- [ ] failing vitest:
  - Suggestions tab: badge; pairs side by side with sources, confidence and reason; **Merge** opens the existing dialog with the suggested survivor; **Not duplicates**; empty state;
  - the inbox thread has no composer and offers "Ask the assistant in a new chat";
  - the live inbox shows a locked pin, hides delete, offers **Clear resolved**, and disables **Archive** while a card is pending
- [ ] i18n `optimizations.reconciliation.suggestions.*`, `chat.inbox.*` (`en` + `uk`)
- [ ] Playwright: merge a suggestion in Reconciliation, then the inbox card shows as resolved
- [ ] gate: `npm run test:unit -- --run src/pages/optimizations/reconciliation src/pages/chat`; typecheck, lint

### Task 16: iOS 27 shortcut with built-in triggers

⚠️ Blocked on a fuller XML sample from the device. It must show:

- the Wallet Transaction trigger (identifier and parameters);
- the Notification trigger's App parameter set to one app, to several apps, and to "any app" if iOS offers it;
- the Notification input's property names;
- whether Run Immediately is stored in the trigger;
- whether `shortcuts sign` and the import keep `WFWorkflowTriggers`.

**Files:**

- Create: `packages/frontend/scripts/shortcuts/shortcut-plist.ts` (helpers moved out of `build-card-payment-shortcut.ts`), `build-payments-shortcut.ts` + spec, `fixtures/triggers-input.xml`, `packages/frontend/shortcuts/log-payments.plist`
- Modify: `packages/frontend/package.json` (`shortcuts:build` builds both shortcuts), `packages/frontend/public/shortcuts/README.md`, the Task 4 fixtures (real samples)

- [ ] failing spec:
  - XML drift;
  - `WFWorkflowTriggers` holds the Wallet Transaction trigger and a `WFNotificationTrigger` serialized like the fixture (any app, or the pre-filled Wallet fallback);
  - the URL rewrite on a decoded setup code;
  - the gate uses `code.gate` and falls back to the embedded standard pattern, which equals `AMOUNT_GATE_PATTERNS.standard`; the samples pass through the same regex;
  - the gate is built only from **Match Text** + **If** (an assertion that the action list contains no Apple Intelligence action);
  - a run with no input sends a dry run;
  - the banner is shown only when `notify` is true
- [ ] the generator flow, as in Solution Overview; the key is SHA-256 of `<input fields>|<date, or the run time to the minute>`
- [ ] add the real samples to the parser fixtures and re-run Task 4
- [ ] gate: `npm run test:unit -- --run scripts/shortcuts`; backend unit `--testPathPattern='(ingest/event|amount-gate)'`

### Task 17: Verify acceptance criteria

- [ ] a payment seen through tap, Wallet notification, push and SMS, in any order, gives one row with every source, the bank's amount, the resolved payee and a new alias; each run shows the right banner
- [ ] an online Apple Pay payment is logged from the Wallet notification alone; a chat, an OTP and a promo never create a stored request with text
- [ ] the limits hold (429, `aiLimitReached`, `aiCapReached`); Wallet still logs without AI
- [ ] every AI-judged match is a suggestion; approving it in the inbox or in Reconciliation resolves both; the manual account's balance stays right
- [ ] a bank sync and a statement import next to ingest rows create no duplicate rows (the plan is settled) or a suggestion
- [ ] a multi-currency bank's stated balance is informational
- [ ] assistant pushes: a finished chat reply in a thread the user is not viewing, and a burst of inbox items as one push with a count; nothing while the thread is open; the toggle silences them
- [ ] the live inbox is pinned, survives delete and unpin attempts, and the pin moves on rollover
- [ ] backend: `npm run test:unit` (full); e2e `--testPathPattern='(ingest|transactions/reconciliation|planned-matching|duplicates-detection|ai-categorization|user-settings/ai-feature-settings|payees|chat|web-push|notifications|backup|mcp|crons/ingest-requests-cleanup|routes/base-currency-guard-coverage)'`
- [ ] frontend: typecheck, lint, `npm run test:unit -- --run`; Playwright `integrations/`, `reconciliation/` and the chat specs when the dev stack is up
- [ ] root: `npm run format:check`, `npm run knip`

### Task 18: [Final] Update documentation

- [ ] `packages/docs/src/content/docs/integrations/ios-automation.mdx`, which replaces `apple-pay.mdx` (redirect in `astro.config.mjs`), per the `user-docs` skill. It covers:
  - the two shortcuts and which iOS each is for;
  - the triggers and which apps to add;
  - the on-device gate (Match Text, no Apple Intelligence) and strictness;
  - what is logged, ignored, dropped and parked;
  - accounts (card name, last digits, source default);
  - payees and aliases;
  - balances;
  - privacy (what reaches the server and the AI provider, what is stored and for how long);
  - limits;
  - the manual guide for older iOS;
  - troubleshooting
- [ ] `integrations/ingest-tokens.mdx` links; `transactions/reconciliation.mdx`: Suggestions and manual-account rows; a short page or section on the **Automation inbox** (what lands there, the pin, clear resolved, archive, rollover); `settings` notifications docs: the **Assistant** push group and what each push means
- [ ] `packages/backend/docs/card-payment-ingest.md`: the event endpoint, kinds, banner outcomes, prefilter, limits, slots, the twin rule, the judge, the inbox sync; `services/bank-data-providers/docs/architecture.md`: reconciliation now covers manual rows and ingest plans
- [ ] `self-hosting/docs/environment-reference.md`: `INGEST_AI_DAILY_LIMIT` and the event limits
- [ ] `cd packages/docs && npm run build` with the link validator passing
- [ ] move this plan to `docs/plans/completed/` after Task 17 passes (Task 16 may stay open under ⚠️)

## Post-Completion

_Items requiring manual work or external systems; no checkboxes._

**Device capture (owner, with the orchestrator), before Task 16:**

- From the Mac, export as XML a shortcut that has:
  - the Wallet Transaction trigger;
  - a Notification trigger with one app, then several (Wallet, Messages, TBC Bank, a mail app), and "any app" if offered;
  - a body that saves the Shortcut Input.
- Collect real texts:
  - Wallet: in-store, in-app, online, refund;
  - TBC push, TBC SMS and TBC email: card payment, transfer out, incoming transfer, OTP, decline, promo, settlement.

  Redact codes and balances before committing.
- Answer from the samples:
  - Does TBC show the card's last digits, and does the owner have several TBC cards? The design keeps per-source defaults plus `lastDigits` either way.
  - Does TBC send a separate payment notice after an OTP or 3-D Secure message? The plan drops those messages; if no separate notice comes, revisit the `security` rule.
  - Does a TBC balance line show one account's balance or a total?

**Signing:** sign `log-payments.plist` as in `public/shortcuts/README.md`. Import it on the phone and confirm that the triggers survive signing and import. Run it once by hand for the dry-run banner.

**Cloudflare Access for `money.nemirovsky.dev`:** widen the path-scoped Service Auth app from `/api/v1/ingest/card-payment` to `/api/v1/ingest/`, keeping the same service token. An anonymous request should get 403; one with the headers should reach the app.

**Deployment:**

- Build images from this branch, back up the database, and migrate.
- Set AI connections for `notificationParsing` and `duplicateMatching`, or rely on the defaults. Set `INGEST_AI_DAILY_LIMIT` if 300 does not fit.
- Enable push for the `assistant` group on the phone (installed web app).
- Generate a new setup code, which now carries `gate`.

**Upstream:** offer the work after the Apple Pay ingest lands, in four parts: endpoint, parsing and dedup (Tasks 1–10); the inbox and assistant push (Tasks 11–13); the UI and the shortcut (Tasks 14–16); the docs.
