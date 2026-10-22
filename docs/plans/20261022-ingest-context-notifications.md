# Context notifications from merchant apps

## Overview

A delivery or marketplace app (Wolt, Glovo, Bolt Food, Uber Eats, Yandex Eda, Amazon, ...) sends notifications that carry **no amount** but describe a purchase: "Order confirmed! Urban Roastery&Coffee has accepted your order! It will be delivered at 11:52 AM." The bank notification of the same purchase says "Wolt, 60.64 GEL" and nothing else. Today the merchant app's notification never reaches the server: the amount gate drops it on the device (`build-payments-shortcut.ts`, shared `amount-gate.ts`) and the server prefilter would drop it as `noAmount`.

This plan adds a **context source**: an app whose notifications are matched to the payment they belong to and enrich it (note), and which never create a transaction.

What the owner gets:

1. A source can be switched to a new mode, **Context**, next to Approved / Muted. Well-known delivery and marketplace apps start in it (like the seeded bank apps start `auto`).
2. Only context apps bypass the amount gate, on the device and on the server. Every other no-amount notification is still dropped.
3. The context notification is read (rules first, AI fallback), matched to the payment of the same service by time, and writes the note "Urban Roastery&Coffee order from Wolt" when the note is empty or was written by the pipeline. A note the owner wrote is never touched.
4. It works in both orders: the context may arrive before the bank notification (held, applied when the payment is logged) or after it.
5. Several notifications per order (accepted, on the way, delivered) enrich once.
6. The shortcut shows "Added Urban Roastery&Coffee to 60.64 GEL at Wolt"; the request history shows the match; a still-pending confirm card in the Automation inbox shows the note.
7. Bundled in the same shortcut update: the result banner stops repeating the shortcut name in its title.

Out of scope: touching the payment's category (see Decisions D9), amounts or payee from a context notification, creating transactions from one, Android, a user-editable list of rules.

**Branch:** `feat/ingest-context-notifications`, worktree `~/Developer/moneymatter-context`, based on `fork/dev`. Never pushed to `origin`.

## Context (from discovery)

- **Prefilter and gate.** `ingestNotification` (`services/ingest/event/ingest-event.ts`) parses the body, answers a repeated key, runs `prefilterNotification` (own output, then the amount gate `noAmount`, then OTP `security`, then `promo`), looks the source up, drops a `muted` one, applies the per-user caps, records the request (tx 1, text encrypted in `textEnc`) and enqueues the job. The source lookup (`findNotificationSource`) currently runs **after** the prefilter.
- **Sources.** `NotificationSources.mode` is a `STRING(16)` with no DB constraint: `auto | pending | approved | muted` (`shared/src/types/ingest/notification-sources.ts`). `getDefaultSourceMode` seeds Wallet and `KNOWN_BANK_*` as `auto`, everything else `pending`. `NOTIFICATION_SOURCE_TRUSTED_MODES = [auto, approved]` decides what reaches parsing. `touchNotificationSource` creates the source after the prefilter passes, so a notification dropped before that never creates one. Users set `pending | approved | muted` (`NOTIFICATION_SOURCE_USER_MODES`, `PATCH /user/settings/notification-sources/:id`, `updateNotificationSource`; approving releases held requests, muting deletes them).
- **Processing.** `processNotification` -> `read()`: a non-trusted source parks as `sourceNotApproved`; Wallet is parsed in code (`parse-wallet-notification.ts`); everything else goes to `parseNotificationWithAi` (feature `notificationParsing`, `takeIngestAiCall` daily limit, `classifyNotification` validates the model's answer). A non-payment becomes `ignored` with its text wiped (`settle-notification.ts`). `waitForOutcome` turns the settled row into the shortcut's answer (`NotificationEventResponse`: `outcome`, `summary`, `notify`).
- **Payment rows.** `logIngestedPayment` writes `Transactions.externalData.ingest`: `requestId`, `unconfirmed`, `systemNote` (the note the pipeline wrote), `systemCategoryId`, `sources[]`. A payment with a payee gets the payee's usual note or none; `suggestNoteAfterCommit` (follow-up queue `after-payment-logged`) may add an AI-picked one via `updateTransaction({ keepIngestUnconfirmed: true, note })`, then rewrites `ingest.systemNote` and emits `INGEST_PAYMENT_UPDATED`, which `chat/inbox/inbox-listeners.ts` turns into a refresh of the row's one confirm card. That path is the template for context enrichment.
- **Pairing precedent.** `hold-release/drop-hold-release.ts` pairs two requests (`IngestRequests.pairedRequestId`) under a time window (`holdReleaseConfig`). `dedup/attach-to-existing-payment.ts` takes a per-user advisory lock (`ingest-dedup:<userId>`) around "find the existing row, else log".
- **Own-output guard.** `prefilter-notification.ts` builds regexes from the `ingest.summary.*` banner templates (`OWN_OUTPUT_KEYS`, `OWN_OUTPUT_VARIABLES`) so the shortcut's banner never re-triggers the shortcut. A new banner text must be added there.
- **Shortcut.** `build-payments-shortcut.ts` decodes the setup code (`url`, `token`, `cfAccessId`, `cfAccessSecret`, optional `gate`), runs Match Text of title/subtitle/body against the gate pattern, stops on a miss, and posts `kind: notification`. The Notification trigger lists the apps the owner picked (`PRESELECTED_APPS` = Wallet, Messages). The signed `public/shortcuts/log-payments.shortcut` is made by the owner (import the plist on an iPhone and export it), so the owner reinstalls after every shortcut change. `showBanner` in `shortcut-plist.ts` sets the Show Notification title to the shortcut name (`SHORTCUT_PARAMS.notificationTitle`), which produces the second "MoneyMatter - Log payments" line.
- **Retention.** `crons/ingest-requests-cleanup.ts` deletes `logged | rejected | dismissed` after `INGEST_REQUEST_RETENTION_DAYS` and `ignored` notifications after `ignoredTtlMs` (7 days).
- **AI categorization** (`services/ai-categorization`) already reads the transaction note; `categorizeAfterCommit` skips a row that keeps its payee's history category.

## Decisions

### D1. Context is a source mode, seeded for known apps

`NOTIFICATION_SOURCE_MODES` gets `context`; `NOTIFICATION_SOURCE_USER_MODES` gets `context` (the owner can switch any non-conversational source to it; a messaging or mail source cannot be context, the PATCH answers 422). `context` is not in `NOTIFICATION_SOURCE_TRUSTED_MODES`: a context source never reaches the payment parser.

`getDefaultSourceMode` returns `context` for the seed list `CONTEXT_APP_NAMES` (lower-cased, normalized: `wolt`, `glovo`, `bolt food`, `uber eats`, `yandex eats`, `yandex eda`, `яндекс еда`, `amazon`, `deliveroo`, `doordash`; matched case-insensitively, the device shows "Wolt"). Like the seeded banks they need no approval: the text only goes to the AI when the rules cannot read it, and the owner's trigger list already limits which apps the shortcut forwards. The seed also carries, per service, the **service name** shown in the note and the **merchant hints** used to find the bank payment (`wolt` -> service "Wolt", hints `["wolt"]`; `bolt food` -> "Bolt Food", hints `["bolt food", "bolt.eu/f"]`; `uber eats` -> "Uber Eats", hints `["uber eats", "ubereats"]`; `amazon` -> hints `["amazon"]` with `excludes ["prime", "kindle", "audible", "music"]`). A hint is service-specific (never a bare brand shared with rides) and an `excludes` word removes a row that carries it, so a Bolt or Uber ride never matches a food order. **An existing source of a seed app that is still `pending`** (never decided; created earlier by an amount-bearing push) is treated as `context` and moved to it on its next notification (its approval card and parked `sourceNotApproved` texts are resolved as in the next paragraph); an `approved`, `auto` or `muted` one keeps what the owner decided. For a source the owner switched to context, the service name is the source's app name and the hint is the normalized app name.

Moving a source **to** `context` (by the owner or by the rule above) also resolves its open approval card (`resolveCardsElsewhere`) and deletes its parked `sourceNotApproved` requests with their stored text; it never feeds them to the payment parser. Muting or leaving `context` deletes the source's `held` requests as well as its parked ones.

*Alternative rejected:* start them `pending` and make the owner approve. It adds a step for a mode that cannot create a transaction, and the first Wolt notification would be held and never matched.

### D2. How the device learns which apps may pass without an amount

The gate on the device stays a privacy gate that sees only text. A second, separate test lets a no-amount notification through when its **app name** matches a context pattern:

- The shortcut **embeds the seed list** as an ICU pattern (`CONTEXT_APP_GATE_PATTERN`, built from `CONTEXT_APP_NAMES` in the shared module and compared by the spec, exactly like `AMOUNT_GATE_PATTERNS`). The shortcut is regenerated by this change and reinstalled anyway.
- The setup code gets an optional field `context`: an extra pattern for the apps the owner switched to context that are not in the seed. The shortcut tests the embedded seed pattern first and the extra one when the code has it; either match lets the notification through. A change to the extra list needs a new setup code and a re-import, the same constraint the gate strictness already has, and the sources list says so on a non-seed context source.
- The server is authoritative: it lets a no-amount notification through only for a source in `context` mode (or, before the source exists, a seed app). A device that passes too much changes nothing (the embedded seed pattern cannot be narrowed per owner: a seed app the owner muted and left in the trigger list still sends its no-amount text to the owner's own server, which drops it before storing anything; the docs say to remove such an app from the trigger list); a notification from any other app with no amount is still `noAmount`.

*Rejected: the shortcut fetches the list from the server per notification.* It adds a network call to every notification of every app, a new failure mode (offline = the context is lost or everything is blocked), and a GET endpoint. *Rejected: the shortcut sends only the app name and a minimal envelope for every no-amount notification and the server decides.* It makes the device send the existence (app, time) of every chat and promo, which the amount gate exists to prevent. The chosen design sends text only for apps the owner has marked as context.

Privacy: a context notification's title/subtitle/body leave the phone only for context apps, to the owner's own server; they are stored encrypted like any notification and wiped once read (D6).

### D3. Reading a context notification

`services/ingest/context/parse-context-notification.ts` returns `{ store: string | null, status: 'accepted' | 'preparing' | 'onTheWay' | 'delivered' | 'cancelled' | 'other' }` or `null` when the text is not about an order.

1. **Rules first** (no AI): a small table of regexes per service over the joined title/subtitle/body. It ships with the one pattern the owner's sample proves for Wolt ("`<store>` has accepted your order") plus the obvious English siblings; each rule extracts the store and a status. The table is data (`context-rules.ts`) with one fixture per rule, so a new service's text is a line added with a test.
2. **AI fallback** when no rule matches: the existing `notificationParsing` feature (same connection, allowance, `takeIngestAiCall` daily limit, `trackAiUsage`) with a different prompt and a small schema (`isOrderUpdate`, `store`, `status`, `confidence`). The text is untrusted data, wrapped and stripped exactly like `notification-prompt.ts`. A `store` the model returns must appear in the notification text (compared normalized, case- and whitespace-insensitive); otherwise it is dropped to `null`, so the model cannot invent a place. A promo ("20% off your next order") is `isOrderUpdate: false`.
3. No AI configured, cap or daily limit spent: the context request is `ignored` with reason `contextUnreadable` (not parked: a context note is not worth an inbox card).

Only a notification with a **store** can write anything. A notification without one ("Your courier is on the way") and a `cancelled` one never writes a note.

### D4. Matching a context notification to a payment

Under the user's lock `ingest-context:<userId>` (one lock for match, hold and apply, so a context and its payment that arrive together cannot miss each other). The lock orders context work only; the note write itself re-reads the row `FOR UPDATE` (D5).

1. **Repeat of an order already handled.** Looked up on the `IngestRequests` side, not on the transaction (a bank settlement rebuilds `externalData` and loses markers): a notification-pipeline request of the same user, service and **normalized store** (lower-cased, non-alphanumerics removed, `&` = `and`, so "Urban Roastery&Coffee" equals "Urban Roastery & Coffee") in status `enriched`, `held`, or `ignored` / `contextNoteKept`, created within `repeatWindowMs` (3 h, longer than any delivery) makes the new notification a repeat: `ignored` / `contextRepeat`, silent, nothing changes. Every outcome keeps `parsed.context = { service, store, status, at }` for this lookup. This is what makes accepted / on the way / delivered enrich once, however late the later ones arrive.
2. **Candidates**: the user's expense rows that carry `externalData.cardPayment` or `externalData.ingest` (so a row a later notification attached to, and a planned/settled bank row, count), whose payee name, a payee alias or `cardPayment.merchant` contains a service hint as a whole word and no `excludes` word, with `time` inside `[context time - lookbackMs, context time + lookaheadMs]`, and that no `enriched` request already points at (that row belongs to another order).
3. **Unique pairing, never a guess.** A match is made only when it is 1:1: exactly one candidate payment, and no other open context (a `held` one, or one whose store differs) of the same service inside the same window. Time is the only signal the bank text leaves (it says "Wolt" for both orders), and venues accept orders with different latency, so "nearest" would swap two close orders. Two payments, or two contexts, of one service within `ambiguityWindowMs` of each other are left alone: the context is **held** and the request history says so. A held context whose competitors go away (the other payment is removed, the other context expires) is matched by the next `applyHeldContext` pass.
4. **Apply** (D5) to the picked row; the request becomes `enriched`, linked through `transactionId`.
5. **No candidate (or ambiguous): hold.** The request becomes `held` for `holdMs`. Its text is wiped at once; `parsed` keeps `{ parser, kind: 'context', confidence, context: { service, store, status, at } }`, all the later match needs.
6. **A payment is logged or joined** (any pipeline, including a bank notification that attaches to an existing row, which skips the follow-up queue today): `afterPaymentLogged` gains `applyHeldContext`, and the attach branch of `processNotification` / `run-ingest-pass` enqueues it too. Under the same lock it runs steps 1-4 for the held contexts of the payment's service. A held context older than `holdMs` is skipped and swept.

Config object `contextConfig` (an object so tests can shorten it): `lookbackMs = 15 min` (the payment may precede the context by up to this), `lookaheadMs = 20 min` (the payment may follow it; also `holdMs`), `ambiguityWindowMs = 10 min`, `repeatWindowMs = 3 h`. The first, store-bearing notification of an order arrives within minutes of the payment; later ones are repeats found by step 1, so a long lookback is not needed.

Accepted limit: two orders of one service paid within ten minutes get no automatic notes (the owner types them, as today); a wrong note is worse than a missing one.

### D5. Enrichment

A new `apply-context.ts`, one place that writes. For the picked row:

- **Note**: `t('ingest.contextNote', { store, service })` in the owner's locale ("Urban Roastery&Coffee order from Wolt"). Written only when the row's note is empty, **or** the row is still unconfirmed and its note equals `ingest.systemNote` (a note the pipeline wrote). Any other note is the owner's and is left alone; the context is then recorded as seen with `noteApplied: false` and the request is `ignored` with reason `contextNoteKept` (no banner: nothing was added).
- The write loads the row `FOR UPDATE` and re-checks the note policy inside the transaction (the owner's own edits and `suggestNoteAfterCommit` do not take the context lock), exactly like `writeNote` in `suggest-note-after-commit.ts`. It is `updateTransaction({ keepIngestUnconfirmed: true, note })` and `ingest.systemNote` set to the new note, so a later merge, edit or the owner's confirm tells it from the owner's own text (the `suggestNoteAfterCommit` write). It works the same on a confirmed row with an empty note.
- **Marker**: `externalData.ingest.context = { requestId, service, store, status, noteApplied }`, informational for the transaction view; the guard against stacking is the request-side lookup (D4.1, D4.2).
- **Event**: `INGEST_PAYMENT_UPDATED` after commit, so the one confirm card of the row shows the note (the inbox listener already does this for the AI-picked note).

### D6. Request lifecycle and answers

New statuses `held` (waiting for its payment) and `enriched` (applied to a row; `transactionId` set). New ignore reasons: `contextRepeat`, `contextNoteKept`, `contextUnreadable`, `contextExpired`. New outcomes in `NOTIFICATION_OUTCOMES`: `enriched` (banner) and `held` (silent). The text is wiped as soon as the context is read (a held/enriched row keeps only `parsed.context`).

Summaries (user's locale): `ingest.summary.contextAdded` = "Added {store} to {amount} at {merchant}" (the banner; also added to `OWN_OUTPUT_KEYS`, with `store` in `OWN_OUTPUT_VARIABLES`, so it cannot re-fire the shortcut) and `ingest.summary.contextHeld` for the history row of a held request. A context request that exceeds the wait budget answers silently (`notify: false`), not "Queued".

`ignoredTtlMs` already keeps `contextRepeat | contextNoteKept | contextUnreadable | contextExpired` rows for a week. `enriched` joins the finished statuses the cleanup deletes after the retention period. The cleanup also turns a `held` request past `holdMs` into `ignored` / `contextExpired`.

### D7. Server prefilter and ordering

`ingestNotification` looks the source up **before** the prefilter. `prefilterNotification` gets `contextApp: boolean` (source in `context` mode, or no source yet and a seed app). For a context app it skips only the `noAmount` test; `self`, `security` and `promo` still apply, so Wolt promos and codes are dropped. The context path in `processNotification.read()` is taken **before** the `trusted` check, for `source.mode === 'context'`, whatever the text shows (a context notification that prints an amount is still context: it never creates a transaction). The per-user caps and the fold/idempotency rules apply unchanged.

A source switched away from `context` deletes its held requests (as muting deletes held ones). Switching a source **to** context releases nothing.

### D8. Shortcut: context test and a shorter banner

- **Context test.** After the amount gate (Match Text) misses, instead of stopping at once the shortcut matches the notification's **App** against the embedded context pattern (and, when the setup code has `context`, the extra one); only a match goes on, anything else stops. The send block is unchanged and the body is the same `kind: notification` JSON. The key (hash of app, title, subtitle, body, time) is unchanged.
- **Setup code.** `context` is an optional string like `gate`, with its own length cap; the decoder keeps ignoring unknown keys, so old shortcuts keep working with new codes. `createCardPaymentSetupCode` adds `context` for the owner's non-seed context sources.
- **Trigger list.** The trigger's app list is the owner's. The setup instructions and the docs say to add Wolt (and the like) to it. `PRESELECTED_APPS` stays Wallet and Messages: iOS has no "any app", and adding delivery apps the owner does not use is clutter.
- **Banner.** `showBanner` stops passing the title (`WFNotificationActionTitle`), so iOS shows the shortcut name once as the header and the summary as the body. I could not check on a device what iOS renders for an absent title; the expectation is header + body only. If the owner sees an empty title line, the fallback is a one-word title. The change applies to both shortcuts (they share `createShortcutKit`); the specs that assert the title are updated.

### D9. Category: not changed in this plan

The note is written; the category is left as the payee default. Reasons: the payee default (and the owner's history) is usually right for "Wolt" as a whole, a store name is a weak signal for a payee that sells restaurants and groceries, and the existing categorization path skips a row that keeps its history category on purpose. The note is on the row, so the next time the owner or the AI categorizes it, the store name is part of the input (`categorization-service.ts` reads `note`). If the owner wants refinement later, it is a follow-up that calls `queueCategorizationJob` for a row whose category still equals `ingest.systemCategoryId` with no `categorizationMeta`.

### D10. No migration

`NotificationSources.mode` and `IngestRequests.status/reason` are unconstrained strings; the context data lives in `parsed` (requests) and `externalData.ingest.context` (rows). Their column comments list the old values; they are left as they are rather than adding a migration for a comment.

## Development Approach

- Test-first for the pure parts (seed list, gate pattern, rule parser, picker, note policy); backend e2e through the HTTP endpoints only (`POST /ingest/event`, sources PATCH, requests list), per the repo rules, for everything that touches the database.
- Heavy commands go through the shared `mm-heavy.sh` wrapper; run only affected files until the final check.
- Conventional Commits `type(scope): lowercase description`, one logical change per commit, no `Co-Authored-By`.
- `en` + `uk` i18n keys written together through the i18n editor; never other locales.

## Testing Strategy

- **Unit:** seed/mode helpers; `CONTEXT_APP_GATE_PATTERN` against the seed names and non-matches; setup-code `context` round trip and size caps; rules parser with the real Wolt sample and negatives; AI-answer validation (store must be in the text); candidate picker (single, nearest, ambiguous, same-store repeat, different-store excluded); note policy table; prefilter with `contextApp`.
- **Backend e2e** (`POST /ingest/event`, no direct service calls): the owner's case end to end (bank push logged, then the Wolt notification enriches it, the banner is "Added ..."); context first, payment second (held, applied by the payment's follow-up); accepted + on the way + delivered enrich once; two orders from two stores; an owner-written note survives; a confirmed row with an empty note is enriched; ambiguous stays held; no-amount from a non-context app is still dropped `noAmount`; promo/OTP from a context app dropped; muted/not-context source; conversational source cannot be context; AI mocked over MSW for the fallback and for "store not in text".
- **Frontend:** sources list shows the Context badge and action, hint for a non-seed context source, STATUS_VARIANTS cover `held` and `enriched`; the generated plist spec (context test, embedded pattern equals the shared one, banner without title) and the served-shortcut spec.
- **Final:** `npm run lint`, typecheck (backend, frontend, shared), affected suites, then a revmux claude-only round.

## Implementation Steps

### Task 1: Shared types, seed list and setup code

**Files:**

- Create: `packages/shared/src/types/ingest/context-apps.ts` (seed `CONTEXT_APPS` with app names, service name, merchant hints; `isContextApp`, `getContextService`, `CONTEXT_APP_GATE_PATTERN`)
- Modify: `packages/shared/src/types/ingest/notification-sources.ts` (mode `context`, `getDefaultSourceMode`, `NOTIFICATION_SOURCE_USER_MODES` in `ingest-event.ts`), `packages/shared/src/types/ingest/ingest-event.ts` (outcomes `enriched`, `held`), `packages/shared/src/types/ingest/index.ts` (statuses `held`, `enriched`; ignore reasons), `packages/shared/src/types/ingest/card-payment-setup-code.ts` (optional `context`)
- Modify: `packages/backend/src/services/ingest/create-setup-code.ts` (add `context` for non-seed context sources)
- Create/modify: `context-apps.unit.ts`, `notification-sources.unit.ts`, `setup-code.unit.ts`, `setup-code.e2e.ts`

- [ ] write failing tests: seed names resolve to a service and hints; default mode of a seed app is `context`; the gate pattern matches every seed name in display case ("Wolt", "Uber Eats") and none of "Messages", "Wallet", "TBC"; `context` survives encode/decode and an over-long one is refused
- [ ] implement the shared module, modes, statuses, reasons, outcomes and the setup-code field
- [ ] create-setup-code: include the extra pattern only for context sources that are not in the seed
- [ ] gate: shared unit tests; `npm run test:e2e -- --testPathPattern='ingest/setup-code'`

### Task 2: Source settings: switch to context, validation, held cleanup

**Files:**

- Modify: `packages/backend/src/controllers/ingest/notification-sources.controller.ts`, `packages/backend/src/services/ingest/event/notification-sources.service.ts`
- Modify: `packages/backend/src/services/ingest/event/notification-sources.e2e.ts`

- [ ] write failing e2e: PATCH a source to `context`; a conversational source refuses it (422); moving a pending source with an open approval card to `context` closes the card and deletes its parked texts (nothing reaches the payment parser, and a later approve does not resurrect them); leaving `context` or muting deletes the source's `held` requests; an existing `pending` Wolt source becomes `context` on its next no-amount notification while an `approved` one does not
- [ ] implement; `touchNotificationSource` already uses `getDefaultSourceMode`
- [ ] gate: `--testPathPattern='event/notification-sources'`

### Task 3: Prefilter and endpoint ordering

**Files:**

- Modify: `packages/backend/src/services/ingest/event/prefilter-notification.ts`, `ingest-event.ts`, `prefilter-notification.ts` already owns `OWN_OUTPUT_VARIABLES`: add `store` there
- Modify: `prefilter-notification.unit.ts`, `ingest-event.e2e.ts`

- [ ] write failing tests: `contextApp: true` passes a no-amount text but still drops `self`, `security`, `promo`; `contextApp: false` unchanged; a no-amount Wolt notification is recorded (a source row is created in `context` mode); a no-amount notification from an unknown app is dropped `noAmount`; a muted Wolt source drops it
- [ ] move the source lookup ahead of the prefilter and pass `contextApp`; keep every other check and order
- [ ] add `ingest.summary.contextAdded` to `OWN_OUTPUT_KEYS` and `store` to `OWN_OUTPUT_VARIABLES`, both in `prefilter-notification.ts` (with a test that the banner text is dropped as `self`)
- [ ] gate: `--testPathPattern='event/(ingest-event|prefilter)'`

### Task 4: Reading a context notification

**Files:**

- Create: `packages/backend/src/services/ingest/context/context-rules.ts`, `parse-context-notification.ts`, `parse-context-with-ai.ts`, `context-prompt.ts`, `context-config.ts`
- Create: `parse-context-notification.unit.ts`, `parse-context-with-ai.unit.ts`, `context-prompt.unit.ts`

- [ ] write failing tests: the owner's Wolt sample reads `{ store: 'Urban Roastery&Coffee', status: 'accepted' }`; a no-store text reads `store: null`; a promo reads `null`; the AI answer is validated (a store not in the text becomes `null`, an unknown status becomes `other`); the prompt wraps the text as untrusted and strips closing tags; no AI client, cap and daily limit give the `unavailable` result
- [ ] implement rules, schema, prompt, validation and the `contextConfig` object
- [ ] gate: `--testPathPattern='ingest/context/(parse|context-prompt)'`

### Task 5: Matching, applying and the processing branch

**Files:**

- Create: `packages/backend/src/services/ingest/context/find-context-payment.ts`, `pick-context-payment.ts`, `apply-context.ts`, `process-context-notification.ts`, `apply-held-context.ts`, `service-match.ts`, `context-note-policy.ts`
- Modify: `packages/backend/src/services/ingest/event/process-notification.ts` (context branch before the `trusted` check), `event/settle-notification.ts` (`holdContext`, `enrichContext`, `ignoreContext` writes), `event/wait-for-outcome.ts` (`enriched`, `held`, silent queue for a context request), `event/stored-parse.ts` (context shape), `card-payment/format-summary.ts`, `card-payment/list-requests.ts` (merchant/amount text for a context row from its summary), `after-payment-logged.ts` (call `applyHeldContext`)
- Create: `pick-context-payment.unit.ts`, `context-note-policy.unit.ts`, `service-match.unit.ts`, `context-notification.e2e.ts`

- [ ] write failing unit tests for the picker (single 1:1, two payments in the window, two open contexts in the window, same-store repeat arriving after the lookback, store-name drift "Roastery&Coffee" vs "Roastery & Coffee", row already enriched excluded, a ride payment of the same brand excluded by `excludes`/hints), the note policy (empty, pipeline note unconfirmed, owner note, confirmed with empty note) and the service match (`WOLT.COM TBILISI`, alias, payee name, unrelated payee)
- [ ] write failing e2e: payment then context -> note set, `ingest.systemNote` set, banner "Added ..."; context then payment -> `held`, then applied by the payment's follow-up; accepted + on the way + delivered -> one note, the later two `contextRepeat`; two orders of two stores more than ten minutes apart each get their own note, two within ten minutes get none and stay held (both arrival orders, including payment B logged before payment A and a late 'accepted' for A); a 'delivered' 45 minutes after the payment is a repeat and a second order does not receive its note; a bank notification that attaches to an existing row triggers the held-context pass; a bank-settled row whose markers were rebuilt is still not enriched twice; the owner saves a note while the context pass runs and the note survives; owner-written note kept (`contextNoteKept`); ambiguous stays `held`; the confirm card shows the note; expired held request is not applied
- [ ] implement the lock, candidate query (ingest rows of the user, expense, window, service match), the pick, the apply (D5) and the three settle writes; text wiped on every outcome
- [ ] implement `applyHeldContext` in the follow-up and make a failure log and leave the row as it was
- [ ] gate: unit `--testPathPattern='ingest/context'`; e2e `--testPathPattern='context/context-notification.e2e|event/process-notification'`

### Task 6: Retention and expiry

**Files:**

- Modify: `packages/backend/src/crons/ingest-requests-cleanup.ts`, `packages/backend/src/crons/ingest-requests-cleanup.e2e.ts`

- [ ] write failing e2e: a `held` request past `holdMs` becomes `ignored` / `contextExpired`; an `enriched` request is deleted after the retention period; a fresh `held` one stays
- [ ] implement both sweeps and add their counts to the cron result
- [ ] gate: `--testPathPattern='crons/ingest-requests-cleanup'`

### Task 7: Shortcut: context test and banner without a title

**Files:**

- Modify: `packages/frontend/scripts/shortcuts/build-payments-shortcut.ts`, `shortcut-plist.ts` (`decodeSetupCode` reads `context`; `showBanner` drops the title), `build-card-payment-shortcut.ts` if it names the title
- Modify: `build-payments-shortcut.spec.ts`, `build-card-payment-shortcut.spec.ts`, `served-payments-shortcut.spec.ts`, fixtures
- Regenerate: `packages/frontend/shortcuts/log-payments.plist`, `log-card-payment.plist` (`npm run shortcuts:build`)
- Modify: `packages/frontend/public/shortcuts/README.md` (re-sign steps stay; note the new import needed)

- [ ] write failing spec: the embedded context pattern equals `CONTEXT_APP_GATE_PATTERN`; a gate miss with a matching App continues to the send, a miss without one stops; the extra `context` pattern is read from the code; the banner has no `WFNotificationActionTitle` in either shortcut
- [ ] implement and regenerate the plists (the committed XML is compared by the spec)
- [ ] gate: `--run scripts/shortcuts`
- [ ] hand-off to the owner: the signed `.shortcut` files are not rebuilt here; they are re-exported from an iPhone after importing the new plists

### Task 8: Frontend: Context in the sources list and history

**Files:**

- Modify: `packages/frontend/src/pages/accounts/integrations/ios-automation/components/notification-sources.vue`, `pending-sources.vue`, `waiting-payments.vue` (`STATUS_VARIANTS`, labels for `held` / `enriched` and the new reasons), `ios-automation.ts` if the status helpers need it, `triggered-shortcut-setup.vue` (tell the owner to add the delivery apps to the trigger list)
- Modify: `notification-sources.spec.ts`, `notification-sources.vue` spec, `pending-sources.spec.ts`
- i18n (`en` + `uk`, through the i18n editor): `integrations.iosAutomation` modes, the "use as context" action, the "needs a new setup code" hint, history statuses and reasons

- [ ] write failing specs: Context badge and action, hint only for a non-seed context source, `pending-sources` offers "Context only", the history renders `held` and `enriched` rows
- [ ] implement; copy that is not obvious is drafted and flagged for the owner
- [ ] gate: `--run src/pages/accounts/integrations/ios-automation`

### Task 9: Docs

**Files:**

- Modify: `packages/docs/src/content/docs/integrations/ios-automation.mdx`, `public/shortcuts/README.md`

- [ ] a "Context from delivery apps" section: what a context source is, the seed list, adding an app to the trigger list, that a non-seed context app needs a new setup code, how the match works (time window, one note per order, an own note is never overwritten), what is sent from the phone
- [ ] document the banner change in the screenshots' captions if any show the old title

### Task 10: Verify acceptance criteria

- [ ] the owner's case: TBC push "60.64 GEL ... Wolt" logs; the Wolt "Order confirmed" notification enriches that row with "Urban Roastery&Coffee order from Wolt" and the shortcut answer is "Added Urban Roastery&Coffee to 60.64 GEL at Wolt"
- [ ] context-before-payment works and applies once
- [ ] accepted / on the way / delivered leave exactly one note
- [ ] two close orders do not cross-match; an ambiguous case stays held, no card
- [ ] an owner-written note and a non-context no-amount notification are untouched
- [ ] lint, typecheck of backend, frontend and shared; affected unit, e2e and frontend suites green
- [ ] revmux claude-only review, findings fixed

## Post-Completion

- Owner: import the regenerated `log-payments.plist` on an iPhone, export the signed `.shortcut`, replace `public/shortcuts/log-payments.shortcut`, generate a new setup code if a non-seed context app was added, and add Wolt (and the like) to the Notification trigger's app list.
- Owner: watch the first real Wolt / Glovo notifications in the request history; each rule that the AI had to cover is a candidate line in `context-rules.ts`.
- Follow-up if wanted: category refinement from the store (D9).
