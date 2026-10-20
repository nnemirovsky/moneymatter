# Payment ingest from iOS notifications, with AI parsing and dedup

## Overview

iOS 27 adds two things to Shortcuts:

- the personal-automation trigger **"When I receive a notification from <app>"**, with optional Title, Subtitle and Message filters;
- **Unified Automations**: triggers live inside the shortcut (`WFWorkflowTriggers` in the plist) and travel with it when it is shared.

Together they let MoneyMatter log payments that the Wallet **Transaction** trigger never sees:

- Wallet notifications cover Apple Pay inside apps and on websites.
- Bank notifications cover card payments, ATM withdrawals, transfers, refunds and incoming money. They arrive as an app push (TBC Bank for the owner), a bank SMS in Messages or a bank email, in any format and language.

The plan delivers:

1. **Two downloadable shortcuts:**
   - **iOS 27+:** one shortcut, "MoneyMatter: log payments", carrying **both triggers**.
     - The triggers are the Wallet Transaction trigger and one Notification trigger, as broad as iOS allows. If the device cannot express "any app", the fallback is a short list the user picks (Wallet, Messages, the bank's app, the mail app).
     - The shortcut stays dumb: it forwards the raw input with a `kind` saying which trigger fired.
     - An **on-device privacy gate** drops notifications that show no amount. It is built from the built-in **Match Text** (regex) and **If** actions and works **without Apple Intelligence**: no "Use Model" or any other Apple Intelligence action is involved.
   - **Older iOS:** today's tap-only "MoneyMatter: log card payment" and its manual automation steps, unchanged.
2. **`POST /api/v1/ingest/event`:**
   - `kind: walletTransaction` runs the existing card-payment pipeline.
   - `kind: notification` passes a **server prefilter** (amount pattern, OTP and promo markers) and a source-approval gate, then is processed by a job.
   - The request waits on a budget so the shortcut shows **a banner** like the tap one: "Logged …", "Already logged …", "Queued, will appear shortly", or the error message. Ignored notifications show none.
3. **Parsing:** Wallet's fixed layout is parsed in code; everything else goes to a new AI feature, `notificationParsing`.
   - It reuses the AI connections, feature config, model choice, monthly usage cap and usage tracking.
   - The same AI step **resolves the payee** against existing payees and aliases, and records new spellings as aliases, so the next match needs no AI.
4. **Privacy and limits:**
   - Notification text is encrypted at rest.
   - Text that is not a payment is wiped, and text not yet classified is kept at most 7 days.
   - Every new app or sender other than Wallet and known banks starts **pending** and reaches the AI only after the user approves it.
   - Per-user caps: 120 notifications an hour, 1000 a day, and 300 AI calls a day.
   - The gate's strictness is configurable.
5. **Account resolution:** Wallet card name, then the card's last digits, then the source's default account. A request matched by none of these waits for the user; the server never guesses an account.
6. **Dedup.** One payment can arrive four or more times (tap, Wallet notification, bank push, bank SMS), and again from bank sync or a statement import.
   - Only deterministic rules attach automatically: the exact twin, and a bank's settlement onto its own authorization.
   - Every **AI-judged** match (new AI feature `duplicateMatching`) becomes a **suggestion**, merged through the existing **Reconciliation** merge, history and restore. There is no AI auto-merge.
7. **Automation inbox:** a MoneyMatter-owned, **pinned** chat thread. Everything that needs the user arrives there as a **proposal card**: own-account transfers, unknown accounts, low-confidence parses, pending sources and duplicate suggestions. Cards use the existing approve/edit/reject flow.
8. **Web push for the assistant:** a new push group, `assistant`, on by default.
   - It covers finished chat replies and waiting cards when the user is not viewing the thread, new inbox items (collapsed with a count), and parked ingests that have no card.
   - Pushes are debounced, deep-linked, and toggled per group.
9. **Bank balances** from notifications are stored with an `authoritative` flag. When the same bank holds several non-zero currency balances, the stated balance is informational only.
10. **Setup UI:** the page is renamed from "Apple Pay" to **"iOS Automation"** (Accounts → iOS Automation). It shows two **Add shortcut** buttons side by side, "iOS 27 or later" and "iOS 26 or earlier", each with its own short instructions. Nothing is detected. Both work from the home-screen web app (standalone PWA).
11. **Docs.**

Out of scope: Android, own-account transfer pairing, balance-drift alerts (the balance is only stored), and changes to the planned-row settlement rules of the Apple Pay plan.

**Branch:** the owner wants the whole iOS Automation feature on `feat/apple-pay-ingest`. This plan is written on `feat/notification-ingest` and gets consolidated there; names stay generic so it can go upstream with the Apple Pay ingest.

## Context (from discovery)

- **Ingest pipeline** (`packages/backend/src/services/ingest/card-payment/`, plan `docs/plans/completed/20261017-apple-pay-ingest.md`):
  - Route `routes/ingest.route.ts`: `authenticateIngestToken({ scope: INGEST_SCOPES.transactions })` → `checkBaseCurrencyLock` → `ingestTokenRateLimit` (30/min per token) → `controllers/ingest/card-payment.controller.ts` → `ingestCardPayment`.
  - Three transactions: tx 1 in `record-request.ts` (`IngestRequests`, unique `(userId, idempotencyKey)`), tx 2 in `process-ingest-request.ts` (row lock, 120 s repeat window via `computeFingerprint` and `pg_advisory_xact_lock`), tx 3 in `park-failed-request.ts`.
  - `process-card-payment.ts` does mapping → currency → conversion → payee (`resolvePayeeForIncomingRow`, threshold 1) → history category → `createTransaction`. The row is planned on connected accounts, and `externalReference` is `<source>:<key>`. The answer waits up to `cardPaymentTimings.aiWaitBudgetMs` (8 s).
  - `IngestRequests.source` is the **client's** label (`^[a-z0-9-]{1,32}$`, default `card-payment`); the shipped shortcut sends `apple-pay` (`build-card-payment-shortcut.ts`). No column says which pipeline a row belongs to.
  - The setup code (`packages/shared/src/types/ingest/card-payment-setup-code.ts`) is `v1.` + base64 JSON `{ v, url, token, cfAccessId?, cfAccessSecret? }`. The decoder ignores unknown keys.
  - `IngestSettings` holds the Cloudflare Access headers; `CardAccountMappings` holds card links; retention is `crons/ingest-requests-cleanup.ts`.
  - Migration `20261017020000-card-payment-ingest.ts` is already on `dev`, so a new migration is needed (repo rule 11).
- **Payees:** `Payees`, `PayeeAliases` (`rawName`, `normalizedName`), `PayeeIgnoredNames`.
  - `services/payees/`: `normalizePayeeName`, `resolveNormalizedName`, `ensureAliasExists`, `isPayeeNameIgnored`, the Fuse matcher (`buildHaystack`, `buildFuzzyIndex`), `resolvePayeeForRawMerchant`; `payees.service.ts` has `createPayee` (throws `ConflictError` on a taken name or alias) and `createPayeeAlias`.
  - MCP tools `update-payee` and `delete-payee-alias`. No `pg_trgm`.
- **Reconciliation** (`services/transactions/reconciliation/`):
  - Services: `mergeTransactions`, `removeTransactions`, `restoreTransactions`, `getReconciliationHistory`.
  - `loadReconcilableRows` (`helpers.ts`) rejects system rows and planned rows.
  - `softDeleteTransactions` runs with hooks off and with `planned: 'exclude'`; its comment says bank balances are authoritative. On a manual account, the hidden amount would stay in the balance (`@BeforeDestroy` normally calls `updateAccountBalanceForChangedTx` + `Balances.handleTransactionChange` for `ACCOUNT_TYPES.system`).
  - `mergeTransactions` does **not** call `planEditMerge`. That policy lives in `services/bank-data-providers/enablebanking/utils/plan-edit-merge.ts` and treats a note different from the sync note, or a payment type other than `bankTransfer`, as a user edit.
  - Chat tools `merge_duplicate_transactions` and `remove_duplicate_transactions` have the preview `services/chat/proposals/previews/reconciliation.ts`, which refuses planned rows.
  - Transaction hard deletes go through `destroyTransactions`/`deleteTransactionById` with `force: true` (`transactions.model.ts`).
- **Chat:**
  - `ChatProposals` rows come from `createProposal({ run, … })` in `services/chat/proposals/create-proposal.ts`. Its private `storeProposal` needs a toolkit run, and every card expires after `CHAT_PROPOSAL_LIFETIME_MS` (24 h).
  - `reject.ts` only flips the status. `comment.ts` (`POST /chat/proposals/:id/comment`) calls `startChatRun` directly, as does `sendMessage`.
  - `ChatThreads.pinned` exists: pinned threads list first and never expire (`computeThreadExpiry`). There is no kind and no archive.
- **Notifications and web push:**
  - `createNotification` (`services/notifications`) → `enqueueWebPushAfterCommit` → `services/web-push/push-queue.ts` (fan-out, delivery; `removeOnFail: { age: 3600 }`). `render-push-body.ts` renders per type; `build-push-payload.ts` sets `tag: notification.id`.
  - Groups are `reminders`, `bankSync`, `sharing`, `system`, `releases` (`packages/shared/src/types/web-push.ts`). `NOTIFICATION_PUSH_GROUP` and `PUSH_GROUP_DEFAULTS` are total.
  - Two compile-time checks also enumerate the groups: `ZodPushGroupsSchema` + `PushGroupsSchemaIsInSync` in `backend/src/models/user-settings.model.ts`, and `GROUP_ICONS` in `frontend/src/pages/settings/subpages/notifications/components/push-groups-card.vue` (its spec counts five switches).
  - The deep link comes from `frontend/src/components/notifications-popover/build-notification-route.ts`.
  - There is no per-thread presence: `sse-manager.ts` is per user, and runs stream on `GET /chat/runs/:runId/events`.
- **Guards:**
  - `routes/base-currency-guard-coverage.e2e.ts` fails on any mutating route that has neither `checkBaseCurrencyLock` nor a `GUARD_EXEMPT_ROUTES` entry.
  - `middlewares/entitlements.ts` `READ_ONLY_ROUTE_PATTERNS` (with `entitlements.unit.ts`) lists the writes a read-only plan may still make, including chat ones.
- **Backup** (`services/backup/registry.ts`): `BackupTableDef` has `restoreMode`, `stripSecret`, `isValidRow` and similar options, but nothing to null a column. `ChatProposals` is in `BACKUP_EXCLUDED`, and restore wipes chat rows first.
- **AI:**
  - `createAIClient`, `generateText` + `Output.object`, `aiCallGuards`, `trackAiUsage` → `recordAiSpend`; `createShortIds`.
  - The monthly cap (upstream `008b2cfef`) works through `isWithinAiAllowance` in the resolver; `connection-failure.ts` tells a spent cap from a missing connection.
  - Service-level `RateLimitService.checkRateLimit` is used in `budget-plans/suggested-lines-ai.ts`.
  - E2E tests mock AI over MSW; the template is `trackers/smart-tracking/run-tracker-scan.ts`.
- **Accounts:** `bankDataProviderConnectionId` links one connection's accounts; groups live in `models/accounts-groups/`; each account has one currency.
- **Frontend setup page:** route `/accounts/integrations/apple-pay` (`ROUTES_NAMES.accountApplePay`, `pages/accounts/integrations/apple-pay/`).
  - `apple-pay.ts` exports `CARD_PAYMENT_SHORTCUT_FILE_PATH`, `resolveShortcutHref` (prefers `config.cardPaymentShortcutIcloudUrl` on iOS) and `probeShortcutFile`; `composables/use-shortcut-link.ts` wraps them.
  - The settings route `integrations/*` redirects to the page. i18n: `settings.integrations.applePay.*`. Docs: `integrations/apple-pay.mdx`.
- **Shortcut generator:** `frontend/scripts/shortcuts/build-card-payment-shortcut.ts` (deterministic plist, drift spec, fixture `fixtures/transaction-input.xml`). The shortcut falls back to `response.message` for its notification.
- **iOS facts:**
  - Since iOS 26, Safari freezes the user-agent OS token at `iPhone OS 18_x`. A home-screen web app (standalone; the owner's setup) has no Safari `Version/` token at all. The UA cannot tell the iOS version.
  - Current link code: `resolveShortcutHref` prefers the iCloud link on iOS (detected by UA through `isIosDevice`) and the file elsewhere. `add-shortcut-button.vue` gives the file a `download` attribute, and the iCloud link gets `target="_blank"`. `setup-code-dialog.vue` copies with `navigator.clipboard.writeText`.
  - Owner's iPhone (`WFWorkflowClientVersion` 5037.111), **known:** `WFWorkflowTriggers` is an array of `{ WFTriggerIdentifier, WFTriggerSerializedParameters, WFTriggerUUID }`; the Notification trigger is `WFNotificationTrigger`; its filters serialize as a `WFContentPredicateTableTemplate`.
  - **Unknown:** the App parameter (and whether "any app" exists), the Wallet Transaction trigger's identifier, the input property names, whether Run Immediately is stored, whether signing keeps triggers.
  - Wallet sample: title `TBC Bank`, subtitle `Wolt`, body `GEL 43.60`.

## Decisions

Decisions marked **(owner-visible)** change what the owner sees, compared with earlier revisions or today's behavior.

- **One iOS 27 shortcut, both triggers.**
  - The shortcut branches on its input. If Merchant or Card is present, it sends `kind: walletTransaction`. Otherwise it runs the gate and sends `kind: notification`.
  - `kind` is required; the server never guesses.
  - Trigger scope: "any app" where iOS allows it. Otherwise Wallet is pre-filled, and the checklist asks the user to add Messages, the bank's app and the mail app.
  - URL: the setup code's `url` with its last segment replaced (`card-payment` → `event`).
  - iOS < 27 keeps the tap-only shortcut.
- **Two buttons, no detection (owner-visible; owner decision).**
  - The setup section shows two buttons side by side, **"Add shortcut — iOS 27 or later"** (`log-payments`) and **"Add shortcut — iOS 26 or earlier"** (`log-card-payment`). Each has its own short instructions in an expandable section underneath.
  - Nothing parses the user agent and nothing is remembered: no version detection, no pre-selection, no `localStorage`.
  - `isIosDevice` is removed from link resolution too: on every device the iCloud link wins when configured, and the file is the fallback.
- **Links and clipboard in the home-screen web app (owner-visible).** The owner runs MoneyMatter as a standalone PWA.
  - **Detecting standalone:** `isStandalone()` reads `matchMedia('(display-mode: standalone)').matches` or `navigator.standalone`. These are feature checks, not UA parsing.
  - **iCloud link (preferred):** opened with `window.open(url, '_blank', 'noopener')` from the click handler. In standalone mode iOS shows it in an in-app browser sheet, whose "Get Shortcut" button opens the Shortcuts app. In a normal tab it is an `<a target="_blank" rel="noopener">`.
  - **File fallback** (no iCloud link configured):
    - in a normal tab, today's `<a download>`;
    - in standalone mode, no `download` attribute, because a standalone PWA cannot hand a download to Shortcuts. The absolute file URL opens with `window.open(..., '_blank')` in the system browser sheet, which offers to open it in Shortcuts.
    - The docs and the button's hint recommend setting the iCloud links for PWA users.
  - **Copying the setup code:** `navigator.clipboard.writeText` runs synchronously inside the click handler, with no `await` before it, so iOS keeps the user gesture.
    - If it rejects, a fallback selects a hidden read-only `<textarea>` and runs `document.execCommand('copy')`.
    - If that fails too, the code shows in a read-only, auto-selected field with "Tap and hold to copy".
    - The QR code stays as the other path.
- **Banner: record, enqueue, wait on a budget.** The endpoint records the request (tx 1), enqueues `ingest-notification` without delay, and polls the row for up to `notificationTimings.waitBudgetMs` (10 s, 250 ms steps), as `aiWaitBudgetMs` does today.

  | Outcome                                            | Banner (`summary`)                                                                                                                            | `notify` |
  | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
  | logged                                             | "Logged 43.60 GEL at Wolt → Food"                                                                                                             | true     |
  | attached                                           | "Already logged 43.60 GEL at Wolt"                                                                                                            | true     |
  | parked                                             | "Needs your OK in MoneyMatter: 43.60 GEL at Wolt"                                                                                             | true     |
  | still running                                      | "Queued, will appear shortly"                                                                                                                 | true     |
  | ignored, dropped, duplicate                        | —                                                                                                                                             | false    |
  | 423 (base-currency change running)                 | "MoneyMatter is busy updating your currency. This payment wasn't saved, try again in a minute." (new `ingest.busy` message for ingest routes) | —        |
  | any other HTTP error (401/402/403/409/413/422/429) | the error `message`                                                                                                                           | —        |
  - **Errors always show (owner-visible).** The shortcut shows `summary` when `notify` is true. On any non-2xx answer it shows `response.message`, as the tap shortcut does today. Only `ignored`, `dropped` and `duplicate` stay silent.
  - **423 while the base currency changes (owner-visible).** `checkBaseCurrencyLock` stays on `POST /ingest/event` and `POST /ingest/card-payment`. The answer is 423 for both kinds, because nothing has been recorded yet.
    - For ingest routes the middleware's message is the ingest-specific `ingest.busy` text, picked by a `messageKey` option on `checkBaseCurrencyLock` (default unchanged).
    - **The shortcut retries once.** On 423 it waits 20 s (**Wait**) and sends the same body and idempotency key again. A still-locked second answer shows the busy banner.
    - Why once and short: a change usually takes seconds to a minute; an automation that runs much longer risks being killed in the background; and the identical key makes the retry safe.
    - What remains: a payment that hits a longer change is not saved. The banner says so, so the user can run the shortcut by hand or add the payment.
    - A request accepted **before** the lock was taken is safe: its job re-delays while the lock is held (Guards table) and completes afterwards.
  - **Why a job plus a wait:** retries with backoff, crash safety, AI concurrency through the queue, and the same path as a UI retry. A synchronous AI call would lose the payment on a timeout.
  - **Why no delay:** tier 1 runs under one per-user lock in both paths, so order does not matter, and AI never attaches anything.
  - **Job ids:** each attempt gets its own id, `${requestId}-${attempt}` (`IngestRequests.attempts` is incremented when enqueuing; BullMQ rejects custom ids containing `:`, so every id in this plan joins its parts with `-`). The queue sets `removeOnComplete: true` and `removeOnFail: { age: 3600 }`. A UI retry therefore always enqueues, even while the failed job is still retained.

- **Three privacy layers:**
  1. **On-device gate.** **Match Text** on title + subtitle + body, then **If** no match → **Stop**. These are built-in actions; no Apple Intelligence is required.
     - The regex comes from the setup code's optional `gate`; the built-in standard pattern is the fallback.
     - Patterns live once in `packages/shared/src/types/ingest/amount-gate.ts` (ICU syntax, valid in Shortcuts and JavaScript), with shared samples.
  2. **Server prefilter, before anything is stored:**
     - no amount → dropped (`noAmount`);
     - **OTP, narrowed (owner-visible):** dropped as `security` only when the text asks the user to enter, confirm or not share a code, and a standalone 4–8 digit code is present. Request phrases are kept per language: enter / confirm / do not share / введите / подтвердите / не сообщайте / შეიყვანეთ / …. Phrases like "auth code", "approval code" or "код авторизации" mark a completed payment; they override the rule and the text goes on;
     - a strong promo marker with no card digits or balance → `promo`;
     - a muted source → `muted`;
     - **our own output → `self`:** the Shortcuts app (`com.apple.shortcuts`, or a localized "Shortcuts" name), the MoneyMatter home-screen web app (its app name, and the bundle iOS reports for web-app notifications, from the device capture), and any text that starts with one of our banner or push templates in the user's locale (`formatSummary` prefixes such as "Logged ", "Already logged ", "Needs your OK" and "Queued, ", plus the `render-push-body.ts` titles). This never creates a source.

     On the device, the shortcut checks the input's app and bundle **before** Match Text: if it is Shortcuts or MoneyMatter, it stops. Without that, our own "Logged 43.60 GEL …" banner would fire the any-app trigger again.

     A drop is answered `200 dropped` and **not stored**: only a counter changes, and only on a source that already exists. A conversational source row is created only after the prefilter passes.

  3. **Source approval: fail closed (owner-visible).** Every new source starts `pending`, except Wallet (`com.apple.Passbook`) and a small seed list of known bank apps in `notification-sources.ts`, which start `auto`.
     - A pending source's first notification creates an inbox card ("Treat <app or sender> as a payment source?").
     - Its notifications park as `sourceNotApproved` **without an AI call**.
     - Approving the source processes what it holds. Muting it deletes what it holds.
     - Messaging and mail apps (a list of bundle ids and names) are additionally split **per sender** (`app + title`), so approving "Messages · TBC" does not approve every chat.

- **Text at rest (owner-visible; reconciles "non-payment text is never stored").** Notification text (title, subtitle, body, `raw`) never sits in plain JSON. It is stored only as `IngestRequests.textEnc`, encrypted with `encryptToken` (AES-256-GCM, `common/utils/encryption.ts`). `payload` keeps only non-text metadata: app, bundle id, time and key.
  - **Not a payment (AI-classified):** in the classifying transaction, `textEnc` and `summary` are nulled and `parsed` is reduced to `{ parser, kind, confidence }`, so no merchant, card digits or balance stay in plain JSON. The hash, kind and reason stay, and the row is deleted after 7 days.
  - **Not yet classified** (`sourceNotApproved`, `aiUnavailable`, `aiCapReached`, `aiLimitReached`, `processingFailed` on a notification): `textEnc` is kept **at most 7 days**, then the row is deleted and a counter records it.
  - **Payments:** `textEnc` is kept under the existing 90-day retention, for review and retry.
  - **Repeats:** a repeat folded into an `ignored` or dropped original stores no text.
  - **Pending sources:** a pending source with no approval for 30 days is deleted with everything it holds, so an unapproved contact's name does not linger in backups.
  - **Why hold text at all:** dropping held text would silently lose the first payments from a new bank app or SMS sender. Encrypted, short-lived text that only the job decrypts is the smaller risk. The inbox card shows only the amount the gate matched (≤ 32 characters), never the message.
- **Configurable gate strictness** (`IngestSettings.gateStrictness`, default `standard`):
  - `strict`: an ISO code or currency symbol adjacent to the number;
  - `standard`: also local currency words, with a code or symbol up to 3 characters away;
  - `loose`: also a two-decimal number with no currency.

  The server uses the same level as the shortcut. Changing the level needs a new setup code.

- **Pipeline column.** A new server-set `IngestRequests.pipeline` (`cardPayment` | `notification`, backfilled to `cardPayment`) is the discriminator for list, retry, retention, summaries and inbox wiring. `source` stays the client's label and is never branched on.
- **Limits:**
  - The existing 30/min per token stays.
  - Notifications: **service-level** `RateLimitService.checkRateLimit` in `ingest-event.ts`, with two keys (`ingest-event:h:<userId>` 120/hour and `ingest-event:d:<userId>` 1000/day), checked **after** the prefilter and only for `kind: notification`. Over the limit → 429, and the source counter `rateLimited` increments.
  - `INGEST_AI_DAILY_LIMIT` (300, Redis counter) counts parsing and judge calls; over it → `aiLimitReached`.
  - A spent monthly cap → `aiCapReached` (detected as in `connection-failure.ts`).
  - Every call goes through `trackAiUsage`. Wallet notifications need no AI.
- **What gets logged:**
  - `debit` → expense;
  - `credit` → income;
  - `declined`, `security`, `promo`, `info`, `other` → ignored (text wiped).
  - Own-account transfers (`ownTransfer`) and confidence < 0.6 (`lowConfidence`) park for approval via inbox cards.
- **Wallet in code, the rest by AI.** A Wallet body that is only an amount `parseAmount` accepts is a `debit`: card = title, merchant = subtitle, payee via `resolvePayeeForIncomingRow`. Without any AI client, other text parks as `aiUnavailable`.
- **Two AI features:** `notificationParsing` and `duplicateMatching`.
- **Payee resolution in the parse call:**
  1. **Exact lookup first.** If the raw merchant resolves through `resolveNormalizedName`, use that payee and ignore the AI's payee answer.
  2. **Otherwise up to 15 candidates in the prompt:**
     - token matches (`ILIKE` on `PayeeAliases.normalizedName` and payee names; tokens of 3+ characters that are not digits and not `generic-merchant-words`);
     - Fuse top matches;
     - the source's 5 most recent payees.

     The AI returns `{ candidateId }` or `{ newName }`, with explicit rules:
     - same business only;
     - ignore `SP *`, `SQ *`, `PAYPAL *`, `GOOGLE *`, `.COM`, city or country, store numbers and casing;
     - never match on a generic word alone;
     - otherwise give a clean brand name.

  3. **`applyPayeeChoice`** (`ingest/event/apply-payee-choice.ts`):
     - a candidate becomes the `payeeId`;
     - a raw spelling that normalizes differently is saved with `ensureAliasExists`, unless `isPayeeNameIgnored` or it resolves to another payee;
     - for `newName`: first `resolveNormalizedName(newName)`, and **adopt** any hit instead of creating, so `createPayee` never throws `ConflictError`. If the raw merchant is ignored, no payee is created and the row is logged without one, as the resolver does. Otherwise `createPayee` + the raw alias + logo resolution.

- **Bank balances.** `parsed.balanceAfter = { amount, currency, authoritative, scopeHint }`.
  - **Same bank:** the account's connection, plus the accounts this source logged to or defaults to, plus the account group.
  - **Authoritative** only when every other-currency same-bank account is zero.
  - The prompt names the currencies with non-zero balances. `scopeHint: 'total'` makes the balance non-authoritative.
  - Nothing uses an authoritative balance yet.
- **Sources** (`NotificationSources`):
  - key: bundle id or normalized app name, plus the sender for messaging and mail apps;
  - fields: `mode` (`auto` | `pending` | `approved` | `muted`), `defaultAccountId`, counters.
- **Account resolution:** card name → `lastDigits` → source default → park `unknownAccount`. A heuristic guess is pre-filled in the inbox card.
- **Dedup:**
  - **Slots.** A row holds at most one request per slot: `tap`, `wallet-notification`, `bank:<sourceKey>:<stage>`.
  - **Tier 1, exact twin (automatic).**
    - Rules, all required, under the per-user lock in both paths:
      - same account and direction;
      - a free slot;
      - exact amount and currency, or the same original amount and currency;
      - within 30 minutes;
      - no `isSameShop` veto.
    - **Several qualifying candidates (owner-visible):** they are interchangeable (same amount, no veto between them), so attach to the **earliest** one with a free slot. Two coffees therefore stay two rows in every arrival order.
  - **Settlement rule (automatic).** A `settlement`-stage bank notification attaches to the earliest row that meets all of these:
    - it holds the **same source's** `authorization` slot, and its `settlement` slot is free;
    - the amount is the same, or the original amount is the same;
    - the normalized merchant text is the same;
    - it is at most 7 days old.

    Anything looser becomes a tier-2 suggestion.

  - **Fold window (owner-visible).** The text fingerprint folds a repeat only when the times are within 5 s: the same notification on two devices, or a double fire. The time is the notification's own date when iOS exposes it, else the shortcut's run time **to the second**, which also goes into the idempotency key. Two identical Wallet payments minutes apart become two rows.
  - **Tap fold, made consistent (owner-visible; changes shipped behaviour).** Every shipped shortcut sends `time`. The tap shortcut fills it with the **run time** (Current Date, `build-card-payment-shortcut.ts`), because the Transaction input has no date; `parse-payload.ts` accepts it. A "no `time`" branch therefore never runs for a shortcut. The rule is restated around what `time` actually means:
    - **`timeSource`.** A new optional body field, `run` | `transaction`. The iOS 27 shortcut sends `transaction` only if the device capture shows that the Transaction input has its own date; otherwise it sends `run`. A request without `timeSource` (the shipped tap shortcut, other clients) counts as `run`. It is stored in `parsed`/`payload` and never trusted beyond the fold.
    - **Run time (the common case): fold within 20 s.** `findOriginalInWindow` (`card-payment/process-ingest-request.ts`) folds a same-fingerprint request whose `time` is within `repeatWindowRunTimeMs` (20 s) of the original's.
      - A double fire of one payment produces two runs from the same event, normally a second or two apart.
      - Low Power Mode, a locked phone or a slow network delay a run, but they delay the whole automation, so both firings usually slip together. 20 s leaves room for one of the two runs stalling on its own.
      - Two genuine identical payments need a second terminal transaction (the merchant keys the amount again, the user taps again), which takes about 30 s or more. The window stays below that floor, so two coffees a minute apart stay two rows.
    - **Transaction time: fold within 2 s** (`repeatWindowTransactionTimeMs`), applied only when **both** requests carry `timeSource: transaction`. One payment has one timestamp, so only the same payment matches.
    - **No `time` at all** (API clients): today's 120 s receipt window (`repeatWindowMs`), unchanged.
    - **What can still go wrong:**
      - A double fire where one run is held back for more than 20 s logs two rows. Both are ingest rows with the same amount and merchant, so the tier-2 judge raises a suggestion; nothing merges silently.
      - The shipped tap shortcut's idempotency key is cut to the **minute** (`KEY_TIME_FORMAT`), so two identical taps within one calendar minute still share a key and the second replays as `duplicate`. That is a key collision the server cannot tell from a retry. The new shortcut keys to the second. Task 15 also changes the legacy generator's `KEY_TIME_FORMAT` to seconds, and the re-signed file fixes it for users who re-import; until then it is a documented limit.
    - `card-payment/constants.ts`: `repeatWindowRunTimeMs: 20_000` and `repeatWindowTransactionTimeMs: 2_000` are added, and `repeatWindowMs: 120_000` stays for requests without `time`. On iOS 27 the Wallet notification adds a second check: a folded second coffee still gets its own row from its own notification, because the first row's `wallet-notification` slot is taken.
  - **Tier 2, AI judge: suggestions only.**
    - It runs **after** the logging transaction commits (as `categorize-after-commit.ts` does), never inside the dedup lock.
    - A match with confidence ≥ 0.6 stores a suggestion with `INSERT … ON CONFLICT DO NOTHING` on the ordered pair.
    - The scan job (after `TRANSACTIONS_SYNCED` and statement import) does the same. No AI auto-attach, no AI auto-merge.
  - **Suggestion lifecycle.**
    - `transactionId`/`candidateId` are **nullable FKs with `ON DELETE SET NULL`**.
    - `markSuggestionsStale({ transactionIds })` runs from `deleteTransaction`, the bulk delete and reconciliation remove. It flips open suggestions to `stale` and resolves their cards.
    - A sweep in the cleanup cron and the scan job catches rows with a null side left by other delete paths: sync removals and import rollback.

- **Enrichment:**
  - the bank's account-currency amount wins, and the charged currency stays as `originalAmount` (through `updateTransaction`);
  - a missing payee is filled;
  - differing spellings become aliases;
  - `externalData.ingest.sources[]` records every source and `balanceAfter`;
  - `externalData.ingest.systemNote` records the note the pipeline wrote.
- **Reconciliation widens** (`services/transactions/reconciliation/helpers.ts`, `merge-transactions.ts`, `restore-transactions.ts`):
  - **System rows:** `softDeleteTransactions` withdraws a system row's amount, as `@BeforeDestroy` does, and restore re-adds it. Its comment is rewritten.
  - **Ingest plans:** `softDeleteTransactions` changes `planned: 'exclude'` to `'include'` for ingest plans. A plan is never the survivor when a booked row is merged with it.
  - **Edit merge:** `mergeTransactions` calls a new `planReconciliationEditMerge` (`reconciliation/edit-merge.ts`), which wraps `planEditMerge`.
    - Each side's machine baseline comes in: `externalData.ingest.systemNote`, or the provider note, as the sync note.
    - The machine-written payment type is passed too: `mobilePayment` for ingest rows, `bankTransfer` for bank rows. `planEditMerge` gains optional `orphanMachinePaymentType`/`canonicalMachinePaymentType`, defaulting to `bankTransfer`.
    - **Machine categories:** a non-manual `categorizationMeta` (`ai`, `mcc_rule`, `user_rule`, `subscription_rule`, `payee_rule`) is already not a user signal in `planEditMerge`. An ingest row's unstamped category is the pipeline's own pick (the history category, a hint-mode payee default or the default category). `logIngestedPayment` records it as `externalData.ingest.systemCategoryId`, and legacy `cardPayment` rows without it count the same. The wrapper passes `orphanMachineCategoryId`/`canonicalMachineCategoryId`, new optional `planEditMerge` params; a side whose `categoryId` equals its machine category and whose meta is null signals `none`. So only a manual stamp can raise `category_conflict`, and two ingest rows with different history categories merge, keeping the survivor's.
    - Only real user edits can conflict, and a conflict rejects the merge with its reason.
  - **Survivor:** a booked bank or imported row, else the earliest ingest row.
  - The chat preview `reconciliation.ts` accepts the same rows.
- **Automation inbox:**
  - **The thread.**
    - `ChatThreads.kind` (`chat` | `automationInbox`) and `ChatThreads.inboxState` (`live` | `open` | `closed`; null for chat threads).
    - Title "Automation inbox", `connectionId` null.
    - **No AI, ever.** `startChatRun` refuses any thread of kind `automationInbox` with 409, which covers `sendMessage` and `commentOnProposal` alike. The UI hides the composer and the card comment control.
  - **Exactly one live thread:**
    - a partial unique index on `(userId) WHERE inboxState = 'live'`;
    - find-or-create and rollover run under `pg_advisory_xact_lock('chat-inbox:<userId>')`.
  - **Rollover:** a live thread with no pending card that is 7 days old or holds 200 cards turns `closed`, and the next item opens a new `live` thread.
    - **(owner-visible)** A live thread that reaches 200 cards **while cards are pending** turns `open`: no new items, but it stays pinned and protected until its last pending card resolves, then `closed`.
    - **Pinned** means `inboxState ∈ {live, open}`; `closed` threads are unpinned and expire as normal chats.
  - **Protection:** `DELETE` and `PATCH { pinned: false }` answer 409 for a `live` or `open` thread.
    - **Clear resolved** (`POST /chat/threads/:id/clear-resolved`) deletes messages whose cards are not pending.
    - **Archive** (`POST /chat/threads/:id/archive`) closes a live thread early; it answers 409 while a card is pending.
  - **Cards:** `create-proposal.ts` exports a run-free `storeProposal({ userId, threadId, messageId, replaces?, expiresAt, values })` that `createProposal` and the new `createSystemProposal` both call.
    - Inbox cards expire after `inboxConfig.cardTtlDays` (30). The `CHAT_PROPOSAL_LIFETIME_MS` comment names that exception.
    - Expiry resolves nothing: the record stays open in Reconciliation or the waiting list.
    - **Expiry re-evaluates the thread.** `expireDueCards`/`expireAllDueCards` (`chat/proposals/card-expiry.ts`) return the affected thread ids and call `reevaluateInboxThreads({ threadIds })`. An `open` thread whose last pending card expired turns `closed` and is unpinned. The cleanup cron runs the same check as a backstop.

    | Item                                          | Tool                           | Approve | Edit               | Reject          |
    | --------------------------------------------- | ------------------------------ | ------- | ------------------ | --------------- |
    | duplicate suggestion                          | `merge_duplicate_transactions` | merge   | survivor           | dismiss         |
    | unknown account, own transfer, low confidence | new `log_ingest_request`       | log     | account, direction | dismiss request |
    | pending source                                | new `set_notification_source`  | approve | default account    | mute            |

  - **Two-way sync** (`chat/inbox/inbox-items.ts`):
    - records hold `proposalId` (`DuplicateSuggestions`, `IngestRequests`, `NotificationSources`; nullable FK, `SET NULL`);
    - `reject.ts` calls `onInboxCardRejected({ proposalId })` inside its transaction;
    - resolving a record elsewhere rejects the card with `statusReason: 'resolvedElsewhere'`.
  - **Backup:** `BackupTableDef` gains `nullOnRestore?: readonly string[]`. The entries for `NotificationSources` and `DuplicateSuggestions` set `['proposalId']`, because `ChatProposals` is never backed up. `IngestRequests` stays excluded.

- **Web push for the assistant:**
  - A new group `assistant` (default on), owned by Task 11, which also updates `ZodPushGroupsSchema` and `GROUP_ICONS`.
  - Types go through `createNotification` → `enqueueWebPushAfterCommit` → `push-queue.ts`:

    | Type               | When                                                                                                  | Deep link                                                                          | Collapse                     |
    | ------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------- |
    | `chatReplyReady`   | a run in a `chat` thread finished or failed and the thread is not being viewed                        | `chatThread`                                                                       | per thread, 5 min            |
    | `chatCardsWaiting` | that run left pending cards                                                                           | `chatThread`                                                                       | merged into the run's push   |
    | `automationInbox`  | new inbox items                                                                                       | `chatThread` (live inbox)                                                          | one per 10 min, with a count |
    | `ingestAttention`  | a park **without a card**: `ai*`, `rateUnavailable`, `processingFailed`, the tap path's `unknownCard` | the setup page (`accountApplePay` until Task 13 renames it `accountIosAutomation`) | per reason, per day          |

  - **No double push:** items with cards push only as `automationInbox`.
  - **Presence:** `PUT /chat/presence { threadId }` every 20 s while a thread is visible and focused, and `DELETE` on leave. It is stored in Redis as `chat:presence:<userId>:<threadId>` with a 45 s TTL. A reader of the run's event stream also counts.
  - **Debounce:** a delayed BullMQ job (`assistant-push`, 60 s, `jobId` = `assistant-<type>-<userId>-<threadId or reason>-<windowStart>`, joined with `-`, never `:`) plus a Redis counter and a cooldown key. The tag is `assistant:<threadId>` (`build-push-payload.ts` takes a per-type tag).
  - **Read state:** opening a thread marks its pushes read; opening the iOS Automation page marks `ingestAttention` read.
  - **Bodies:** no AI or notification text; only counts, the thread title and the reason.

- **Page renamed "iOS Automation":**
  - route `/accounts/integrations/ios-automation` (`ROUTES_NAMES.accountIosAutomation`), with redirects from `/accounts/integrations/apple-pay` and the settings `integrations/*`;
  - folder `ios-automation/`;
  - i18n `settings.integrations.iosAutomation.*` (`en` + `uk`);
  - docs `integrations/ios-automation.mdx`, with a redirect.
  - The **Add Shortcut** link is parameterized per shortcut: `resolveShortcutHref`, `probeShortcutFile` and `useShortcutLink` take `{ filePath, icloudUrl }`. A new runtime config `PAYMENTS_SHORTCUT_ICLOUD_URL` (`window.__APP_CONFIG__`, `self-hosting/frontend/docker-entrypoint.sh`, env reference) keeps the iOS 27 button from opening the tap shortcut's iCloud link.
- **Guards** (each task adds its routes to the coverage test, and to `READ_ONLY_ROUTE_PATTERNS` where noted):

  | Route                                                                                                      | Classification                                                                                                                                                                                                                                          |
  | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `POST /ingest/event`                                                                                       | `checkBaseCurrencyLock`                                                                                                                                                                                                                                 |
  | `POST /transactions/reconciliation/suggestions/:id/dismiss`                                                | `checkBaseCurrencyLock`                                                                                                                                                                                                                                 |
  | `PATCH/DELETE /user/settings/notification-sources/:id`, `PUT /user/settings/card-payments/gate-strictness` | exempt: approving a source only **enqueues** its held requests, and the job applies the lock (next row)                                                                                                                                                 |
  | `ingest-notification` job (no route)                                                                       | `processNotification` calls `isBaseCurrencyChangeLocked({ userId })` first. While locked, it re-delays itself by 60 s (`job.moveToDelayed` + `DelayedError`, so no attempt is used) and leaves the request `received`; the banner poll answers "Queued" |
  | `POST /chat/threads/:id/clear-resolved`, `/archive`                                                        | exempt (chat housekeeping); read-only allowed                                                                                                                                                                                                           |
  | `PUT/DELETE /chat/presence`                                                                                | exempt (presence); read-only allowed                                                                                                                                                                                                                    |
  | card approval                                                                                              | the existing `POST /chat/proposals/:id/approve` (already guarded)                                                                                                                                                                                       |

## Development Approach

- **TDD.** Each task writes failing tests first and records that they fail on assertions.
  - AI is mocked over MSW in e2e and with `jest.mock('ai')` in unit tests.
  - **Every gate uses only endpoints that exist by that task.**
- **Node:** prefix every node/npm command with `export PATH="$(mise where node@24.21.0)/bin:$PATH"`.
- **Commands:**
  - backend unit: `cd packages/backend && npm run test:unit -- --testPathPattern='<regex>'`;
  - backend e2e, never in parallel: `cd packages/backend && lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='<regex>'`;
  - frontend: `cd packages/frontend && npm run test:unit -- --run <path>`;
  - root: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run knip`.
- **Subagents and skills:** `test-runner`, `linter`, `i18n-editor` (`en` + `uk`), and the `add-mcp-tool` skill.
- **Repo rules:** one task at a time; object params; kebab-case files; comments describe current code; `Money` everywhere; one migration for the branch.
- **Commits:** none by implementing agents unless the owner asks (rule 10).

## Testing Strategy

- **Unit:**
  - gate patterns per level (shared samples, also used by the shortcut spec);
  - prefilter blocks, including the narrowed OTP rule with "auth code" payments passing;
  - kind validation, the fingerprint with the 5 s window, `textEnc` round-trip;
  - Wallet parser, AI output validation, payee candidates, `applyPayeeChoice` branches;
  - balance authority, AI daily counter, source keys and default modes;
  - account order, slots, the twin rule (earliest of interchangeable), the settlement rule, judge mapping, survivor choice, `planReconciliationEditMerge`;
  - inbox states, push debounce, presence, push bodies, `nullOnRestore`.
- **E2E**, per task as listed. Highlights:
  - banner outcomes and error banners;
  - drops leave no row;
  - two identical Wallet payments minutes apart give two rows;
  - a pending source holds encrypted text until it is approved;
  - payee alias learning;
  - multi-currency balances;
  - the dedup permutations (tap, tap, notification, notification included);
  - manual-account reconciliation balances;
  - ingest↔ingest merge without a note conflict;
  - suggestion stale on delete;
  - inbox single-live under concurrency;
  - comment 409 in the inbox;
  - reject hook;
  - restore with `proposalId` set;
  - a retry after `processingFailed`;
  - push collapse and presence.
- **Frontend vitest:** the two shortcut buttons (no UA reads), standalone link handling (`window.open` vs anchor, no `download` in standalone), the clipboard fallbacks, parameterized shortcut links, route redirects, sources, the Suggestions tab, the inbox view (no composer, no comment), the push toggle, presence.
- **Playwright:** approve an inbox card; merge a suggestion and see its card resolved.

## Progress Tracking

- Mark completed items `[x]` immediately; ➕ for new tasks, ⚠️ for blockers.
- Note each gate's command and result under the task.

## Solution Overview

```
iOS 27 shortcut "MoneyMatter: log payments" (WFWorkflowTriggers: Wallet Transaction + Notification)
  decode setup code → url := last segment → "event", gate := code.gate ?? built-in standard
  ├─ Merchant/Card present → POST {kind:"walletTransaction", …, idempotencyKey}
  └─ else Match Text(gate) → If no match: Stop → POST {kind:"notification", app, bundleId, title, subtitle, body, time, raw, idempotencyKey}
  → 2xx: If notify → Show Notification(summary);  non-2xx → Show Notification(message)

/ingest/event → auth → base-currency lock → token limit → controller
  ├─ walletTransaction → ingestCardPayment (pipeline cardPayment) → 200 {summary, notify:true}
  └─ notification → prefilter ─drop→ counter → 200 {dropped}
       → service rate limit (hour/day) → tx 1: IngestRequests (pipeline notification, textEnc) + source upsert
       → enqueue job (`${requestId}-${attempt}`) → poll ≤ 10 s → 200 {outcome, summary, notify}

ingest-notification job:
  fold repeat (fingerprint, ±5 s) → source pending? park sourceNotApproved (+ inbox card)
  → parse: Wallet layout | AI notificationParsing (payee candidates, balance context; daily limit, cap)
  → not a payment: wipe textEnc → ignored | park ownTransfer/lowConfidence/ai* (+ card or ingestAttention)
  → account → tx: per-user lock → tier-1 twin | settlement rule → attach + enrich | log (logIngestedPayment)
  → after commit: tier-2 judge → suggestion (+ inbox card)

duplicate-scan job (TRANSACTIONS_SYNCED, statement import) → judge → suggestions (+ cards)
Inbox (pinned, no AI) ⇄ Reconciliation Suggestions ⇄ waiting list: same records via proposalId
```

- **Data** (one migration, `migrations/20261020120000-notification-ingest.ts`):
  - `IngestRequests` + `pipeline` (varchar 16, not null, backfilled `cardPayment`), `textEnc` (text), `parsed` (JSONB), `attempts` (int, default 0), `sourceId` (FK `NotificationSources`, set null), `proposalId` (FK `ChatProposals`, set null); `status` gains `ignored`.
  - `IngestSettings` + `gateStrictness`.
  - `CardAccountMappings` + `lastDigits` (partial unique).
  - `ChatThreads` + `kind` (default `chat`) + `inboxState` (null); partial unique index on `(userId) WHERE "inboxState" = 'live'`.
  - `NotificationSources`: `id`, `userId`, `sourceKey`, `appName`, `bundleId`, `sender`, `conversational`, `mode`, `defaultAccountId` (FK, set null), `counters` (JSONB), `proposalId` (FK, set null), `lastSeenAt`, timestamps; unique on `(userId, sourceKey)`.
  - `DuplicateSuggestions`: `id`, `userId`, `accountId`, `transactionId`/`candidateId` (nullable FKs, **set null**), `confidence`, `reason`, `trigger`, `status` (`open` | `merged` | `dismissed` | `stale`), `proposalId` (FK, set null), `resolvedAt`, timestamps; unique on the ordered pair.
- **Services:**
  - `ingest/event/*`, `ingest/log-ingested-payment.ts`, `ingest/dedup/*`;
  - `chat/inbox/*`, `assistant-push/*`;
  - `transactions/reconciliation/{edit-merge,duplicate-suggestions}.ts`.

## Technical Details

- **Request body** (16 KB `largePaths` entry in `packages/backend/src/setup-middleware.ts`):
  - `kind` (required), `idempotencyKey` (`^[\x21-\x7E]{8,128}$`);
  - walletTransaction fields as in the card-payment API;
  - notification fields: `app`, `bundleId`, `title`, `subtitle`, `body` (aliases `appName`/`sourceApp`, `message`/`text`), `time`, `raw` (≤ 8 KB);
  - `source` (label only), `dryRun`.
- **Responses:**
  - `{ outcome, summary?, requestId?, reason?, notify }` with outcomes `logged`, `attached`, `parked`, `queued`, `ignored`, `dropped` and `duplicate`;
  - errors use the standard envelope, and the shortcut shows their `message`.
- **Prefilter result:** `{ pass, reason?, hints }`. Markers live per language in `prefilter-markers.ts` and cover OTP requests, payment codes and promo.
- **Fingerprint:** SHA-256 over source key + title + subtitle + body. A repeat folds only when `|Δtime| ≤ 5 s`.
- **AI parse schema** (`notification_parse`):
  - `kind`, `stage`, `isOwnAccountTransfer`;
  - `amount`, `currency`, `originalAmount`, `originalCurrency`;
  - `merchant`, `payee` (`{ candidateId }` | `{ newName }` | null);
  - `cardName`, `cardLastDigits`, `balanceAfter` (with `scopeHint`), `occurredAt`, `confidence`.

  The text is wrapped as untrusted, the call has no tools, and every field is validated.

- **Reasons:**
  - park: `unknownAccount`, `sourceNotApproved`, `aiUnavailable`, `aiCapReached`, `aiLimitReached`, `ownTransfer`, `lowConfidence`;
  - ignore: `declined`, `security`, `promo`, `info`, `other`;
  - drop counters: `noAmount`, `security`, `promo`, `muted`, `self`, `rateLimited`, `expiredUnclassified`.
- **Constants** (objects, so tests can shorten them):
  - `notificationTimings`: wait 10 s, poll 250 ms, fold 5 s, lock retry delay 60 s, interrupted after 30 min, unclassified text TTL 7 days, pending-source TTL 30 days;
  - `cardPaymentTimings` (existing): `repeatWindowRunTimeMs` 20 s, `repeatWindowTransactionTimeMs` 2 s, `repeatWindowMs` 120 s for requests without `time`;
  - `dedupConfig`: twin 30 min, settlement 7 days, judge 72 h, tolerance `CARD_PAYMENT_AMOUNT_TOLERANCE`, suggest ≥ 0.6, 5 candidates;
  - `inboxConfig`: 7 days, 200 cards, card TTL 30 days;
  - `assistantPushConfig`: debounce 60 s, thread cooldown 5 min, inbox 10 min, ingest 24 h, presence TTL 45 s, heartbeat 20 s.
- **Locks:** `ingest-dedup:<userId>` (twin and settlement), `chat-inbox:<userId>` (inbox find-or-create and rollover).
- **Retention** (`crons/ingest-requests-cleanup.ts`):
  - ignored requests: 7 days;
  - unclassified text: 7 days (row deleted, counter `expiredUnclassified`);
  - payments: 90 days;
  - pending sources: 30 days without approval;
  - suggestions: `merged` and `stale` after 90 days, `dismissed` kept;
  - the null-side suggestion sweep runs here too.

## What Goes Where

- **Implementation Steps:**
  - backend: schema, endpoint and settings, parsing, processing, dedup, reconciliation, inbox, push;
  - frontend: push, rename and setup, Reconciliation and the inbox;
  - the shortcut after the device capture;
  - docs.
- **Post-Completion:** device capture, signing, Cloudflare Access, deployment, branch consolidation, upstream.

## Implementation Steps

### Task 1: Schema and shared types

**Files:**

- Create: `packages/backend/src/migrations/20261020120000-notification-ingest.ts`, `packages/backend/src/models/{notification-sources,duplicate-suggestions}.model.ts`
- Modify: `packages/backend/src/models/{ingest-requests,ingest-settings,card-account-mappings,chat-threads}.model.ts`
- Modify/Create: `packages/shared/src/types/ingest/{index,amount-gate,notification-sources}.ts` (statuses, reasons, `pipeline`, gate patterns and samples, `buildSourceKey`, the seed lists of conversational and known-bank apps), chat thread `kind`/`inboxState` types
- Modify: `packages/backend/src/services/backup/registry.ts` (new entries; the `nullOnRestore` option on `BackupTableDef`), `packages/backend/src/services/backup/restore/restore-tables.ts` (applies `nullOnRestore` next to `stripSecret`/`isValidRow`), `packages/backend/src/services/user/wipe-user-data.service.ts`
- Modify: `packages/frontend/src/pages/accounts/integrations/apple-pay/components/waiting-payments.vue`. It gets an `ignored` entry in the exhaustive `STATUS_VARIANTS: Record<IngestRequestStatus, Variant>`, so the root typecheck passes, plus its status label key (`en` + `uk`)

- [x] write failing tests:
  - `registry.unit.ts` lists the new models;
  - a unit test for `nullOnRestore` (a row's `proposalId` comes out null);
  - `amount-gate.unit.ts` (samples per level; negatives: plain codes, phone numbers, dates, chat text without a currency);
  - `buildSourceKey` (sender appended only for conversational apps), and default modes (Wallet and the seed banks `auto`, everything else `pending`)
- [x] migration with `down` (includes the `pipeline` backfill and the partial unique indexes); models; shared types. The push group is **not** touched here (Task 11 owns it).
- [x] gate: unit `--testPathPattern='(backup/registry|amount-gate|notification-sources)'`; `npm run typecheck`

### Task 2: Event endpoint, prefilter, limits, source and card-link settings

**Files:**

- Create: `packages/backend/src/services/ingest/event/{ingest-event,wait-for-outcome,parse-notification-payload,prefilter-notification,prefilter-markers,notification-fingerprint,notification-text,notification-queue,notification-sources.service}.ts` + unit specs. `notification-text.ts` wraps `encryptToken`/`decryptToken`.
- Create: `packages/backend/src/controllers/ingest/{event,notification-sources}.controller.ts`
- Modify: `packages/backend/src/routes/{ingest,user}.route.ts`, `packages/backend/src/setup-middleware.ts`, `packages/backend/src/background-jobs.ts`, `packages/backend/src/services/ingest/{card-mappings.service,create-setup-code,access-headers.service}.ts`, `packages/backend/src/controllers/ingest/{card-mappings,access-headers}.controller.ts`, `packages/shared/src/types/ingest/card-payment-setup-code.ts` (`gate`), `packages/backend/src/services/ingest/card-payment/record-request.ts` (sets `pipeline: cardPayment`)
- Modify: `packages/backend/src/routes/base-currency-guard-coverage.e2e.ts` (`GUARD_EXEMPT_ROUTES` for the source and strictness writes)
- Create: `packages/backend/src/services/ingest/event/{ingest-event,notification-sources}.e2e.ts`; Modify: `packages/backend/src/tests/helpers/ingest.ts`, `packages/backend/src/services/ingest/card-mappings.e2e.ts`

- [x] write failing unit tests:
  - `kind` is required;
  - aliases and caps;
  - prefilter: an OTP request with a code → `security`; "Payment 43.60 GEL, auth code 482913" → pass; percent-off promo → `promo`; payment text with card digits and a promo word → pass;
  - strictness levels;
  - the fingerprint and the 5 s fold;
  - the `gate` setup-code round trip, and an old code still decodes;
  - `notification-text` round trip
- [x] write failing e2e (the job's processor is a stub that marks the row `logged`):
  - `walletTransaction` → card-payment summary, `notify: true`, `pipeline` = `cardPayment`;
  - a notification → `logged` with the summary; a slow stub → `queued`;
  - `noAmount`/`security`/`promo` → `200 dropped`, no row, counter bumped on an existing source;
  - `self`: a notification from `com.apple.shortcuts`, one from the MoneyMatter web app, and one whose body is our own "Logged 43.60 GEL at Wolt → Food" → `dropped/self`, with no row and no source created;
  - a muted source (set through `PATCH /notification-sources/:id`) → `dropped`;
  - over 120 in an hour → 429, and dropped requests don't count;
  - key replay → `duplicate`; same key, other body → 409;
  - two identical notifications 2 minutes apart → two rows;
  - dry run; 413;
  - a non-2xx answer carries `message`;
  - the stored payload has no title, subtitle or body, only `textEnc`;
  - sources: list (empty, then after a notification), mode, default account (owned and active; 404 otherwise), delete;
  - `lastDigits` (validation, 409 on a duplicate);
  - strictness `PUT` (422 for an unknown level), and a new setup code carries `gate`;
  - guard coverage
- [x] implement:
  - dispatch on `kind`;
  - prefilter, then the service-level `checkRateLimit` (hour and day, notifications only);
  - source upsert (conversational rows only after the prefilter);
  - tx 1 with `pipeline`, `textEnc` and `attempts`;
  - enqueue `${requestId}-${attempt}` with `removeOnComplete: true`, `removeOnFail: { age: 3600 }`, 4 attempts with backoff; the final failure parks `processingFailed`;
  - `waitForOutcome`
- [x] ➕ owner fact (multi-currency TBC card): the owner has ONE TBC card with 4 currencies, GEL and USD non-empty, each a separate MoneyMatter account. Extend `CardAccountMappings` so a card (label and/or `lastDigits`) holds one row per currency plus one default row (`currencyCode` NULL). The migration gets a unique index on `(userId, normalized card key, currency)` that treats a NULL currency as the default; existing rows become the default
- [x] ➕ account resolution, used by both the tap path (card-payment) and notifications: the payment currency's mapping first; otherwise the card's default (the bank converts from the default balance); otherwise unknown card. Extend the card-mappings API (list, set and remove per currency) and its validation. Update the tap-path e2e: a GEL payment goes to the GEL account, a USD payment to the USD account, EUR to the default
- [x] ➕ frontend: `card-links.vue` on the Apple Pay page lets the user add currency-specific accounts under a card and pick the default (`en` and `uk` i18n, vitest); compact
- [x] gate: unit `--testPathPattern='(ingest/event|setup-code)'`; e2e `--testPathPattern='(ingest/event/(ingest-event|notification-sources)|ingest/(card-mappings|setup-code|card-payment/ingest-card-payment)|routes/base-currency-guard-coverage).e2e'`

Gate results (Task 2): backend unit (full) 359 suites pass; e2e `services/ingest/.*`, `routes/base-currency-guard-coverage`, `backup/(export-backup|restore/restore-backup)` 11 suites pass; frontend `src/pages/accounts/integrations` and the full vitest run pass; root typecheck, lint and backend knip clean.

### Task 3: AI features `notificationParsing` and `duplicateMatching`

**Files:**

- Modify: `packages/shared/src/types/ai/settings.ts`, `packages/backend/src/services/ai/resolution-ladder.ts`, `packages/frontend/src/common/const/ai-features.ts` + i18n `common.aiFeatures.*`, `settings.ai.modelGuide.*` (`en` + `uk`)
- Modify: `packages/backend/src/services/user-settings/ai-feature-settings.e2e.ts`, `packages/backend/src/services/ai/ai-model-resolver.unit.ts`, `packages/frontend/src/composable/use-ai-feature-access.test.ts`

- [x] write failing tests: both features are listed, saved and resolved; ladder defaults; the registry covers every feature
- [x] implement the enum values, cheap and fast defaults, and the copy (the owner approves it; copy drafted without owner review, flagged in the progress log)
- [x] gate: unit `--testPathPattern='ai-model-resolver'`; e2e `--testPathPattern='user-settings/ai-feature-settings.e2e'`; frontend `--run src/composable/use-ai-feature-access.test.ts`

### Task 4: Parsers, payee candidates, balance authority, AI daily limit

**Files:**

- Create: `packages/backend/src/services/ingest/event/{parse-wallet-notification,parse-notification-with-ai,notification-prompt,classify-notification,payee-candidates,balance-authority,ai-daily-limit}.ts` + unit specs, and `fixtures/notifications.ts`. The fixtures cover Wallet; Georgian, Russian, Ukrainian and English pushes, SMS and an email; debit, credit, decline, promo, FX and settlement texts; an "auth code" confirmation; `WOLT.COM TBILISI` and `SP *COFFEE LAB`; a total balance; and a chat message with an amount.

- [x] write failing unit tests (`jest.mock('ai')`):
  - the Wallet parser;
  - kind mapping; confidence < 0.6 → `lowConfidence`; invalid fields dropped; a `candidateId` outside the list dropped;
  - the prompt sections (payee rules, candidates, balance context, untrusted text);
  - candidates (tokens, Fuse, recent payees; deduped, capped at 15, generic words skipped);
  - balance authority (single currency, a non-zero sibling, zero siblings, `total`);
  - no client → `aiUnavailable`; a spent cap → `aiCapReached`; the daily limit → `aiLimitReached` with no call
- [x] implement on `createAIClient(notificationParsing)`, `Output.object`, `aiCallGuards`, `trackAiUsage` and `resolveAiExtractionFailure`
- [x] gate: unit `--testPathPattern='ingest/event/(parse|classify|payee-candidates|balance-authority|ai-daily-limit|notification-prompt)'`

Gate results (Task 4): unit `ingest/event/(parse|classify|payee-candidates|balance-authority|ai-daily-limit|notification-prompt)` 8 suites, 222 tests pass; unit `ingest` 25 suites, 704 tests pass; backend typecheck, lint and knip clean; `payee-candidates` `loadPayeeCandidates` also run once against the e2e database in a throwaway spec (not committed).

### Task 5: Processing job, payee choice and the shared logging core

**Files:**

- Create: `packages/backend/src/services/ingest/log-ingested-payment.ts` (writes `externalData.ingest.systemNote` and `systemCategoryId`); Modify: `packages/backend/src/services/ingest/card-payment/process-card-payment.ts`
- Create: `packages/backend/src/services/ingest/event/{process-notification,resolve-notification-account,apply-payee-choice}.ts` + `apply-payee-choice.unit.ts`
- Modify: `packages/backend/src/services/ingest/card-payment/{process-ingest-request,list-requests,retry-request,run-ingest-pass,format-summary}.ts` (branch on `pipeline`; `retry-request.ts` enqueues `${requestId}-${attempts + 1}` for notifications and accepts `force`), `packages/backend/src/controllers/ingest/card-payment-requests.controller.ts` (`{ force?: boolean }` on retry), `packages/backend/src/services/ingest/event/notification-sources.service.ts` (approve → enqueue the held requests; mute → delete them), `packages/backend/src/crons/ingest-requests-cleanup.ts`, `packages/backend/src/middlewares/check-base-currency-lock.ts` (a `messageKey` option; `ingest.route.ts` passes `ingest.busy` for both ingest routes) + backend i18n `ingest.busy` (`en` + `uk`), `packages/backend/src/services/ingest/card-payment/ingest-card-payment.e2e.ts` (the 423 case now expects the `ingest.busy` message)
- Create: `packages/backend/src/services/ingest/event/{process-notification,payee-resolution}.e2e.ts`

- [x] write failing e2e (AI over MSW):
  - a Wallet notification is logged without AI;
  - a push debit and credit are logged with payee and category;
  - non-payments → `ignored`, with `textEnc` and `summary` null and `parsed` exactly `{ parser, kind, confidence }`;
  - a pending source → parked `sourceNotApproved` without AI; approving it through `PATCH /notification-sources/:id` logs it; muting deletes it;
  - `aiUnavailable`, `aiCapReached` and `aiLimitReached` → each followed by a successful retry;
  - `ownTransfer`/`lowConfidence` → `POST /user/settings/card-payments/requests/:id/retry { force: true }` logs them; without `force` the retry answers 409 with the park reason;
  - a notification request that ended `processingFailed` (an MSW 500 on every attempt) → `retry` enqueues `${requestId}-2` while the failed job is still retained, and the request is logged;
  - base currency, endpoint side: with the lock key set in Redis (as `ingest-card-payment.e2e.ts` does with `buildLockKey`), `POST /ingest/event` answers **423** with the `ingest.busy` message for both kinds, and no `IngestRequests` row is written;
  - base currency, job side: a request accepted while unlocked (a pending source's notification, parked `sourceNotApproved`). The test then sets the lock key and approves the source through `PATCH /notification-sources/:id`, which only enqueues. The job sees the lock and re-delays with `attempts` unchanged and the row still `received`. The test deletes the lock key; after the re-delay (`notificationTimings.lockRetryDelayMs`, 60 s, shortened in the test) the request is logged;
  - FX → `originalAmount`;
  - a connected account → a planned row;
  - accounts: card name, `lastDigits`, source default, and `unknownAccount` with a guess;
  - GEL + USD non-zero at the same bank → `authoritative: false`;
  - retention: ignored after 7 days, unclassified text after 7 days (counter `expiredUnclassified`), a pending source after 30 days
- [x] write failing e2e for payees:
  - `WOLT.COM TBILISI` + an existing "Wolt" → alias added; the next one resolves by the alias even when the AI answers `newName: "Something"`;
  - `SP *COFFEE LAB` → a new "Coffee Lab" with the raw alias;
  - `newName: "Wolt"` with no candidate → adopts the existing Wolt (no 409, no `processingFailed`);
  - an ignored raw merchant → no payee created and no alias
- [x] implement:
  - extract `logIngestedPayment` (the card-payment e2e stays green);
  - `applyPayeeChoice`;
  - `processNotification`, with pass-through hooks for dedup (Tasks 6–7) and inbox (Task 10)
- [x] gate: e2e `--testPathPattern='(ingest/event/(process-notification|payee-resolution|ingest-event)|ingest/card-payment/(ingest-card-payment|processing|requests|ai-categorization)|crons/ingest-requests-cleanup).e2e'`; unit `--testPathPattern='ingest'`
- [x] ➕ the shortcut sends the source app's DISPLAY NAME (e.g. "Telegram", "Wallet", "TBC Bank"), not a bundle id. `isWalletApp`, `getDefaultSourceMode` and `buildSourceKey` work from names: Wallet's localized names, a seed list of bank app names that includes "TBC Bank" and "bcc.kz", the bundle id used only when present; Wallet has one source key by bundle id or any localized name. Unit tests (device fact)
- [x] ➕ OWNER DECISION "logged now, confirm in inbox": every automated payment, tap or notification, is written at once and marked unconfirmed (`externalData.ingest.unconfirmed`) through the shared logging core; `GET /user/settings/card-payments/unconfirmed` lists such rows (`awaitingConfirmation`, next to the old `bankUnconfirmed`); `INGEST_PAYMENT_LOGGED` is emitted after commit, one per transaction, for the inbox card of Task 10. E2E: a logged notification and a logged tap are both unconfirmed and listed (owner decision 2026-10-20)

Gate results (Task 5): e2e `ingest/event/(process-notification|payee-resolution|ingest-event|notification-sources)`, `ingest/card-payment/(ingest-card-payment|processing|requests|ai-categorization)`, `crons/ingest-requests-cleanup`, `ingest/(card-mappings|setup-code)`, `routes/base-currency-guard-coverage` 12 suites, 284 tests pass; backend unit full 368 suites pass; backend typecheck, oxlint, knip and oxfmt clean; frontend typecheck and `src/pages/accounts/integrations` vitest pass.

### Task 6: Tier-1 twin, settlement rule and enrichment

**Files:**

- Create: `packages/backend/src/services/ingest/dedup/{constants,source-slots,twin-rule,find-dedup-target,enrich-twin,attach-to-existing-payment}.ts` (the twin and settlement rules are one pure `twin-rule.ts`, the lookup one `find-dedup-target.ts`) + unit specs, `twin.e2e.ts`; `card-payment/repeat-window.ts` (the fold by `time`)
- Create (➕): `packages/backend/src/services/ingest/dedup/{conversion-pair-rule,suggest-conversion-pair}.ts` + `conversion-pair.e2e.ts`; `packages/backend/src/services/ingest/corrections/{short-balance-rule,compose-correction,suggest-short-balance-correction,apply-correction,read-ingest-suggestions}.ts` + `short-balance.e2e.ts`; `packages/backend/src/services/ingest/after-payment-logged.ts`
- Modify: `packages/backend/src/services/ingest/log-ingested-payment.ts`, `packages/backend/src/services/ingest/event/process-notification.ts`, `packages/backend/src/services/ingest/card-payment/{process-ingest-request,constants,parse-payload}.ts` (fold by `time` and `timeSource`; `timeSource` parsed), `packages/shared/src/types/ingest/index.ts` (`timeSource` in the request keys), `packages/backend/src/services/ingest/card-payment/processing.e2e.ts` (the tap fold cases)

- [x] write failing unit tests:
  - slots, including legacy `externalData.cardPayment`;
  - the twin rule: exact amount, original amount, window, taken slot, `isSameShop` veto; interchangeable candidates → the earliest;
  - the settlement rule: same source, open authorization slot, same merchant text, 7 days
- [x] write failing e2e:
  - tap → Wallet → push → SMS gives one row in any order;
  - **tap, tap, Wallet, Wallet** for two identical coffees, with the taps' run times 60 s apart and different keys, gives two rows, each with two sources;
  - tap path alone, with run-time semantics (no `timeSource`, different keys, as the shipped shortcut sends across a minute boundary):
    - run times 8 s apart → folded (`duplicate: true`);
    - run times 25 s apart → two rows, and after Task 7 a suggestion for the pair;
    - run times 60 s apart → two rows;
  - `timeSource: transaction` on both: identical times → folded; times 10 s apart → two rows;
  - same key (the shipped shortcut within one minute) → replayed as `duplicate`, as today;
  - an API request without `time` → today's 120 s receipt window (the existing repeat-window e2e stays green);
  - a USD tap on a GEL manual account takes the bank's GEL and the balance follows;
  - the payee is filled and the spelling aliased;
  - a settlement **two days later** attaches to its authorization; one with a different merchant text logs a new row;
  - the banner says "Already logged …"
- [x] implement under `ingest-dedup:<userId>` in both paths; attach through `updateTransaction`
- [x] gate: unit `--testPathPattern='ingest/dedup'`; e2e `--testPathPattern='ingest/(dedup/twin|card-payment/(ingest-card-payment|processing)|event/process-notification).e2e'`
- [x] ➕ real-data twin fixtures (owner decision 2026-10-20, device fact): the twin and settlement tests use the formats of the owner's phone (`woltOnlinePayment` in `ingest/event/fixtures/notifications.ts`). The Wallet notification is title `TBC Bank`, subtitle `Wolt`, body `GEL 29.41`; the TBC push, about 2 minutes later, is title `TBC`, body `29.41 GEL\nTBC CARD VISA GOLD (***8543)\nWolt 20/10/26 18:40\nBalance: 3816.41 GEL`; the tap is card `TBC Bank`, merchant `Wolt`, amount `GEL 29.41`. Any of them, in any order, ends as ONE transaction; the push adds last digits 8543 and the bank's own time (read off the notification time, since the text prints no zone), and its balance stays non-authoritative on a multi-currency card
- [x] ➕ short-balance correction (owner decision 2026-10-20): a debit logged to an account of a card (a currency row or the default) whose balance before the payment was below the amount stores `externalData.ingest.correction` on the transaction. Candidates are the card's other accounts whose balance covers the payment converted at the day's rate, the default account first; the `duplicateMatching` connection ranks them and writes a one-line reason, and without a model (or on any failure, or a spent daily limit) the deterministic order stands with no reason. It holds the estimated converted amount (flagged `estimate`). `GET /user/settings/card-payments/unconfirmed` exposes it as `correction`; `POST /user/settings/card-payments/corrections/:transactionId/{approve,dismiss}` (guarded) move the transaction (balances follow, the charged amount stays as the original amount) or close the suggestion. E2E and unit tests; Task 10's single confirm card shows "Move it to <account>?" from this field and calls the two endpoints
- [x] ➕ currency-conversion pair (owner decision 2026-10-20): a logged payment that has an opposite-direction row on another own account in a different currency within 1 hour, at ±3% of the day's rate, gets `externalData.ingestTransferSuggestion` on both legs. Nothing is linked: the owner links with the existing `PUT /transactions/link` and dismisses with the existing `POST /transactions/transfer-recommendations/dismiss` (which also keeps the pair from being suggested again); `INGEST_PAYMENT_LOGGED` is emitted again for each ingest leg. The unconfirmed list exposes it as `transferSuggestion`. E2E and unit tests (the real TBC pair: 300.00 USD out, 778.50 GEL in 6 minutes later)

Gate results (Task 6): e2e `services/ingest`, `routes/base-currency-guard-coverage`, `crons/ingest-requests-cleanup` 18 suites, 361 tests pass; backend unit `ingest` 33 suites, 801 tests pass; backend typecheck, lint, knip and oxfmt clean for the changed files; frontend typecheck and `src/pages/accounts/integrations` vitest pass.

### Task 7: AI duplicate judge and the suggestions list

**Files:**

- Create: `packages/backend/src/services/ingest/dedup/{judge-duplicates,judge-prompt,find-judge-candidates,judge-after-commit}.ts` + unit spec, `judge.e2e.ts`
- Create: `packages/backend/src/services/transactions/reconciliation/duplicate-suggestions.ts` (insert with `ON CONFLICT DO NOTHING`, list)
- Modify: `packages/backend/src/controllers/transactions.controller/{reconciliation,reconciliation-schemas}.ts`, `packages/backend/src/routes/transactions.route.ts` (`GET /transactions/reconciliation/suggestions`), `packages/backend/src/tests/helpers/reconciliation.ts`, `packages/backend/src/services/ingest/event/process-notification.ts`

- [x] write failing unit tests: short ids, unknown ids dropped, clamping, ≥ 0.6 → a suggestion, no client or a spent limit → none
- [x] write failing e2e:
  - judged at 0.95 → a new row plus an `open` suggestion, read via `GET /suggestions` (no attach);
  - 0.3 → none;
  - candidates exclude taken slots and other accounts;
  - the judge runs after commit: a judge failure leaves the logged row in place;
  - the suggestions list is empty for a new user
- [x] gate: unit `--testPathPattern='ingest/dedup/judge'`; e2e `--testPathPattern='ingest/dedup/(judge|twin).e2e'`

Gate results (Task 7): unit `ingest/dedup/judge` 3 suites, 25 tests pass; e2e `ingest/dedup/(judge|twin)` 29 tests pass, and `services/ingest`, `transactions/reconciliation`, `routes/base-currency-guard-coverage`, `crons/ingest-requests-cleanup` 21 suites, 440 tests pass; backend and frontend typecheck, backend lint and knip clean. Backend unit `amount-gate`, `prefilter-notification` and `classify-notification` fail on the local Node 22 (the gate regexes use `(?i:…)` modifier groups); they fail the same way without this task's changes (a Node version issue, not a regression).

### Task 8: Reconciliation for manual accounts and ingest plans

**Files:**

- Modify: `packages/backend/src/services/transactions/reconciliation/{helpers,merge-transactions,restore-transactions,get-history}.ts`, `reconciliation.e2e.ts`
- Create: `packages/backend/src/services/transactions/reconciliation/edit-merge.ts` + unit spec; Modify: `packages/backend/src/services/bank-data-providers/enablebanking/utils/plan-edit-merge.ts` + unit spec (optional machine payment types)
- Create: `packages/backend/src/services/ingest/dedup/choose-survivor.ts` + unit spec
- Modify: `packages/backend/src/services/chat/proposals/previews/reconciliation.ts`, i18n `transactions.reconciliation.*` (`en` + `uk`), `packages/frontend/src/pages/optimizations/reconciliation/block-reasons.ts` + test

- [x] write failing tests:
  - unit: `planReconciliationEditMerge`. Two ingest rows "Wolt" vs "WOLT.COM TBILISI" with machine notes → merge, no `note_conflict`. A user-edited note on both sides → `note_conflict`. `mobilePayment` on both sides → no conflict; two ingest rows with **different unstamped history categories** (their `systemCategoryId`s) → merge, keeping the survivor's category; a manual stamp on one side and a different machine category on the other → that side's manual category moves;
  - e2e: a manual-account merge, remove and restore change the balance and `Balances` correctly; bank rows are unchanged;
  - e2e: an ingest plan merges into a booked row and is hidden (planned included); the reverse is rejected; a user plan is rejected;
  - e2e: the chat merge preview accepts the same rows
- [x] implement; rewrite the `softDeleteTransactions` comment
- [x] gate: e2e `--testPathPattern='transactions/reconciliation/reconciliation.e2e'`; unit `--testPathPattern='(choose-survivor|edit-merge|plan-edit-merge|chat/proposals)'`; frontend `--run src/pages/optimizations/reconciliation`

Gate results (Task 8): e2e `transactions/reconciliation/reconciliation.e2e` 71 tests pass (manual-account merge, remove and restore with the balance and the chart; ingest rows' edit merge; ingest plans; chat cards through propose and approve), and with `duplicate-suggestions`, `ingest/dedup/(judge|twin)`, `chat/proposals/(approve|card-actions)` and `routes/base-currency-guard-coverage` 8 suites, 166 tests pass; backend unit `(choose-survivor|edit-merge|plan-edit-merge|chat/proposals|reconciliation|mcp|i18n)` 60 suites, 1530 tests pass; frontend `src/pages/optimizations/reconciliation` 18 tests pass; backend and frontend typecheck, lint, backend knip and oxfmt clean.

### Task 9: Suggestion dismiss, stale marking and the scan job

**Files:**

- Modify: `packages/backend/src/services/transactions/reconciliation/duplicate-suggestions.ts` (dismiss, `markSuggestionsStale`, `markSuggestionMerged`, null-side sweep), `packages/backend/src/services/transactions/reconciliation/merge-transactions.ts` (marks the pair's open suggestion `merged` inside the merge transaction), `packages/backend/src/services/transactions/{delete-transaction,bulk-delete}.ts`, `packages/backend/src/services/transactions/reconciliation/remove-transactions.ts`, `packages/backend/src/crons/ingest-requests-cleanup.ts`
- Create: `packages/backend/src/services/ingest/dedup/{duplicate-scan-queue,event-listeners}.ts`; Modify: `packages/backend/src/services/import-export/statement-parser/execute-import.service.ts`, `packages/backend/src/background-jobs.ts`
- Modify: the controller and routes (`POST /transactions/reconciliation/suggestions/:id/dismiss`, guarded), `routes/base-currency-guard-coverage.e2e.ts`
- MCP: `list-duplicate-suggestions`, `dismiss-duplicate-suggestion` (`add-mcp-tool`)
- Create: `packages/backend/src/services/transactions/reconciliation/duplicate-suggestions.e2e.ts`

- [x] write failing e2e:
  - dismiss for good (a rescan does not recreate it);
  - a merge marks it `merged`;
  - deleting a transaction marks it `stale` and keeps the row (`SET NULL`);
  - a sync next to an unsettled ingest plan → a suggestion;
  - two ingest rows judged 0.95 → a suggestion, not merged;
  - a statement import → a suggestion;
  - guard coverage
- [x] gate: e2e `--testPathPattern='(transactions/reconciliation/(duplicate-suggestions|reconciliation)|ingest/dedup/(judge|twin)|routes/base-currency-guard-coverage).e2e'`; unit `--testPathPattern='(reconciliation-tools|mcp)'`

Gate results (Task 9): e2e `transactions/reconciliation/(duplicate-suggestions|reconciliation)`, `ingest/dedup/(judge|twin)`, `routes/base-currency-guard-coverage` and `crons/ingest-requests-cleanup` 6 suites, 134 tests pass (plus `transactions/bulk-delete`, `statement-parser/execute-import`, `planned-matching/merge-on-sync`: 9 suites, 178 tests); unit `(services/(mcp|chat)/|reconciliation-tools|mcp|ingest|background-jobs|transactions)` 142 suites, 3012 tests pass; backend and frontend typecheck, backend lint (no errors), backend knip clean.

### Task 10: Automation inbox thread and cards

**Files:**

- Create: `packages/backend/src/services/chat/inbox/{inbox-thread,create-system-proposal,inbox-items}.ts` + unit specs, `inbox.e2e.ts`
- Modify: `packages/backend/src/services/chat/proposals/create-proposal.ts` (exported run-free `storeProposal`, `expiresAt` parameter, lifetime comment), `packages/backend/src/services/chat/proposals/card-expiry.ts` (return affected thread ids; call `reevaluateInboxThreads`), `packages/backend/src/services/chat/proposals/reject.ts` (`onInboxCardRejected`), `packages/backend/src/services/chat/runs/start-run.ts` (409 for inbox threads), `packages/backend/src/services/chat/threads/{list.service,to-chat-thread,update.service,delete.service}.ts`, `packages/backend/src/routes/chat.route.ts` + controllers (`clear-resolved`, `archive`), `packages/backend/src/middlewares/entitlements.ts` + `entitlements.unit.ts`, `routes/base-currency-guard-coverage.e2e.ts`
- Create: chat policies and previews for `log_ingest_request` and `set_notification_source` (`services/chat/policies/explicit.ts`, `services/chat/proposals/previews/ingest-requests.ts`); MCP tools `log-ingest-request` and `set-notification-source` (`add-mcp-tool`)
- Modify: `packages/backend/src/services/ingest/event/{process-notification,notification-sources.service}.ts`, `packages/backend/src/services/ingest/card-payment/{retry-request,dismiss-request}.ts`, `packages/backend/src/services/transactions/reconciliation/duplicate-suggestions.ts`
- Modify: `packages/backend/src/services/backup/restore/restore-backup.e2e.ts`

- [x] write failing unit tests: state transitions (`live` → `closed` at 7 days or 200 cards with none pending; `live` → `open` at 200 with pending; `open` → `closed` when the last card resolves); pinned iff `live` or `open`
- [x] write failing e2e:
  - each item type creates a message plus a card whose `preview.before` shows the request, source or pair;
  - approve, edit and reject run the tool or the reject hook and resolve the record;
  - resolving elsewhere → `resolvedElsewhere`;
  - no AI connection needed;
  - `POST /threads/:id/messages` **and** `POST /proposals/:id/comment` on an inbox card → 409;
  - two concurrent items with no live thread → one live thread holding both cards;
  - `DELETE` or unpin of a `live`/`open` thread → 409; on `closed` it works;
  - `clear-resolved` keeps pending cards; `archive` → 409 with a pending card;
  - an `open` thread whose last pending card expires (through the existing card-expiry helper) turns `closed`, is unpinned and can be deleted;
  - a read-only user can clear-resolved and archive;
  - restore of a backup taken with sources and dismissed suggestions that carry `proposalId` → succeeds, with `proposalId` null
- [x] gate: unit `--testPathPattern='(chat/inbox|chat/policies|entitlements)'`; e2e `--testPathPattern='(chat/inbox/inbox|chat/threads/threads|chat/proposals/(approve|card-actions)|ingest/event/process-notification|transactions/reconciliation/duplicate-suggestions|backup/restore/restore-backup|routes/base-currency-guard-coverage).e2e'`

### Task 11: Assistant push group (backend and the typecheck-bound frontend entries)

**Files:**

- Modify: `packages/shared/src/types/{notifications,web-push}.ts` (the `assistant` group in `PUSH_GROUPS`, `PUSH_GROUP_DEFAULTS`, `NOTIFICATION_PUSH_GROUP`; the four types and their payloads)
- Modify: `packages/backend/src/models/user-settings.model.ts` (`ZodPushGroupsSchema.assistant`), `packages/frontend/src/pages/settings/subpages/notifications/components/push-groups-card.vue` (the `GROUP_ICONS` entry) + `push-groups-card.spec.ts` (six switches)
- Create: `packages/backend/src/services/assistant-push/{presence,assistant-push-queue,emit-assistant-push}.ts` + unit specs, `assistant-push.e2e.ts`; `packages/backend/src/controllers/chat/presence.controller.ts`
- Modify: `packages/backend/src/routes/chat.route.ts` (`PUT|DELETE /chat/presence`), `packages/backend/src/middlewares/entitlements.ts` + unit, `routes/base-currency-guard-coverage.e2e.ts`, `packages/backend/src/services/web-push/{render-push-body,build-push-payload}.ts` + unit specs, `packages/backend/src/background-jobs.ts`, backend i18n `notifications.push.*` (`en` + `uk`)
- Modify (callers): `packages/backend/src/services/chat/runs/run-recorder.ts`, `packages/backend/src/services/chat/inbox/inbox-items.ts`, `packages/backend/src/services/ingest/event/process-notification.ts`, `packages/backend/src/services/ingest/card-payment/process-ingest-request.ts`, the thread `get` service and the notifications service (mark read by `payload.threadId`)

- [x] write failing unit tests: collapse keys, counts, cooldowns, presence; push bodies per type in `en`/`uk` with no message text; tags; `NOTIFICATION_PUSH_GROUP` places the new types in `assistant`
- [x] write failing e2e (delivery mocked as in `web-push/push-delivery.e2e.ts`):
  - a run finished with no presence → one `chatReplyReady`; with pending cards → one push mentioning them;
  - a fresh presence key → nothing;
  - three inbox items → one push with count 3; a fourth within the cooldown → nothing;
  - an unknown-account park (it has a card) → only `automationInbox`; `aiCapReached` → one `ingestAttention`, and a second the same day → nothing;
  - the group off → an in-app entry but no delivery;
  - `GET` of the thread marks its entries read;
  - presence on another user's thread → 404;
  - a read-only user can send presence;
  - `PATCH` user settings keeps `push.groups.assistant`
- [x] gate: unit `--testPathPattern='(assistant-push|web-push|entitlements)'`; e2e `--testPathPattern='(assistant-push/assistant-push|web-push/push-delivery|notifications/notifications|chat/runs/run-stream|routes/base-currency-guard-coverage).e2e'`; frontend `--run src/pages/settings/subpages/notifications`; `npm run typecheck`

Gate results (Task 11): unit `(assistant-push|web-push|entitlements)` 249 passed; e2e `assistant-push/assistant-push` 23 passed, and with `web-push/push-delivery`, `notifications/notifications`, `chat/runs/run-stream`, `routes/base-currency-guard-coverage`, `chat/inbox/inbox`, `chat/threads/(threads|read-only-chat)`, `ingest/event/process-notification` and `user-settings/patch-settings` 241 passed in 10 suites; frontend `settings/subpages/notifications` 33 passed; backend and frontend typecheck clean.

### Task 12: Frontend: push settings copy, presence and deep links

**Files:**

- Modify: `push-groups-card.vue` (the description for `assistant`), `packages/frontend/src/components/notifications-popover/build-notification-route.ts` + test, the bell item rendering, `packages/frontend/src/api/chat.ts`
- Create: `packages/frontend/src/composable/use-chat-presence.ts` + test; use it on the chat thread page
- i18n: `settings.notifications.push.groups.assistant.*`, `notifications.types.{chatReplyReady,chatCardsWaiting,automationInbox,ingestAttention}.*` (`en` + `uk`)

- [x] failing vitest:
  - the heartbeat is sent every 20 s only while the page is visible and focused; it stops on blur, hide and leave, with `DELETE` on leave;
  - deep links: the thread types → `chatThread`; `ingestAttention` → `ROUTES_NAMES.accountApplePay`, the current setup page (Task 13 switches it);
  - the bell shows counts
- [x] gate: `npm run test:unit -- --run src/pages/settings/subpages/notifications src/composable/use-chat-presence.test.ts src/components/notifications-popover`; typecheck, lint

Gate results (Task 12): frontend `settings/subpages/notifications`, `use-chat-presence.test.ts`, `notifications-popover`, `api/chat`, `components/chat`, `pages/chat` 1142 passed in 51 files; full frontend vitest 5524 passed; root typecheck and frontend lint clean.

### Task 13: Frontend: rename to "iOS Automation", two shortcut buttons, PWA-safe links

**Files:**

- Move: `packages/frontend/src/pages/accounts/integrations/apple-pay/` → `ios-automation/` (`apple-pay-details.vue` → `ios-automation-details.vue`; `apple-pay.ts` → `ios-automation.ts`, specs follow)
- Modify: `packages/frontend/src/routes/{index,constants}.ts` (`accountIosAutomation`, redirects), `packages/frontend/src/components/notifications-popover/build-notification-route.ts` + test (`ingestAttention` → `accountIosAutomation`), `pages/accounts/accounts.vue`, `pages/accounts/integrations/components/add-integration-dialog.vue`, `components/sync-status-tooltip.vue`, `components/ui-header.vue`
- Modify: `ios-automation.ts` (`resolveShortcutHref`/`probeShortcutFile` parameterized by `{ filePath, icloudUrl }`; iCloud first on every device; `isIosDevice` removed; new `isStandalone`, `openShortcutLink`, `PAYMENTS_SHORTCUT_FILE_PATH`) and `composables/use-shortcut-link.ts`; `components/{add-shortcut-button,setup-code-dialog}.vue` (standalone-safe open, clipboard fallbacks), with a new `packages/frontend/src/common/utils/copy-text.ts` + test; `packages/frontend/src/common/config.ts` + `self-hosting/frontend/docker-entrypoint.sh` (`PAYMENTS_SHORTCUT_ICLOUD_URL`)
- Create: `ios-automation/components/{shortcut-choice,triggered-shortcut-setup,gate-strictness,notification-sources,pending-sources}.vue` + specs
- Modify: `components/{setup-checklist,add-shortcut-button,card-link-dialog,card-links,waiting-payments,payment-request-summary}.vue`, `packages/frontend/src/api/ingest.ts`; i18n `settings.integrations.applePay.*` → `settings.integrations.iosAutomation.*` (`en` + `uk`)
- Create: `packages/frontend/e2e/tests/integrations/ios-automation.spec.ts` (and update the paths in the Apple Pay specs)

- [ ] failing vitest:
  - routes: both old paths redirect; the title is "iOS Automation";
  - "Add integration" dialog row (the status line of mode labels from `port/wallet-icon`, today "Apple Pay taps"): add **"Notifications (iOS 27+)"** to the modes, and the description says bank notifications (app pushes, SMS, email) are logged too;
  - `shortcut-choice.vue` shows both buttons side by side (stacked in a narrow container, via container queries), each with expandable instructions; no code path reads `navigator.userAgent`;
  - "iOS 27 or later" opens `PAYMENTS_SHORTCUT_ICLOUD_URL` or `log-payments.shortcut`, **never** the tap shortcut's link. Its instructions: turn on the built-in triggers; if iOS asks, add Wallet, Messages, the bank's app and the mail app; Run Immediately. The gate note: "only notifications that show an amount leave your phone; built-in Match Text, no Apple Intelligence needed";
  - "iOS 26 or earlier" opens the tap shortcut (iCloud link or file) with today's checklist;
  - a button whose iCloud link and file are both missing is hidden, with a note;
  - standalone mode (mock `matchMedia('(display-mode: standalone)')`): the iCloud link goes through `window.open(..., '_blank', 'noopener')`; the file has no `download` attribute and opens through `window.open`. In a normal tab: an anchor, with `download` for the file;
  - `copyText`: synchronous `writeText` inside the handler; on rejection, the `execCommand` fallback; then the "Tap and hold to copy" field;
  - gate strictness with its warning and the new-setup-code hint;
  - sources and pending sources (approve, mute); the last-digits field;
  - the waiting and recent lists show notification kinds and reasons, with a link to the inbox card
- [ ] Playwright: the old URL redirects; an unknown-account notification is resolved from the waiting list
- [ ] gate: `npm run test:unit -- --run src/pages/accounts src/routes src/common/config`; typecheck, lint

### Task 14: Frontend: Reconciliation Suggestions tab and the inbox view

**Files:**

- Create: `packages/frontend/src/pages/optimizations/reconciliation/components/{suggestions-tab,suggestion-card}.vue` + specs; `packages/frontend/e2e/tests/reconciliation/suggestions.spec.ts`
- Modify: `reconciliation/{index.vue,use-reconciliation.ts}`, `components/{merge-dialog,history-tab}.vue`, `packages/frontend/src/api/transactions.ts`, `packages/frontend/src/common/const/vue-query.ts`
- Modify: the chat thread page, the thread list and the proposal card (inbox badge, no composer, no comment control on inbox cards, a locked pin while `live`/`open`, **Clear resolved**, **Archive** with its disabled reason)

- [ ] failing vitest: the Suggestions tab (badge; pairs with sources, confidence and reason; Merge opens the existing dialog with the suggested survivor; Not duplicates; empty state); the inbox view controls as listed
- [ ] i18n `optimizations.reconciliation.suggestions.*`, `chat.inbox.*` (`en` + `uk`)
- [ ] Playwright: merge a suggestion and see its inbox card resolved
- [ ] gate: `npm run test:unit -- --run src/pages/optimizations/reconciliation src/pages/chat`; typecheck, lint

### Task 15: iOS 27 shortcut with built-in triggers

⚠️ Blocked on a fuller device sample (XML) showing:

- the Wallet Transaction trigger;
- the Notification trigger's App parameter (one app, several, "any app" if offered);
- the input property names;
- whether Run Immediately is stored;
- whether `shortcuts sign` and the import keep `WFWorkflowTriggers`.

**Files:**

- Create: `packages/frontend/scripts/shortcuts/shortcut-plist.ts` (helpers moved out of `build-card-payment-shortcut.ts`), `build-payments-shortcut.ts` + spec, `fixtures/triggers-input.xml`, `packages/frontend/shortcuts/log-payments.plist`
- Modify: `packages/frontend/package.json` (`shortcuts:build`), `packages/frontend/public/shortcuts/README.md`, the Task 4 fixtures, `packages/frontend/scripts/shortcuts/build-card-payment-shortcut.ts` + spec + `packages/frontend/shortcuts/log-card-payment.plist` (`KEY_TIME_FORMAT` to the second; one Wait-and-resend on 423, as in the new shortcut)

- [ ] failing spec:
  - XML drift;
  - `WFWorkflowTriggers` holds the Wallet Transaction trigger and a `WFNotificationTrigger` (any app, or the Wallet fallback);
  - the URL rewrite;
  - the gate uses `code.gate`, falling back to `AMOUNT_GATE_PATTERNS.standard`; the shared samples pass through the same regex;
  - the gate uses only **Match Text** + **If** (no Apple Intelligence action identifiers appear);
  - an **If** on the input's app or bundle stops the run for the Shortcuts app and the MoneyMatter web app before Match Text (the `self` rule);
  - the key includes the time to the second; `timeSource` is `transaction` only when the captured input has a date, otherwise `run`;
  - the legacy generator's `KEY_TIME_FORMAT` is cut to the second (its drift spec updated; the file is re-signed in Post-Completion);
  - no input → dry run;
  - a banner on `notify`, and `message` on a non-2xx answer;
  - on 423 exactly one **Wait** 20 s and a resend with the same body and key, then the busy banner
- [ ] add the real samples to the parser fixtures and re-run Task 4
- [ ] gate: `npm run test:unit -- --run scripts/shortcuts`; backend unit `--testPathPattern='(ingest/event|amount-gate)'`

### Task 16: Verify acceptance criteria

- [ ] tap, Wallet notification, push and SMS in any order → one row with every source, the bank's amount, the resolved payee and a new alias; the right banner each time; two identical payments → two rows
- [ ] an online Apple Pay payment is logged from the Wallet notification alone; a chat, an OTP request and a promo leave no stored text; a pending source's text is encrypted and expires after 7 days
- [ ] the limits hold; Wallet logs without AI; errors show a banner; our own banners and pushes never come back in as notifications
- [ ] every AI-judged match is a suggestion; resolving it in the inbox or in Reconciliation resolves both; manual-account balances stay right
- [ ] sync and statement import create no duplicate rows (the plan is settled) or a suggestion
- [ ] multi-currency balances are informational
- [ ] assistant pushes collapse, respect presence and the toggle
- [ ] the inbox has one live thread, is pinned and protected, and never runs AI
- [ ] backend: `npm run test:unit`; e2e `--testPathPattern='(ingest|transactions/reconciliation|planned-matching|duplicates-detection|ai-categorization|user-settings/ai-feature-settings|payees|chat|assistant-push|web-push|notifications|backup|mcp|crons/ingest-requests-cleanup|routes/base-currency-guard-coverage)'`
- [ ] frontend: typecheck, lint, `npm run test:unit -- --run`; Playwright `integrations/`, `reconciliation/` and chat when the dev stack is up
- [ ] root: `npm run format:check`, `npm run knip`

### Task 17: [Final] Update documentation

- [ ] `packages/docs/src/content/docs/integrations/ios-automation.mdx` (it replaces `apple-pay.mdx`; redirect in `astro.config.mjs`), per the `user-docs` skill. Cover:
  - the two shortcut buttons (iOS 27 or later, iOS 26 or earlier) and using them from the home-screen app;
  - the triggers and the apps to add;
  - the gate (Match Text, no Apple Intelligence) and its strictness;
  - logged, ignored, dropped and parked notifications;
  - approving sources;
  - accounts, payees and aliases;
  - balances;
  - privacy: encrypted text, what reaches the AI, retention;
  - limits;
  - the manual guide for older iOS;
  - troubleshooting
- [ ] `transactions/reconciliation.mdx`: Suggestions and manual-account rows; an Automation inbox section (what lands there, the pin, clear resolved, archive, rollover); the notification settings docs: the Assistant push group
- [ ] `packages/backend/docs/card-payment-ingest.md`: the event endpoint, `pipeline`, the banner and error outcomes, the prefilter, text at rest, limits, slots, the twin and settlement rules, the judge, the inbox sync; `services/bank-data-providers/docs/architecture.md`: the reconciliation changes
- [ ] `self-hosting/docs/environment-reference.md`: `INGEST_AI_DAILY_LIMIT`, `PAYMENTS_SHORTCUT_ICLOUD_URL`
- [ ] `cd packages/docs && npm run build` with the link validator passing
- [ ] move this plan to `docs/plans/completed/` after Task 16 passes (Task 15 may stay open under ⚠️)

## Post-Completion

_Items requiring manual work or external systems; no checkboxes._

**Device capture (owner, with the orchestrator), before Task 15:**

- From the Mac, export as XML a shortcut that has:
  - the Wallet Transaction trigger;
  - a Notification trigger with one app, then several, and "any app" if offered;
  - a body that saves the Shortcut Input.
- Collect real texts and redact codes and balances before committing:
  - Wallet: in-store, in-app, online, refund;
  - TBC push, SMS and email: payment, transfer out, incoming transfer, OTP, decline, promo, settlement.
- Answer from the samples:
  - Does TBC show last digits, and does the owner have several TBC cards?
  - Does TBC send a separate payment notice after an OTP or 3-D Secure message?
  - Do TBC payment confirmations carry an auth code? (They must pass the prefilter.)
  - Is a balance line per account or a total?
  - Does iOS expose the notification's date? (It drives the fold window and the key.)
  - Does the any-app trigger receive the Shortcuts app's own banners and MoneyMatter's web pushes, and under which app name or bundle id? (It drives the `self` rule on both sides.)
  - Does the Wallet Transaction input expose the transaction's own time? If it does, the iOS 27 shortcut sends it with `timeSource: transaction` (2 s fold); if not, it sends the run time with `timeSource: run` (20 s fold).
  - With the phone in Low Power Mode and locked, how many seconds pass between a tap and the automation's request? This checks the 20 s run-time window; log the server receive time against the tap.

**Signing:** sign `log-payments.plist` and re-sign the regenerated `log-card-payment.plist` (key to the second, 423 retry) (see `public/shortcuts/README.md`). Confirm the triggers survive signing and import, then run it once by hand for the dry-run banner. Share it from the iPhone to get an iCloud link, and set `PAYMENTS_SHORTCUT_ICLOUD_URL` (and `CARD_PAYMENT_SHORTCUT_ICLOUD_URL`, if it isn't set yet). PWA users need these links.

**Home-screen web app check (owner's iPhone):** from the installed MoneyMatter app (standalone, not Safari):

- tap each **Add shortcut** button and confirm the Shortcuts app offers the import, first with the iCloud link and then with only the file configured;
- generate a setup code, tap **Copy**, and paste it into the shortcut's import question;
- record anything that fails, with the iOS version.

**Cloudflare Access for `money.nemirovsky.dev`:** widen the path-scoped Service Auth app to `/api/v1/ingest/`, keeping the same service token. Then verify that an anonymous request gets 403 and one with the headers reaches the app.

**Deployment:**

- Build, back up, migrate.
- Configure AI for both features, or rely on the defaults. Set `INGEST_AI_DAILY_LIMIT` if needed.
- Enable the `assistant` push group on the phone.
- Generate a new setup code (it carries `gate`).
- Approve the TBC app or SMS sender when its first card arrives.

**Branches:** consolidate onto `feat/apple-pay-ingest` (fork/dev and `port/wallet-icon` merged first, then these plan commits), as the owner asked.

**Upstream:** offer it after the Apple Pay ingest, in four parts: the endpoint, parsing and dedup (Tasks 1–9); the inbox and push (Tasks 10–12); the UI and the shortcut (Tasks 13–15); the docs.
