# Card-payment ingest from an iOS Shortcut (Apple Pay)

## Overview

Every Apple Pay payment should land in MoneyMatter by itself, within seconds, without the owner typing anything. iOS Shortcuts has a Wallet **Transaction** personal automation ("when I tap any of these cards", "Run Immediately") that hands the payment to a shortcut. The shortcut POSTs it as JSON to MoneyMatter. MoneyMatter maps the card to an account, finds or creates the payee, picks a category, converts the currency when needed, stores the row and answers with one line the shortcut shows as a notification:

> Logged 47.00 GEL at Cafe Heart of Batumi → Bar, cafe

The plan delivers:

1. **Personal ingest tokens:** per user, hashed at rest, shown once, named, scoped (`ingest:transactions`), with a last-used time, revocable from Settings.
2. **Card → account mappings** in Settings, keyed by the Wallet card name. A payment from an unmapped card is **parked**, not lost and not guessed, and is logged with one click once the card is mapped.
3. **`POST /api/v1/ingest/card-payment`:** a generic card-payment endpoint (the Apple Pay shortcut is its first client), validated, rate-limited, idempotent, with a dry-run mode for testing.
4. **Processing** through the existing pipelines: payee extraction and logo resolution, payee default category, the most frequent past category for that payee, AI categorization (queued, with a short bounded wait), currency conversion with `originalAmount`/`originalCurrencyCode`, and a planned row on bank-connected accounts so a later bank sync confirms it instead of duplicating it.
5. **One-tap setup:** one generic, signed shortcut, "MoneyMatter: log card payment", served by the app. Its single import question takes a **setup code** that Settings → Integrations → Apple Pay generates (ingest URL, token and optional Cloudflare Access headers). The page shows the code once, with a copy button and a QR code, plus an **Add Shortcut** button and a three-step checklist for creating the automation on the phone.
6. **Docs:** a user page for the one-tap flow, the manual step-by-step shortcut guide as the fallback, and an API reference.

Out of scope: TBC bank sync (a separate plan), writing to the owner's Google Sheet, refunds through the Wallet trigger, and shared-account targets.

The work happens in the fork on `feat/apple-pay-ingest` (cut from `dev`) and is offered upstream, so names are generic ("card payment", "ingest"), nothing is owner-specific, and it works on self-hosted and cloud instances alike.

## Context (from discovery)

- **Auth machinery that exists today:**
  - Sessions: better-auth 1.6.30 (`packages/backend/src/config/auth.ts`, `ba_*` tables), `authenticateSession` in `middlewares/better-auth.ts` (resolves the app user via `findAppUser`, caches it under `APP_USER_CACHE_KEY_PREFIX`, then `enforceReadOnly`).
  - **MCP OAuth:** `@better-auth/oauth-provider` issues opaque access tokens (72 h) and refresh tokens (60 days) after an interactive consent; `services/mcp/auth.ts` verifies them by SHA-256/base64url hash (`hashToken`) against `ba_oauth_access_token`, with scopes `finance:read|write|delete`. Settings → AI → **Connected apps** lists and revokes them (`services/mcp/connected-apps.ts`, `routes/user.route.ts:205-206`, `frontend/src/pages/settings/subpages/ai/pages/connected-apps.vue`).
  - **Attachment upload tokens:** short-lived, single-transaction tokens (`middlewares/attachment-upload-auth.ts`).
  - There is **no long-lived personal API token** anywhere. The better-auth API-key plugin is a separate package in the 1.6 line (`@better-auth/api-key`, peer `better-auth ^1.6.30`) and is not installed.
- **Rate limiting:** `middlewares/rate-limit.ts` (`createRateLimit`, Redis-backed `RateLimitService`, per-user or per-IP keys, `failClosed`).
- **Base-currency guard:** `middlewares/check-base-currency-lock.ts` reads `req.user`. `routes/base-currency-guard-coverage.e2e.ts` walks the Express stack and requires `checkBaseCurrencyLock` on every **`authenticateSession`** mutating route, or an entry in `GUARD_EXEMPT_ROUTES`. A route authenticated by any other middleware is invisible to it today.
- **Transactions:** `services/transactions/create-transaction.ts` (`createTransaction`, `withTransaction`-wrapped).
  - Takes `rawMerchantName` (payee extraction), `payeeId`, `categoryId`, `tagIds`, `applyAutomations` (stamps `externalData.applyAutomations`, makes the row automation-eligible), `isPlanned`, `originalAmount`/`originalCurrencyCode`, `externalReference` (`varchar(255)`, no index) and `externalData` (JSONB).
  - Rounds every entered figure through `roundTransactionMoney`, computes `refAmount` with `calculateRefAmountOrNull`, then runs subscription matching, user automations, `applyPayeeCategorization`, payee default tags and location.
  - **A non-planned manual row on a bank-connected account is rejected** (`resolveAccountTypeForManualWrite`, `transactions.manualOnConnectedAccount`). Only planned rows may sit there.
  - The HTTP schema requires `categoryId` for non-transfers; providers pass the user's default category (`getUserDefaultCategory`, `Users.defaultCategoryId`) as "uncategorized".
- **Pending:** there is **no `isPending` column**. The serializer derives `isPending` from the EnableBanking raw status (`isPreBookingStatus(getRawTransactionStatus(externalData))`, `bank-data-providers/enablebanking/utils/transaction-metadata.ts`), so it exists only for rows that provider wrote.
- **Bank-sync settlement:** every provider (EnableBanking, Monobank, SimpleFIN, LunchFlow, Walutomat) and the statement import pass `matchPlanned` to `createTransaction`. `tryMergeIntoPlanned` → `findPlannedMatch` (`services/transactions/planned-matching/`) locks a planned row on the same account with the **exact** amount, currency and type within `PLANNED_MATCH_WINDOW_DAYS` (7), and `mergeIntoPlanned` turns it into the real row in place: it keeps the plan's amount, category and payee, joins the notes, takes the bank's time, `originalId` and `externalData`, and flips `isPlanned`. Planned rows need the account owner and a positive amount (`assert-planned-invariants.ts`).
- **Payees:** `Payees.defaultCategoryId` + `categorizationMode` (`enforce` | `hint` | `off`, `shared/src/types/payees.ts`) **is** the payee default-category concept.
  - `resolvePayeeForRawMerchant` (`services/payees/extraction.service.ts`): exact name/alias match → ignored-names gate → fuzzy match (adds an alias) → **occurrence promotion** only when prior unmatched rows + 1 reach the user's `payeePromotionThreshold` (default 2), then `enqueueLogoResolutionAfterCommit` (logo.dev). A first-seen merchant therefore gets **no** payee today.
  - `resolvePayeeForIncomingRow` wraps it in a savepoint; `normalizePayeeName` normalizes.
- **AI categorization:** `services/ai-categorization/`. `queueCategorizationJob` (BullMQ) → `categorizeTransactions`, which resolves the user's AI client per feature (`createAIClient`, including the Claude Code/Codex CLI connections from the CLI-providers plan) and selects candidates with `categorizationMeta IS NULL`, non-transfer and **non-planned** rows. Only `TRANSACTIONS_SYNCED` (bank providers) auto-queues it.
- **Currency conversion:** `calculateRefAmount({ userId, amountOwnerUserId, amount, baseCode, quoteCode, date })` converts between any two codes. `calculateRefAmountOrNull` returns `null` only for custom currencies; an ISO pair with no rate throws `ExchangeRateUnavailableError`. Converted values round half-even (CLAUDE.md rule 6).
- **Secrets at rest:** `common/utils/encryption.ts` (`encryptToken`/`decryptToken`, AES-256-GCM).
- **Backups:** `services/backup/registry.ts` (`BACKUP_TABLES`, `BACKUP_EXCLUDED`); every model has to be in one of them.
- **Frontend:** Settings tabs in `pages/settings/settings.vue`, routes in `routes/index.ts` / `routes/constants.ts`. There is no Integrations section and no QR-code library. `getMcpServerUrl` (`api/mcp.ts`) shows how an absolute API URL is built (`API_HTTP || window.location.origin`); `config.isSelfHost` exists. Static files live in `packages/frontend/public/`, served by `packages/frontend/nginx.conf`, which also proxies `/api/`.
- **Docs:** `packages/docs` (Astro Starlight), sections from directories, conventions in `.claude/skills/user-docs/SKILL.md`.
- **What iOS provides (verified on the web, 2026-10-17):**
  - The Wallet Transaction automation's Shortcut Input exposes only **Transaction, Card (or Pass), Merchant, Amount and Name**. There are **no last-4 digits, no currency field and no transaction time** ([Apple Community](https://discussions.apple.com/thread/256252606), [Automators](https://talk.automators.fm/t/apple-wallet-to-csv/17674), [Pocket Clear guide](https://pocketclear.app/blog/auto-log-apple-pay-bank-sms-iphone-shortcuts.html)).
  - The Amount's text form is not documented, so the server must parse a symbol or code with locale separators. Users report runs where Amount is `0` and Merchant is blank ([Apple Developer Forums](https://developer.apple.com/forums/thread/797233)).
  - iOS imports only **signed** shortcuts. Signing needs macOS (`shortcuts sign --mode anyone|people-who-know-me`) or an iCloud share link. A generated XML plist can be signed ([shortcuts-generator](https://www.claudepluginhub.com/skills/sundial-org-sundial-org-awesome-openclaw-skills-4/shortcuts-generator)), though signing has failed for some users ([Apple Developer Forums](https://developer.apple.com/forums/thread/728447)). So a Linux server cannot produce a signed per-user file.
  - Personal automations cannot be shared, only shortcuts ([Apple Community](https://discussions.apple.com/thread/254467149)): the user creates the automation on the phone.
- **Conventions (repo CLAUDE.md):**
  - Object params and kebab-case files.
  - E2E only through HTTP helpers, run by the `test-runner` subagent and never in parallel; at least happy path, empty state and an error case per endpoint.
  - Change unmerged migrations instead of adding new ones.
  - i18n through the `i18n-editor` subagent, always `en` + `uk`.
  - Decimals in the API, `Money` everywhere, round every money write.
  - Comments describe the current code.
  - Stop and ask after 1–2 failed fix attempts.

## Decisions (after reading the code)

- **Tokens reuse better-auth through its API-key plugin, not the MCP OAuth tokens.**
  - OAuth access tokens expire after 72 h and renew only through a refresh-token exchange, and the grant needs an interactive consent. A Shortcut can do neither.
  - The API-key plugin (`@better-auth/api-key@1.6.30`) belongs to the same auth stack (a `ba_apikey` table next to the other `ba_*` tables, the same version line). It brings hashed storage, a display prefix, permissions, expiry and listing.
  - From the MCP code it reuses the Bearer handling, the cached app-user lookup and the Connected-apps revoke pattern, and from the attachment-token middleware the `req.user` + `enforceReadOnly` shape.
  - Task 1 verifies two things before anything builds on the plugin: that an API key can never stand in for a session, and that the table name can be set. If either fails, the fallback is a small `IngestTokens` table that reuses `hashToken` from `services/mcp/auth.ts`, moved to a shared helper. Everything above the token store stays the same either way.
- **Unknown card: park, not default account and not plain rejection.**
  - The request is stored with status `parked` and reason `unknownCard`, and the response is 202 with "Not logged yet: link the card 'TBC Visa' to an account in MoneyMatter".
  - The card name appears under **Unlinked cards** in Settings. Linking it offers to log the waiting payments.
  - Why: a default account files a payment on the wrong account, possibly in the wrong currency, and silently corrupts a balance. A plain rejection loses the payment, because the automation never fires again for it. In practice the trigger only fires for cards the user ticked, so this case is the first payment with a new card or a renamed card.
- **Pending: a planned row on bank-connected accounts, a normal row on manual accounts. No "Review" tag, no new `isPending` column.**
  - A connected account refuses manual rows anyway. A planned row is the existing "the bank will confirm this" state: every provider already merges a booked row into it (`matchPlanned`), which settles it in place, keeps the category and payee, and creates no duplicate.
  - Task 9 widens that match for card-payment plans, so a hold that settles at a different amount (tips, FX) still merges.
  - On a manual account there is no bank to settle against, so the row is final and counts in the balance at once.
  - A "Review" tag would be a per-user name that the code has to create or guess, and nothing would ever settle it.
- **Payee: find or create on first sight.** The ingest calls the existing resolver with a promotion threshold of 1 (a new optional parameter, default unchanged), so the payee and alias are created through the same `insertOrAdopt` path, the ignored-names blocklist still applies, and the logo is resolved by the existing queue. A card merchant name is a deliberate merchant field, not a guess from a note, which is why the promotion threshold does not need to protect it.
- **Category order:**
  1. User automations and the payee's `enforce`/`hint` default (existing `createTransaction` steps).
  2. Else the most frequent category of the user's past non-planned rows with that payee (last 12 months, ignoring the default category), passed as `categoryId` so the payee rule above still wins.
  3. Else AI, queued through the existing BullMQ job (trigger `sync`, scope `anyCategory`). The request then polls the row for up to 8 s so a quick answer still reaches the notification; a slower one says "categorizing…".
  4. Else the user's default category, as bank sync does.
  - The history pick leaves `categorizationMeta` null like `hint` mode does, so it is never mistaken for a user choice.
- **Missing exchange rate: park with reason `rateUnavailable`**, rather than storing a made-up account amount (the column is NOT NULL). It is retried from Settings or by resending the same idempotency key. With ISO pairs this is rare; with a custom-currency account it is the normal state until a rate exists.
- **Last-4 mapping is dropped:** iOS does not expose the digits (see Context). Mappings key on the normalized card name. A renamed card parks until it is linked again.
- **Setup code (owner's one-tap design), adjusted where iOS or the code requires it:**
  - **Generated server-side and shown once.** It carries the raw token, which exists only in the create response, and folds in the stored Cloudflare Access secret, which the client never gets back. The page therefore always **mints a new token** for a code; picking an existing token is impossible because tokens are stored hashed. The previous Apple Pay token can be revoked in the same step (default on).
  - **Standard base64 with padding, not base64url.** The Shortcuts **Base64 Encode → Decode** action expects standard base64.
  - **Decoded on every run, not at import.** A shortcut cannot run actions at import; the import question only fills one Text action's value. Decoding at run time costs milliseconds.
- **Idempotency key:** required (8–128 chars). Shortcuts has no documented UUID action (verify on the device). The bundled shortcut builds the key from the run's ISO timestamp with seconds plus the card, amount and merchant text, so a second run for the same payment is caught but two real payments are not merged. `externalReference` becomes `<source>:<key>` (for example `apple-pay:2026-10-17T13:05:22+04:00|TBC Visa|₾47.00|Cafe Heart of Batumi`), cut to 255 characters.
- **Amounts:** expense only. A negative or zero amount, or a blank merchant, is rejected (422) and recorded as `rejected`, so the Settings list shows that a payment came through empty (the known iOS glitch) and the user can enter it by hand.
- **Mappings target accounts the user owns** (no shared accounts in v1). Planned rows require the owner, and the payee and category namespaces are the owner's.
- **Guard coverage:** the ingest route writes transactions and ref amounts, so it carries `checkBaseCurrencyLock`. The coverage test treats `authenticateIngestToken` as an auth middleware too, so the invariant holds for it.

## Development Approach

- **Testing approach: TDD.** Each task first writes its failing tests (unit or e2e through HTTP helpers), runs them and records that they fail on assertions, not on setup. Then the task implements until they pass. A test written ahead of the code it needs is marked with the task that makes it pass.
- **Prefix every node/npm command** with `export PATH="$(mise where node@24.21.0)/bin:$PATH"`.
- **Commands:**
  - Backend unit: `cd packages/backend && npm run test:unit -- --testPathPattern='<regex>'`.
  - Backend e2e, never in parallel and never the full suite inside a task: `cd packages/backend && lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='<regex>'`.
  - Frontend: `cd packages/frontend && npm run test:unit -- --run <path>`.
  - Static checks at the root: `npm run typecheck`, `npm run lint`, `npm run format:check`.
- **Tests run through the `test-runner` subagent;** lint through `linter`.
- Complete each task fully before the next, with small, focused changes. **Every task's gate names the exact tests** that must pass.
- **Keep this plan current;** update it when scope changes.
- **Repo rules apply:**
  - Object params, kebab-case files, i18n keys for thrown errors.
  - `en` + `uk` together through `i18n-editor`.
  - Comments describe the current code.
  - Migrations: one new migration for this branch, amended rather than duplicated.
- **Commits:** none by implementing agents unless the owner asks (repo CLAUDE.md rule 10). This plan file is the only commit made at planning time.

## Testing Strategy

- **Backend unit:**
  - the amount/currency parser (symbols, codes, separators, negatives, zero);
  - card-name normalization;
  - the setup-code encoder/decoder (round trip, version field, optional headers, rejects unknown versions and oversize input);
  - the request fingerprint;
  - the summary formatter;
  - the frequent-category picker's selection rule (through e2e, since it reads the DB);
  - the planned-match tolerance rule;
  - the shortcut plist generator, including a drift check against the committed XML.
- **Backend e2e** (HTTP only, colocated with services, tokens created through the settings endpoint):
  - token create/list/revoke;
  - auth failures: missing, wrong, revoked and expired tokens, missing scope, a session cookie instead of a token, and a token used against a session route;
  - mapping CRUD;
  - ingest happy paths: same-currency, cross-currency, connected account (planned);
  - idempotency: same key returns the stored response; the same key with a different body is a 409;
  - parking: unknown card and missing rate, then retry after linking;
  - rejections: zero amount and blank merchant;
  - rate limit;
  - dry run;
  - category order: payee default, history, AI and default;
  - setup-code endpoint;
  - bank-sync settlement through a provider mock (exact and tolerance matches);
  - guard coverage.
- **Frontend vitest:** the setup-code page state (shown once, cleared on leave), the mapping editor, the unlinked-cards list, the ingest URL builder.
- **Frontend Playwright:**
  - create a token and see it once, then revoke it;
  - link a card;
  - generate a setup code and see the QR and the copy button.
- **Manual on the device** (Post-Completion): import the signed shortcut, run the automation with a real tap, run a dry run without input.

## Progress Tracking

- Mark completed items `[x]` immediately.
- Prefix newly discovered tasks with ➕ and blockers with ⚠️.
- After each gate passes, note the command and its result under the task.

## Solution Overview

- **Flow:**

  ```
  Wallet tap → Transaction automation → shortcut "MoneyMatter: log card payment"
    → decode setup code (url, token, CF Access headers)
    → POST {url} JSON {amount, currency?, merchant, card, name?, time, idempotencyKey, source:"apple-pay"}
       headers: Authorization: Bearer mm_ingest_…, CF-Access-Client-Id/Secret (if set)
  → [Cloudflare Access: service token on /api/v1/ingest/* only] → nginx /api/ → backend
  → authenticateIngestToken → checkBaseCurrencyLock → ingest rate limit → controller
  → IngestRequests row (idempotency) → parse → card mapping → convert → payee → category
  → createTransaction (planned on connected accounts) → AI queue + bounded wait
  → 200 {summary} | 202 parked {summary} | 422 rejected {message}
  ```

- **Token store:**
  - `apiKey()` plugin with `modelName: 'ba_apikey'`, prefix `mm_ingest_`, `permissions: { ingest: ['transactions'] }` (shown as the scope `ingest:transactions`), the plugin's own rate limiting off, and sessions from API keys off.
  - Our `services/ingest-tokens/` wraps create (returns the secret once), list (the user's keys with name, `start`, scope, `lastRequest` as `lastUsedAt`, `createdAt`, `expiresAt`) and revoke.
  - `authenticateIngestToken({ scope })` reads `Authorization: Bearer`, verifies the key with the required permission, resolves the app user through `findAppUser` and the existing app-user cache, sets `req.user` and `req.ingestToken`, then runs `enforceReadOnly`.
- **Data:**
  - **`CardAccountMappings`:** `id`, `userId`, `cardLabel`, `normalizedLabel`, `accountId` (FK, cascade), timestamps; unique `(userId, normalizedLabel)`. Backed up.
  - **`IngestRequests`:**
    - `id`, `userId`, `tokenId`, `source`, `idempotencyKey`, `fingerprint`, `status` (`logged` | `parked` | `rejected` | `dismissed`), `reason`, `payload` (JSONB, the parsed body), `cardLabel`, `transactionId` (FK, set null), `summary`, timestamps.
    - Unique `(userId, idempotencyKey)`.
    - Excluded from backups: an operational log that holds raw merchant text, tied to tokens that are not backed up either.
  - **`IngestSettings`:** `userId` PK, `accessClientIdEnc`, `accessClientSecretEnc` (both `encryptToken`), timestamps. Excluded from backups: credentials.
  - **`ba_apikey`:** excluded, like the other `ba_*` tables.
- **Ingest pipeline** (`services/ingest/card-payment/`, one `withTransaction`):
  1. Upsert the `IngestRequests` row by `(userId, idempotencyKey)` before any other write. A concurrent duplicate waits on the unique index, then reads the stored outcome. A stored `logged` outcome with the same fingerprint is replayed (200, `duplicate: true`); a different fingerprint is a 409. A stored `parked` or `rejected` outcome is processed again.
  2. Parse: amount and currency, time, merchant, card.
  3. Resolve the mapping, or park `unknownCard`.
  4. Load the account and its currency. If the payment currency differs, convert half-even to the account's decimals with `calculateRefAmount` (amount owner = account owner) and set `originalAmount`/`originalCurrencyCode`; with no rate, park `rateUnavailable`.
  5. Resolve the payee with promotion threshold 1.
  6. Pick the history category.
  7. `createTransaction` with expense, `paymentType: mobilePayment`, `rawMerchantName` (only if no payee was found), `payeeId`, `categoryId` (history or default), `applyAutomations: true`, `isPlanned` = account is connected, `externalReference`, and `externalData.cardPayment = { source, card, name, merchant, rawAmount, requestId }`.
  8. Record the outcome.
- **After commit:** if the row is non-planned with the default category and null `categorizationMeta`, `queueCategorizationJob`, then poll the row (250 ms steps, 8 s budget). Build the summary.
- **Settlement:** `findPlannedMatch` keeps its exact pass. A second pass runs only on plans with `externalData.cardPayment`: the same account, type and currency, the amount within ±25 %, the time within 5 days, closest amount first, then closest time. `mergeIntoPlanned` takes the bank amount when it differs and re-derives `refAmount`; the payment-currency `originalAmount` stays.
- **Setup code:**
  - `v1.` + base64 of the JSON `{"v":1,"url":"…","token":"…","cfAccessId":"…","cfAccessSecret":"…"}`, with the CF fields present only when set. At most 2 KB, so the QR code stays scannable.
  - `POST /user/settings/card-payments/setup-code` takes `{ ingestUrl, tokenName?, revokePrevious? }`, mints a token and returns `{ token, setupCode }` once.
- **Generic shortcut:**
  - A generator script writes a reviewable XML plist (`packages/frontend/shortcuts/log-card-payment.plist`).
  - The maintainer signs it once on macOS into `packages/frontend/public/shortcuts/moneymatter-log-card-payment.shortcut`, which nginx serves as a download. An optional iCloud link goes into the frontend config.
  - **Actions:**
    1. Text: the setup code (the import question).
    2. Base64 decode.
    3. Get Dictionary from Input.
    4. Get Dictionary Value: `url`, `token`, `cfAccessId`, `cfAccessSecret`.
    5. If Shortcut Input has no value, build `{dryRun:true}` (a manual test run). Otherwise read Amount, Merchant, Card and Name from it, and Format Date (current date, ISO 8601).
    6. Build the idempotency key text.
    7. Get Contents of URL: POST, JSON body, headers `Authorization`, `CF-Access-Client-Id`, `CF-Access-Client-Secret`.
    8. Read `response.summary`, falling back to `response.message`.
    9. Show Notification.
- **Settings → Integrations** (new section):
  - **Ingest tokens:** list, create (shown once), revoke.
  - **Apple Pay:**
    - card links and unlinked cards;
    - waiting and recent payments (retry, dismiss);
    - setup (Cloudflare Access fields on self-hosted instances only, generate the setup code, then the one-time code dialog with copy and QR, an **Add Shortcut** button, and the three-step checklist);
    - a link to the manual guide.

## Technical Details

- **Ingest request:**
  - `amount`: a number, or a string such as `"₾47.00"`, `"47,00 GEL"`, `"$1,234.56"`, `"1 234,56 €"`. Required, more than 0.
  - `currency`: optional ISO code or a currency the user has.
  - `merchant`: 1–200 chars after trim.
  - `card`: 1–100 chars.
  - `name`: optional, ≤ 200 chars.
  - `time`: optional ISO 8601 with an offset. It defaults to the receive time, may be at most 5 minutes ahead and at most 30 days back.
  - `idempotencyKey`: required, 8–128 printable chars.
  - `source`: optional `^[a-z0-9-]{1,32}$`, default `card-payment`.
  - `dryRun`: optional boolean. With `dryRun: true` every other field is optional (the shortcut run by hand has no transaction input); without `card` the summary is `Connected as <username>. <n> cards linked.`
  - Unknown keys are ignored, so newer shortcuts keep working against older servers. The JSON body limit is 8 KB.
- **Currency resolution:** an explicit `currency` wins. Otherwise a 3-letter code in the amount string. Otherwise a symbol that maps to exactly one of the user's currencies (`₾` GEL, `€` EUR, `£` GBP; `$` and `¥` only when the user has exactly one dollar or yen currency). Otherwise the mapped account's currency. A code that conflicts with the symbol is a 422.
- **Responses** (the standard `{ status, response }` envelope):
  - 200 `{ outcome: 'logged', summary, transactionId, planned, categoryPending, duplicate? }`.
  - 202 `{ outcome: 'parked', reason, summary, requestId }`.
  - 200 for a dry run: `{ outcome: 'dryRun', summary: 'Connected as <username>. Card "<card>" → <account>' | '… is not linked yet' }`.
  - 401 for a missing or invalid token, 403 for a missing scope or a read-only plan, 409 for an idempotency conflict, 422 for a rejection (`response.message`), 423 for the base-currency lock, 429 with `Retry-After`.
- **Summaries** use the user's locale and the currency's decimals:
  - `Logged 47.00 GEL at Cafe Heart of Batumi → Bar, cafe`
  - `Logged 12.50 EUR (36.71 GEL) at … → …`
  - `Noted 47.00 GEL at … → …; the bank sync will confirm it`
  - `… → categorizing…`
  - `… → Uncategorized`
  - `Not logged yet: link the card "TBC Visa" in MoneyMatter → Settings → Integrations → Apple Pay`
  - `Not logged yet: no EUR→GEL rate for 2026-10-17`
- **Rate limits:**
  - `ingestTokenRateLimit`: 30 requests per minute per token, `failClosed: false`.
  - `ingestAuthFailureRateLimit`: 20 failed authentications per 15 minutes per IP, `failClosed: true`. It counts only after a failure, so valid tokens are never throttled by it.
  - The settings writes (`setup-code`, token create) are limited to 10 per minute per user.
- **Settings API** (session auth):
  - `GET|POST /user/settings/ingest-tokens`, `DELETE /user/settings/ingest-tokens/:id`.
  - `GET|POST /user/settings/card-mappings`, `PATCH|DELETE /user/settings/card-mappings/:id`.
  - `GET /user/settings/card-payments/requests?status=parked|recent`, `POST /user/settings/card-payments/requests/:id/retry`, `DELETE /user/settings/card-payments/requests/:id` (dismiss).
  - `GET|PUT /user/settings/card-payments/access-headers` (write-only secret; GET returns `{ configured, clientIdHint }`).
  - `POST /user/settings/card-payments/setup-code`.
- **Guard classification:**
  - `POST /api/v1/ingest/card-payment` and `POST …/requests/:id/retry` carry `checkBaseCurrencyLock`.
  - These are added to `GUARD_EXEMPT_ROUTES` with a reason (credentials or a log, no monetary data):
    - token `POST`/`DELETE`;
    - mapping `POST`/`PATCH`/`DELETE`;
    - access-headers `PUT`;
    - `setup-code`;
    - request `DELETE`.
- **Migration:** one file, `migrations/20261017020000-card-payment-ingest.ts`: `ba_apikey` (the plugin's schema, checked against the plugin's `schema` export in Task 1), `CardAccountMappings`, `IngestRequests`, `IngestSettings`.
- **Retention:** a daily cron, `ingest-requests-cleanup`, deletes `logged`/`rejected`/`dismissed` rows older than 90 days. `parked` rows stay until they are resolved or dismissed.
- **Account becomes connected later:** new payments to it go in as planned rows automatically. Rows logged while it was manual stay as they are. Matching them against the bank's history is the bank-sync plan's job (see Post-Completion).

## What Goes Where

- **Implementation Steps:**
  - backend services, routes, migration and tests;
  - the frontend Settings → Integrations pages;
  - the shortcut generator, its XML and the docs.
- **Post-Completion:**
  - signing the shortcut on macOS and the optional iCloud link;
  - device verification and capture;
  - Cloudflare Access service token and policy (orchestrator, via the Cloudflare API);
  - deployment;
  - upstream.

## Implementation Steps

### Task 1: Ingest token store on better-auth's API-key plugin

**Files:**

- Modify: `packages/backend/package.json` (`@better-auth/api-key@1.6.30`, exact), `packages/backend/src/config/auth.ts`
- Create: `packages/backend/src/migrations/20261017020000-card-payment-ingest.ts` (the `ba_apikey` part; later tasks extend this file)
- Create: `packages/backend/src/services/ingest-tokens/{index,ingest-tokens.service,constants}.ts`
- Create: `packages/backend/src/middlewares/ingest-token-auth.ts`
- Modify: `packages/shared/src/types/` (new `ingest.ts`: `INGEST_SCOPES`, token DTOs)
- Create: `packages/backend/src/services/ingest-tokens/session-isolation.e2e.ts`

- [ ] spike, recorded in this plan before any code depends on it:
  - read the installed plugin's options and `schema`: the table name option, the session-from-key option and its default, the hashing default, whether `lastRequest` is updated on verify;
  - confirm that `auth.api.getSession` with an `x-api-key` or `Authorization: Bearer <key>` header returns no session;
  - ⚠️ if a key can stand in for a session and the plugin cannot turn that off, or the table cannot be named `ba_apikey`, switch to the fallback (an `IngestTokens` table with the `hashToken` helper moved from `services/mcp/auth.ts` to `common/lib/hash-token.ts`) and note it here
- [ ] write failing e2e (`session-isolation.e2e.ts`): a minted key sent as a cookie-less request to `GET /user` and `POST /transactions` gets 401; a revoked key, an expired key and a key without `ingest:transactions` are refused by the ingest middleware (exercised from Task 5's route, so these cases are marked "pass at Task 5")
- [ ] register `apiKey()` with prefix `mm_ingest_`, `modelName: 'ba_apikey'`, permissions on, plugin rate limit off, sessions from keys off; add the `ba_apikey` table to the migration with the plugin's columns and indexes (`key` unique, `userId`)
- [ ] `ingest-tokens.service.ts`: `createIngestToken({ userId, name, expiresInDays? })` returns `{ token, secret }` with the secret only here; `listIngestTokens({ userId })`; `revokeIngestToken({ userId, id })`, which is a 404 for another user's id. Each maps the plugin record to `{ id, name, start, scopes, lastUsedAt, createdAt, expiresAt }`, and `lastUsedAt` is updated at most once a minute if the plugin does not do it
- [ ] `authenticateIngestToken({ scope })` middleware (named function `authenticateIngestToken`): Bearer parse, verify with the permission, resolve the app user through `findAppUser` and the existing cache, set `req.user` and `req.ingestToken`, Sentry user, then `enforceReadOnly`. A failure is a 401 with `API_ERROR_CODES.unauthorized` and an i18n message, and it records an IP failure for the auth-failure limiter
- [ ] add `ba_apikey` to `BACKUP_EXCLUDED` with its reason
- [ ] unit tests: Bearer parsing (missing, wrong scheme, extra spaces) and the DTO mapping
- [ ] gate: `npm run test:unit -- --testPathPattern='ingest-tokens|ingest-token-auth'`; `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='ingest-tokens/session-isolation.e2e'` (the session cases pass; the ingest cases stay skipped until Task 5); typecheck and lint

### Task 2: Token management endpoints

**Files:**

- Create: `packages/backend/src/controllers/ingest-tokens.controller.ts`
- Modify: `packages/backend/src/routes/user.route.ts`, `packages/backend/src/middlewares/rate-limit.ts` (`ingestSettingsWriteRateLimit`)
- Modify: `packages/backend/src/routes/base-currency-guard-coverage.e2e.ts`
- Create: `packages/backend/src/services/ingest-tokens/ingest-tokens.e2e.ts`, `packages/backend/src/tests/helpers/ingest.ts` (exported from `helpers/index.ts`)

- [ ] write failing e2e:
  - create returns the secret once and list never contains it;
  - list is empty for a fresh user;
  - revoke removes it and is a 404 on a second revoke;
  - another user's token id is a 404;
  - a name longer than 100 chars is a 422;
  - a demo user is blocked (`blockDemoUsers`);
  - the 11th create in a minute is a 429
- [ ] routes `GET|POST /user/settings/ingest-tokens`, `DELETE /user/settings/ingest-tokens/:id` behind `authenticateSession`; zod schemas (`name` 1–100, `expiresInDays` optional 1–3650)
- [ ] guard coverage: add an `AUTH_MIDDLEWARES` set (`authenticateSession`, `authenticateIngestToken`) to the invariant; exempt the token `POST`/`DELETE` routes with the reason "credentials, no monetary data"
- [ ] i18n keys (`ingest.tokens.*` error messages) in `en` + `uk` through `i18n-editor`
- [ ] gate: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest-tokens/ingest-tokens|routes/base-currency-guard-coverage).e2e'`

### Task 3: Card mappings, ingest log and access-header storage

**Files:**

- Modify: `packages/backend/src/migrations/20261017020000-card-payment-ingest.ts`
- Create: `packages/backend/src/models/{card-account-mappings,ingest-requests,ingest-settings}.model.ts`
- Create: `packages/backend/src/services/ingest/{normalize-card-label,card-mappings.service,access-headers.service}.ts`, `normalize-card-label.unit.ts`
- Create: `packages/backend/src/controllers/card-mappings.controller.ts`, `packages/backend/src/services/ingest/card-mappings.e2e.ts`
- Modify: `packages/backend/src/routes/user.route.ts`, `services/backup/registry.ts`, `routes/base-currency-guard-coverage.e2e.ts`

- [ ] failing unit tests for `normalizeCardLabel` (trim, collapse whitespace, case-fold, Unicode NFC, strip a trailing "•••• 1234" if Wallet ever adds it)
- [ ] failing e2e:
  - mapping CRUD (create, list empty and filled, rename the label, change the account, delete);
  - a duplicate normalized label is a 409;
  - an account the user does not own, an archived account, or a loan/vehicle account (`isDedicatedFlowAccountCategory`) is a 422;
  - deleting the account removes its mappings;
  - access headers: PUT stores them, GET returns `{ configured: true, clientIdHint: '…a1b2' }` and never the secret, PUT with `null`s clears them
- [ ] migration: the three tables, FKs (`userId` cascade, `accountId` cascade, `transactionId` set null), unique indexes; models with object-param statics
- [ ] services and routes `GET|POST /user/settings/card-mappings`, `PATCH|DELETE /user/settings/card-mappings/:id`, `GET|PUT /user/settings/card-payments/access-headers` (encrypted with `encryptToken`)
- [ ] backup registry: `CardAccountMappings` in `BACKUP_TABLES` (restore remaps `accountId`), `IngestRequests` and `IngestSettings` in `BACKUP_EXCLUDED` with reasons; a mapping round-trips through export and restore
- [ ] guard coverage: exempt the mapping and access-header writes with reasons
- [ ] gate: `npm run test:unit -- --testPathPattern='normalize-card-label'`; `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest/card-mappings|routes/base-currency-guard-coverage|backup/restore-backup).e2e'`

### Task 4: Payload parsing and summaries

**Files:**

- Create: `packages/backend/src/services/ingest/card-payment/{parse-amount,resolve-currency,parse-payload,fingerprint,format-summary}.ts` with a `.unit.ts` each

- [ ] failing unit tests:
  - `parseAmount`:
    - `47`, `"47"`, `"47.00"`, `"47,00"`, `"1,234.56"`, `"1.234,56"`, `"1 234,56"` (NBSP and narrow NBSP), `"₾47.00"`, `"47.00 GEL"`, `"GEL 47"`, `"-47"` (`negative`), `"0"`/`"0.00"` (`zero`), `""` and `"abc"` (`invalid`);
    - an ambiguous `"1,234"` reads as thousands only with exactly 3 digits after the separator and no other separator; otherwise decimal; this rule is documented in the code
  - `resolveCurrency`: explicit wins; a code in the text; a unique symbol among the user's currencies; an ambiguous `$` with two dollar currencies falls back to the account currency; a code vs symbol conflict is an error
  - `parsePayload`: field limits, the time window (5 min ahead, 30 days back, default now), the `source` pattern, unknown keys ignored
  - `fingerprint`: stable over key order and whitespace, changes with amount, currency, merchant, card or time
  - `formatSummary`: every summary in Technical Details, using the currency's decimals and the user's locale
- [ ] implement them as pure functions; currency decimals come in as a parameter, so the units need no DB
- [ ] gate: `npm run test:unit -- --testPathPattern='ingest/card-payment'`

### Task 5: Ingest endpoint: auth, validation, rate limits, idempotency, parking and dry run

**Files:**

- Create: `packages/backend/src/routes/ingest.route.ts`, `packages/backend/src/controllers/ingest/card-payment.controller.ts`
- Create: `packages/backend/src/services/ingest/card-payment/{ingest-card-payment,record-request}.ts`
- Modify: `packages/backend/src/setup-routes.ts` (mount `${API_PREFIX}/ingest`), `packages/backend/src/middlewares/rate-limit.ts`
- Create: `packages/backend/src/services/ingest/card-payment/ingest-card-payment.e2e.ts`
- Modify: `packages/backend/src/routes/base-currency-guard-coverage.e2e.ts`, `services/ingest-tokens/session-isolation.e2e.ts` (un-skip)

- [ ] write failing e2e (a token and a mapping created through helpers, requests sent without cookies):
  - happy path: a mapped card in the account's currency → 200 `logged`, then `GET /transactions` shows an expense with the amount, `externalReference` `apple-pay:<key>`, `externalData.cardPayment` and the summary text;
  - empty state: a dry run with no mappings → 200 `dryRun` "… is not linked yet", and nothing is written;
  - unknown card → 202 `parked`/`unknownCard`, and nothing is in `GET /transactions`;
  - the same key and body twice → one transaction, the second answer has `duplicate: true`; the same key with another amount → 409;
  - zero amount, blank merchant, negative amount → 422, recorded as `rejected`;
  - missing token 401, bad token 401, revoked token 401, a token without the scope 403, a read-only plan 403;
  - the base-currency lock → 423;
  - the 31st request in a minute → 429 with `Retry-After`;
  - 21 bad-token attempts from one IP → 429
- [ ] route `POST /api/v1/ingest/card-payment`: `express.json({ limit: '8kb' })`, then `authenticateIngestToken({ scope: 'ingest:transactions' })`, `checkBaseCurrencyLock`, `ingestTokenRateLimit`, then the controller (`ingestAuthFailureRateLimit` runs inside the auth middleware's failure path)
- [ ] `ingestCardPayment` up to and including the parking decision:
  1. a dry run (`dryRun: true`, or no `idempotencyKey` with `dryRun`) only parses and looks up the mapping, then answers; it writes nothing, not even a request row;
  2. otherwise record or upsert the request by `(userId, idempotencyKey)` inside `withTransaction`;
  3. replay or 409;
  4. parse (422 → `rejected`);
  5. look up the mapping (none → `parked`/`unknownCard`)
- [ ] guard coverage: the ingest route carries the guard (the invariant passes without an exemption); a sanity case asserts the ingest route is discovered with `authenticateIngestToken`
- [ ] un-skip the Task 1 ingest-auth cases
- [ ] i18n `ingest.*` messages in `en` + `uk`
- [ ] gate: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest/card-payment/ingest-card-payment|ingest-tokens/session-isolation|routes/base-currency-guard-coverage).e2e'`

### Task 6: Processing: payee, category, currency, planned rows

**Files:**

- Modify: `packages/backend/src/services/payees/extraction.service.ts`, `resolve-payee-for-incoming-row.ts` (optional `promotionThreshold`)
- Create: `packages/backend/src/services/ingest/card-payment/{pick-history-category,convert-to-account-currency,process-card-payment}.ts`
- Modify: `packages/backend/src/services/ingest/card-payment/ingest-card-payment.ts`
- Create: `packages/backend/src/services/ingest/card-payment/processing.e2e.ts`

- [ ] write failing e2e:
  - **payee:**
    - a first-seen merchant creates a payee and an alias, and the logo resolution is enqueued (the brand-logo mock records it);
    - a known alias links the existing payee;
    - an ignored name links none;
    - an existing payee's `promotionThreshold` stays unchanged for bank sync (a regression case in the existing `payees.e2e`)
  - **category:**
    - an `enforce` payee default wins over history;
    - a `hint` payee default wins over history;
    - with no default, the most frequent past category wins (ties: most recent);
    - planned rows and the default category are ignored in the count;
    - with no history, the default category and `categoryPending` are returned (AI is covered in Task 7);
    - a user automation that sets a category wins over all of them
  - **currency:**
    - a USD payment on a GEL account stores `amount` in GEL (half-even, GEL decimals) with `originalAmount` 12.50 USD and `originalCurrencyCode` USD, and the summary shows both;
    - a missing rate (exchange-rate mock returns nothing) → 202 `parked`/`rateUnavailable`;
    - a custom-currency account with no rate → parked
  - **connected account:** a mapping to a bank-connected account creates a planned row (`isPlanned: true`, not in the balance) and the summary says the bank will confirm it
  - **time:** the stored `time` equals the sent ISO time
- [ ] `resolvePayeeForRawMerchant({ userId, rawMerchantName, promotionThreshold? })`: the parameter overrides the user setting only when given; every existing caller passes nothing
- [ ] `pickHistoryCategory({ ownerUserId, payeeId })`: one aggregate over the owner's non-planned, non-transfer rows from the last 12 months, excluding the default category; the most frequent wins, ties go to the latest
- [ ] `convertToAccountCurrency({ ownerUserId, amount, from, to, date })`: `calculateRefAmount`, then `roundToCurrency` half-even to the account's decimals; `ExchangeRateUnavailableError` or `null` → `{ parked: 'rateUnavailable' }`
- [ ] `processCardPayment`: the mapping's account (owned, still active), then the conversion, the payee, the history category and `createTransaction` with the parameters from Solution Overview; the outcome is written to the request row
- [ ] gate: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest/card-payment/(processing|ingest-card-payment)|payees/payees|transactions/original-currency-metadata).e2e'`

### Task 7: AI categorization with a bounded wait

**Files:**

- Create: `packages/backend/src/services/ingest/card-payment/categorize-after-commit.ts`
- Modify: `packages/backend/src/services/ingest/card-payment/ingest-card-payment.ts`
- Create: `packages/backend/src/services/ingest/card-payment/ai-categorization.e2e.ts`

- [ ] write failing e2e with the existing AI test environment (`tests/helpers/ai-test-env.ts` / `ai-categorization.ts`):
  - an AI answer within the budget → the summary names the AI's category and `categoryPending: false`;
  - an AI that answers after the budget → "categorizing…", and the row is categorized later (poll the transaction);
  - no AI configured → `categoryPending: false`, "Uncategorized", no job queued;
  - a payee or history category → no job queued;
  - a planned row → no job queued (AI skips planned rows)
- [ ] after commit: when the row is non-planned, has the default category and null `categorizationMeta`, and an AI client resolves for `AI_FEATURE.categorization`, call `queueCategorizationJob({ userId: owner, transactionIds: [id], scope: anyCategory, trigger: sync })`, then poll the row until `categorizationMeta` is set or 8 s pass (the budget is a constant, overridable in tests)
- [ ] gate: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='ingest/card-payment/ai-categorization.e2e'`

### Task 8: Waiting payments: list, retry, dismiss, retention

**Files:**

- Create: `packages/backend/src/controllers/card-payment-requests.controller.ts`, `packages/backend/src/services/ingest/card-payment/{list-requests,retry-request}.ts`
- Create: `packages/backend/src/crons/ingest-requests-cleanup.ts` (+ registration where the other crons register)
- Modify: `packages/backend/src/routes/user.route.ts`, `routes/base-currency-guard-coverage.e2e.ts`
- Create: `packages/backend/src/services/ingest/card-payment/requests.e2e.ts`, `packages/backend/src/crons/ingest-requests-cleanup.e2e.ts`

- [ ] write failing e2e:
  - empty list;
  - a parked `unknownCard` request is listed; after the card is linked, retry → 200 `logged` and the transaction exists;
  - a retry while still unlinked stays parked;
  - a retry of a `logged` request is a 409;
  - dismiss → status `dismissed`, then a second dismiss is a 404;
  - `GET ?status=recent` returns the last 50 of every status, newest first, with summary, card, merchant, amount text and time;
  - `GET /user/settings/card-mappings/unlinked` returns the distinct parked card labels with counts;
  - the cleanup cron deletes `logged`/`rejected`/`dismissed` rows older than 90 days and keeps `parked` rows
- [ ] routes `GET /user/settings/card-payments/requests`, `POST …/requests/:id/retry` (guarded), `DELETE …/requests/:id` (exempt); `GET /user/settings/card-mappings/unlinked`
- [ ] retry runs `processCardPayment` on the stored payload under the request's user, never a client-sent body
- [ ] gate: `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest/card-payment/requests|crons/ingest-requests-cleanup|routes/base-currency-guard-coverage).e2e'`

### Task 9: Bank-sync settlement of card-payment plans

**Files:**

- Modify: `packages/backend/src/services/transactions/planned-matching/{find-planned-match,merge-into-planned,index}.ts`
- Create: `packages/backend/src/services/transactions/planned-matching/card-payment-tolerance.ts` + `.unit.ts`
- Create: `packages/backend/src/services/transactions/planned-matching/merge-card-payment.e2e.ts`

- [ ] failing unit tests for `isWithinCardPaymentTolerance({ planned, incoming })`: ±25 % of the plan amount, 5-day window, the same currency; boundary cases
- [ ] failing e2e through a provider mock (Monobank or EnableBanking, whichever helper syncs a single booked row most directly):
  - an exact amount merges as today;
  - a 47.00 plan and a 52.00 booking (tip) merge, the row's amount becomes 52.00, `refAmount` is re-derived, `originalAmount` stays, the payee and category stay;
  - a 47.00 plan and a 70.00 booking do not merge (two rows);
  - a user-made plan (no `cardPayment`) still needs the exact amount;
  - of two card-payment plans, the closer amount wins
- [ ] `findPlannedMatch`: keep the exact query, then the tolerance query restricted to `externalData ? 'cardPayment'`, ordered by amount distance, then time distance; same lock and `SKIP LOCKED`
- [ ] `mergeIntoPlanned`: an optional `amount` override applied with the planned → real transition on the same instance; `refAmount` comes from the merged amount
- [ ] gate: `npm run test:unit -- --testPathPattern='card-payment-tolerance'`; `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='transactions/planned-matching/(merge-card-payment|merge-on-sync|merge-on-import).e2e'`

### Task 10: Setup code

**Files:**

- Create: `packages/shared/src/lib/card-payment-setup-code.ts` (encoder/decoder, shared so the backend and the shortcut generator tests use one definition) + its unit test in `packages/backend/src/services/ingest/setup-code.unit.ts`
- Create: `packages/backend/src/controllers/card-payment-setup-code.controller.ts`, `packages/backend/src/services/ingest/create-setup-code.ts`
- Create: `packages/backend/src/services/ingest/setup-code.e2e.ts`
- Modify: `packages/backend/src/routes/user.route.ts`, `routes/base-currency-guard-coverage.e2e.ts`

- [ ] failing unit tests:
  - `encodeSetupCode`/`decodeSetupCode` round trip with and without the CF fields;
  - the output is standard base64 (no `-`/`_`) prefixed `v1.`;
  - `v` is checked: an unknown version, a bad prefix, bad JSON, a missing `url`/`token` and an input over 2 KB are rejected;
  - a non-http(s) `url` is rejected
- [ ] failing e2e for `POST /user/settings/card-payments/setup-code`:
  - it returns `{ token, setupCode }`; the decoded code has the sent `ingestUrl`, the new secret, and the CF id and secret when stored;
  - with `revokePrevious` (default true) the earlier Apple Pay token stops working;
  - the token list shows the new token without a secret;
  - a second call mints another token, so nothing re-reveals the first;
  - an invalid `ingestUrl` is a 422;
  - the 11th call in a minute is a 429;
  - a demo user is blocked
- [ ] the service marks setup-code tokens (plugin `metadata: { purpose: 'card-payment-setup' }`) so `revokePrevious` targets only those
- [ ] guard coverage: exempt with the reason "mints a credential, no monetary data"
- [ ] gate: `npm run test:unit -- --testPathPattern='ingest/setup-code'`; `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest/setup-code|routes/base-currency-guard-coverage).e2e'`

### Task 11: The generic shortcut: generator, reviewable plist, served asset

**Files:**

- Create: `packages/frontend/scripts/shortcuts/build-card-payment-shortcut.ts` (uses the `plist` package as a dev dependency)
- Create: `packages/frontend/shortcuts/log-card-payment.plist` (generated XML, committed for review)
- Create: `packages/frontend/scripts/shortcuts/build-card-payment-shortcut.spec.ts`
- Create: `packages/frontend/public/shortcuts/README.md` (how the signed file is made and verified)
- Modify: `packages/frontend/nginx.conf` (`location /shortcuts/`: `application/octet-stream`, `Content-Disposition: attachment`, short cache), `packages/frontend/package.json` (`shortcuts:build` script), `packages/frontend/src/common/config.ts` (`cardPaymentShortcutIcloudUrl`, optional, from `VITE_CARD_PAYMENT_SHORTCUT_ICLOUD_URL`, and the CI wiring per CLAUDE.md rule 9)

- [ ] ⚠️ capture the identifiers the generator cannot guess:
  - the Wallet transaction input class for `WFWorkflowInputContentItemClasses`;
  - the property names for Amount, Merchant, Card or Pass and Name.
  - How: build a minimal shortcut by hand on the iPhone (Receive Transaction input → a Dictionary of those four properties), share it as an iCloud link, read the unsigned plist through the iCloud shortcut record (a known community technique; verify), convert it with `plutil -convert xml1`, and keep the extract as a fixture: `packages/frontend/scripts/shortcuts/fixtures/transaction-input.xml`.
  - If this is not feasible, build the full shortcut by hand from the manual guide (Task 13), export and sign it, commit its decoded XML in place of the generated one, and mark the generator task ➕ follow-up.
- [ ] failing vitest:
  - the generated plist has exactly one import question bound to the first Text action's `WFTextActionText`;
  - the actions appear in the order from Solution Overview;
  - the body keys equal the server's schema keys (imported from `shared`);
  - the headers include `Authorization`, `CF-Access-Client-Id` and `CF-Access-Client-Secret`;
  - the decode chain reads `url`, `token`, `cfAccessId` and `cfAccessSecret`, the keys of `encodeSetupCode` (round-tripped through the shared encoder);
  - the no-input branch sends `dryRun: true`;
  - drift: the committed XML equals the generator output
- [ ] implement the generator: a deterministic UUID per action (seeded), so the XML is stable and diffable
- [ ] gate: `cd packages/frontend && npm run test:unit -- --run scripts/shortcuts/build-card-payment-shortcut.spec.ts`; `npm run shortcuts:build` leaves no diff; typecheck and lint
- [ ] the signed `.shortcut` and the iCloud link are made in Post-Completion; until then the **Add Shortcut** button (Task 13) hides itself when the file is absent (a HEAD probe) and the page points to the manual guide

### Task 12: Frontend: Settings → Integrations → Ingest tokens

**Files:**

- Create: `packages/frontend/src/api/ingest.ts`, `packages/frontend/src/pages/settings/subpages/integrations/{index.vue,pages/ingest-tokens.vue,components/create-token-dialog.vue}`
- Modify: `packages/frontend/src/routes/{index,constants}.ts`, `packages/frontend/src/pages/settings/settings.vue`, `packages/frontend/src/common/const/vue-query.ts`
- Create: vitest specs next to the components; `packages/frontend/e2e/tests/integrations/ingest-tokens.spec.ts`

- [ ] failing vitest:
  - the create dialog shows the secret once, with a copy button and a "you won't see it again" note;
  - closing the dialog clears the secret from state and from the vue-query cache;
  - the list renders name, `start…`, scope, last used ("Never" when null) and created;
  - revoke asks for confirmation
- [ ] **Integrations** settings group with **Ingest tokens** and **Apple Pay** tabs (container-query layout, Settings conventions from `frontend-rules`)
- [ ] i18n `settings.integrations.*` in `en` + `uk` through `i18n-editor`
- [ ] Playwright: create a token, see it once, reload, see it masked, revoke it (typechecked; run if the docker dev stack is up)
- [ ] gate: `cd packages/frontend && npm run test:unit -- --run src/pages/settings/subpages/integrations`; frontend typecheck and lint

### Task 13: Frontend: Apple Pay page with one-tap setup

**Files:**

- Create: `packages/frontend/src/pages/settings/subpages/integrations/pages/apple-pay.vue` and components: `card-links.vue`, `unlinked-cards.vue`, `waiting-payments.vue`, `setup-code-dialog.vue`, `access-headers-form.vue`, `setup-checklist.vue`
- Create: `packages/frontend/src/pages/settings/subpages/integrations/ingest-url.ts` (+ spec)
- Modify: `packages/frontend/package.json` (a QR library such as `qrcode@1.5.4` or a smaller equivalent, pinned)
- Create: vitest specs; `packages/frontend/e2e/tests/integrations/apple-pay.spec.ts`

- [ ] failing vitest:
  - `buildIngestUrl()` returns `${API_HTTP || window.location.origin}/api/v1/ingest/card-payment`;
  - card links: add (account picker limited to owned, active, non-loan/vehicle accounts), rename, re-point, delete;
  - unlinked cards show counts and a **Link** action that pre-fills the label and, after saving, offers **Log N waiting payments** (it calls retry per request);
  - waiting payments: retry and dismiss;
  - setup:
    - the access-header fields render only when `config.isSelfHost`;
    - the secret field is write-only (a placeholder when configured, **Remove** clears it);
    - **Generate setup code** calls the endpoint and opens a one-time dialog with the code, a copy button and a QR code;
    - closing the dialog drops the code;
    - **Add Shortcut** links the signed file (or the iCloud link when configured, preferred on iOS);
    - the checklist shows three steps: create a Transaction automation in Shortcuts → Automation; choose your cards and **Run Immediately**; select "MoneyMatter: log card payment";
    - a **Test** hint explains that running the shortcut by hand sends a dry run
- [ ] link to the docs page (Task 15) for the manual guide
- [ ] i18n `settings.integrations.applePay.*` in `en` + `uk`; ask the owner for copy only where the wording is non-obvious
- [ ] Playwright: link a card, generate a setup code, see the QR and copy it, close the dialog and confirm the code is gone (typechecked; run if the docker dev stack is up)
- [ ] gate: `cd packages/frontend && npm run test:unit -- --run src/pages/settings/subpages/integrations`; frontend typecheck and lint

### Task 14: Verify acceptance criteria

- [ ] a full ingest round trip through HTTP: a token from a setup code (decoded with the shared decoder), a mapped card, a cross-currency payment logged with the right summary, the same key replayed, a parked unknown card logged after linking, and a planned row on a connected account settled by a synced booking at a different amount
- [ ] no route authenticated by a token reaches a session route, and the guard invariant covers the ingest route
- [ ] backups: a mapping round-trips; tokens, the log and the access headers are not in an export
- [ ] backend: `npm run test:unit` (full); `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest|ingest-tokens|planned-matching|payees|ai-categorization|backup|routes/base-currency-guard-coverage)'`
- [ ] frontend: `npm run typecheck && npm run lint && npm run test:unit -- --run`; Playwright `integrations/` when the dev stack is up
- [ ] root `npm run format:check` and `npm run knip`

### Task 15: [Final] Update documentation

- [ ] `packages/docs/src/content/docs/integrations/apple-pay.mdx` (new section `integrations`, sidebar group in `astro.config.mjs`), following the `user-docs` skill:
  - **One-tap setup:** Settings → Integrations → Apple Pay; link your cards; generate the setup code; **Add Shortcut** and paste the code at import (or scan the QR on another phone and copy it); then the three automation steps with exact iOS labels (Shortcuts → Automation → **+** → **Transaction** → choose cards → **Run Immediately** → **Next** → pick "MoneyMatter: log card payment").
  - **Manual guide (fallback):** every action in order with its exact name: Dictionary of Amount, Merchant, Card or Pass, Name from Shortcut Input; Format Date (ISO 8601); Text for the idempotency key; Get Contents of URL with **Method** POST, **Headers** `Authorization: Bearer <token>` (plus `CF-Access-Client-Id`/`CF-Access-Client-Secret` behind Cloudflare Access), **Request Body** JSON with each key mapped to its variable; Get Dictionary Value `response` → `summary`; Show Notification.
  - **Test request:** a `curl` with `dryRun: true`, then a real one, and the expected responses.
  - **What happens to a payment:** card links, waiting payments and why, categories in order, foreign currencies, bank-connected accounts (planned until the bank confirms).
  - **Troubleshooting:** a 401 (token), a 403 from Cloudflare (service token or policy), an empty amount from iOS, a renamed card.
  - **iCloud link:** say plainly that a shareable link cannot be generated by the app; the maintainer makes it once.
  - screenshots per the skill (the integrations pages with the docs test user), both themes
- [ ] `packages/docs/src/content/docs/integrations/ingest-tokens.mdx`: what a token can do (only `ingest:transactions`), shown once, revoke, last used
- [ ] `packages/backend/docs/card-payment-ingest.md`: the API reference (request, currency resolution, responses, idempotency, parking, settlement), for other clients
- [ ] `self-hosting/docs/environment-reference.md` and `getting-started/self-hosting.mdx`: `VITE_CARD_PAYMENT_SHORTCUT_ICLOUD_URL`; a note on reverse proxies with access control (path-scoped service auth for `/api/v1/ingest/`)
- [ ] `cd packages/docs && npm run build`; the link validator passes
- [ ] move this plan to `docs/plans/completed/` after Task 14 passes

## Post-Completion

_Items requiring manual work or external systems; no checkboxes._

**Sign the shortcut (orchestrator, on the owner's Mac):**

- Check that `shortcuts sign` works on the generated file: `shortcuts sign --mode anyone --input packages/frontend/shortcuts/log-card-payment.plist --output packages/frontend/public/shortcuts/moneymatter-log-card-payment.shortcut`. Convert to a binary plist first if the CLI refuses XML. Signing for "anyone" needs the Mac signed in to an Apple ID; check what identity the signature exposes before committing it to a public repo.
- AirDrop the file to the iPhone, import it, paste a setup code from the dev or ritchie instance at the import question, and run it once by hand: the notification shows the dry-run line.
- Optional: share the imported shortcut from the iPhone to get an iCloud link; set `VITE_CARD_PAYMENT_SHORTCUT_ICLOUD_URL` for the owner's instance. An iCloud link still asks the import question, so the setup code works the same way.
- If signing the generated plist fails, follow Task 11's fallback (build by hand, export, sign) and record which path shipped.

**Device verification (owner, with the orchestrator):**

- Create the automation and make one real Apple Pay payment. Read the stored `externalData.cardPayment.rawAmount` in the waiting/recent list to confirm how iOS formats Amount and Card, and add that string to `parse-amount.unit.ts` as a fixture.
- Confirm the Card value matches the Wallet card name used in the link. Check the no-input dry run and a parked unknown card.

**Cloudflare Access for `money.nemirovsky.dev` (orchestrator, Cloudflare API):**

- Create a service token named `moneymatter-card-payment-shortcut` (`POST /accounts/{account_id}/access/service_tokens`); keep the client id and secret for the Settings form, never in the repo.
- Create a self-hosted Access application for the path `money.nemirovsky.dev/api/v1/ingest/card-payment` only, with one policy whose action is **Service Auth** (`non_identity`) and whose include rule is that service token. The more specific path application takes precedence over the site-wide one, so the rest of the site keeps its normal login.
- Verify: a request without the headers gets 403 from Cloudflare; with them, it reaches the app and gets 401 without a MoneyMatter token. The app's own token stays required.
- Enter the client id and secret in Settings → Integrations → Apple Pay, then generate the setup code.

**Deployment on the owner's instance:**

- Build images from this branch, back up the database, migrate, and set the iCloud link variable if one exists.

**Bank-sync plan (TBC, separate):**

- When the TBC account becomes connected, new card payments are planned rows that its sync settles (Task 9). Payments logged while the account was manual are real rows; that plan decides how its historical backfill matches them (for example by `externalData.cardPayment` + amount + date) instead of duplicating them.

**Upstream:**

- Open a discussion with the maintainer about personal API tokens (the API-key plugin), the generic ingest endpoint and the shortcut asset, and whether it is a paid-plan feature on the cloud. Sign the CLA (`CLA.md`).
- Offer it as PRs in order: tokens + endpoint + processing (Tasks 1–10); the shortcut asset and the Settings UI (Tasks 11–13); docs.
