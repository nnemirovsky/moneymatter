# Card-payment ingest from an iOS Shortcut (Apple Pay)

## Overview

Every Apple Pay payment should land in MoneyMatter by itself, within seconds, without the owner typing anything. iOS Shortcuts has a Wallet **Transaction** personal automation ("when I tap any of these cards", "Run Immediately") that hands the payment to a shortcut. The shortcut POSTs it as JSON to MoneyMatter. MoneyMatter maps the card to an account, finds or creates the payee, picks a category, converts the currency when needed, stores the row and answers with one line the shortcut shows as a notification:

> Logged 47.00 GEL at Cafe Heart of Batumi → Bar, cafe

The plan delivers:

1. **Personal ingest tokens:** per user, hashed at rest in the app's own `IngestTokens` table, shown once, named, scoped (`ingest:transactions`), with a last-used time, revocable from Settings and revoked by a password reset.
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
  - **better-auth is mocked in Jest.** `jest.config.base.ts` maps `better-auth`, `better-auth/node`, `better-auth/plugins`, `@better-auth/oauth-provider` and `@better-auth/passkey` to hand-written CommonJS mocks in `src/tests/mocks/better-auth/` (the real packages are ESM-only). The mock `betterAuth()` ignores `plugins`, exposes only `api.getSession` (the `bt_auth.session_token` cookie), `signInEmail` and `setPassword`, routes a few `/auth/*` paths by hand, and never runs `onPasswordReset`.
  - **Every `/api/v1/auth/*` request goes to the better-auth handler** (`setup-routes.ts`, `app.all(\`${API_PREFIX}/auth/\*\`)`), so any plugin registered there exposes its own HTTP endpoints.
  - **`onPasswordReset`** (`config/auth.ts`) deletes `ba_session`, `ba_oauth_access_token` and `ba_oauth_refresh_token` rows through the auth `pool` and bumps the session cookie-cache version, so a reset kills every credential.
  - **Read-only plans:** `enforceReadOnly` (`middlewares/entitlements.ts`) answers write requests from a read-only user with **402** `API_ERROR_CODES.planRequired`.
- **Rate limiting:** `middlewares/rate-limit.ts` (`createRateLimit`, Redis-backed `RateLimitService`, per-user or per-IP keys, `failClosed`). A `createRateLimit` middleware checks and increments on every call, then sends 429 or calls `next()`; `RateLimitService.getRateLimitStatus(key)` reads a count without incrementing.
- **Body parsing:** `setup-middleware.ts` runs `express.json()` (100 KB default) on every non-auth path before `setupRoutes`, with per-path limits in its `largePaths` map. A route-level `express.json()` never runs again on an already parsed body.
- **Base-currency guard:** `middlewares/check-base-currency-lock.ts` reads `req.user`. `routes/base-currency-guard-coverage.e2e.ts` walks the Express stack and requires `checkBaseCurrencyLock` on every **`authenticateSession`** mutating route, or an entry in `GUARD_EXEMPT_ROUTES`. A route authenticated by any other middleware is invisible to it today.
- **Transactions:** `services/transactions/create-transaction.ts` (`createTransaction`, `withTransaction`-wrapped). `withTransaction` (`services/common/with-transaction.ts`) joins an active transaction and otherwise opens a plain `sequelize.transaction`, so any throw rolls back every write made inside it.
  - Takes `rawMerchantName` (payee extraction), `payeeId`, `categoryId`, `tagIds`, `applyAutomations` (stamps `externalData.applyAutomations`, makes the row automation-eligible), `isPlanned`, `originalAmount`/`originalCurrencyCode`, `externalReference` (`varchar(255)`, no index) and `externalData` (JSONB).
  - Rounds every entered figure through `roundTransactionMoney`, computes `refAmount` with `calculateRefAmountOrNull` (which throws `ExchangeRateUnavailableError` for an ISO pair with no rate), then runs subscription matching, user automations, `applyPayeeCategorization`, payee default tags and location.
  - **User automations skip planned rows:** `isAutomationEligible` (`services/transaction-automations/eligibility.ts`) returns false for `isPlanned` (⚠️ review round 1: except a plan the card-payment ingest wrote, `externalData.cardPayment`; the history scan, `buildEligibilityWhere` with `planned: 'include'`, admits those plans too, so preview and apply-to-history agree with the write path). An automation that sets a category also sets `categorizationMeta`.
  - **A non-planned manual row on a bank-connected account is rejected** (`resolveAccountTypeForManualWrite`, `transactions.manualOnConnectedAccount`). Only planned rows may sit there.
  - The HTTP schema requires `categoryId` for non-transfers; providers pass the user's default category (`getUserDefaultCategory`, `Users.defaultCategoryId`) as "uncategorized".
- **Pending:** there is **no `isPending` column**. The serializer derives `isPending` from the EnableBanking raw status (`isPreBookingStatus(getRawTransactionStatus(externalData))`, `bank-data-providers/enablebanking/utils/transaction-metadata.ts`), so it exists only for rows that provider wrote.
- **Bank-sync settlement:** every provider (EnableBanking, Monobank, SimpleFIN, LunchFlow, Walutomat) and the statement import pass `matchPlanned` to `createTransaction`. `tryMergeIntoPlanned` → `findPlannedMatch` (`services/transactions/planned-matching/`) locks a planned row on the same account with the **exact** amount, currency and type within `PLANNED_MATCH_WINDOW_DAYS` (7), and `mergeIntoPlanned` turns it into the real row in place: it keeps the plan's amount, category and payee, joins the notes, takes the bank's time, `originalId` and `externalData` (replacing the plan's), and flips `isPlanned`. Planned rows need the account owner and a positive amount (`assert-planned-invariants.ts`).
  - `createTransaction` returns right after a merge (`mergedIntoPlanned: true`), so no automation runs on the merged row, and every provider keeps merged ids out of the `TRANSACTIONS_SYNCED` ids, so AI never sees them either.
  - The CSV, OFX, MS Money, Budget Bakers Wallet and statement imports pass `matchPlanned` too. EnableBanking passes it for pre-booking (PDNG) payloads as well (`enablebanking.provider.ts`), and its pending→booked upgrade needs the exact amount.
- **Payees:** `Payees.defaultCategoryId` + `categorizationMode` (`enforce` | `hint` | `off`, `shared/src/types/payees.ts`) **is** the payee default-category concept.
  - `resolvePayeeForRawMerchant` (`services/payees/extraction.service.ts`): exact name/alias match → ignored-names gate → fuzzy match (adds an alias) → **occurrence promotion** only when prior unmatched rows + 1 reach the user's `payeePromotionThreshold` (default 2), then `enqueueLogoResolutionAfterCommit` (logo.dev). A first-seen merchant therefore gets **no** payee today.
  - `resolvePayeeForIncomingRow` wraps it in a savepoint; `normalizePayeeName` normalizes; `resolveNormalizedName` (`payee-namespace.ts`) is the read-only exact name/alias lookup.
- **AI categorization:** `services/ai-categorization/`. `queueCategorizationJob` (BullMQ) → `categorizeTransactions`, which resolves the user's AI client per feature (`createAIClient`, including the Claude Code/Codex CLI connections from the CLI-providers plan) and selects candidates with `categorizationMeta IS NULL`, non-transfer and **non-planned** rows. Only `TRANSACTIONS_SYNCED` (bank providers) auto-queues it. A `hint` payee leaves `categorizationMeta` null on purpose so AI may still override its category (`apply-categorization.ts`, `categorization-scope.ts`); that is what the `anyCategory` scope is for.
- **Currency conversion:** `calculateRefAmount({ userId, amountOwnerUserId, amount, baseCode, quoteCode, date })` converts between any two codes. `calculateRefAmountOrNull` returns `null` only for custom currencies; an ISO pair with no rate throws `ExchangeRateUnavailableError`. Converted values round half-even (CLAUDE.md rule 6).
- **Secrets at rest:** `common/utils/encryption.ts` (`encryptToken`/`decryptToken`, AES-256-GCM).
- **Backups:** `services/backup/registry.ts` (`BACKUP_TABLES`, `BACKUP_EXCLUDED`); every Sequelize model has to be in one of them (`registry.unit.ts` is the drift guard). Entries are `{ model, reason }` and the module throws at import on an undefined model, so the `ba_*` tables (no models, read through the auth pool) sit outside the registry.
- **Frontend:** Settings tabs in `pages/settings/settings.vue`, routes in `routes/index.ts` / `routes/constants.ts`. There is no Integrations section and no QR-code library. `getMcpServerUrl` (`api/mcp.ts`) shows how an absolute API URL is built (`API_HTTP || window.location.origin`); `config.isSelfHost` exists. Static files live in `packages/frontend/public/`, served by `packages/frontend/nginx.conf`, which also proxies `/api/`.
  - **Per-instance config is runtime, not build time:** `src/common/config.ts` reads `window.__APP_CONFIG__` (written by `self-hosting/frontend/docker-entrypoint.sh` at container start) and falls back to `import.meta.env` only in dev, as `mcpBaseUrl` and `docsUrl` do. Hosted and self-hosted instances share one image.
  - Vitest `include` is `src/**/?(*.)+(spec|test).[jt]s?(x)` (`vite.config.js`), and `tsconfig.json` covers only `src/**` and `tests/**`.
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

- **Tokens live in the app's own `IngestTokens` table, not in better-auth's API-key plugin and not in the MCP OAuth tokens.**
  - OAuth access tokens expire after 72 h and renew only through a refresh-token exchange, and the grant needs an interactive consent. A Shortcut can do neither.
  - The API-key plugin was the first choice and is dropped:
    - better-auth is a hand-written mock in Jest (see Context), so the plugin would never run in e2e: its calls would be undefined, and every token gate would test the mock instead of the code that ships;
    - registering it exposes its own `/api/v1/auth/api-key/*` endpoints through the auth catch-all, where any session holder could mint keys around the app's demo block, rate limit, bounds and server-set permissions;
    - its owner column is the better-auth user id (`referenceId`) and its tables are renamed through `schema`, both easy to get wrong in a hand-written migration that no test would catch.
  - The own table is small: `IngestTokens` with a SHA-256 hash (`hashToken`, moved from `services/mcp/auth.ts` to `common/lib/hash-token.ts` and shared), a display prefix, scopes, purpose, expiry and last-used time, keyed by the app's `Users.id`. Every path runs for real in e2e.
  - From the MCP code it reuses the Bearer handling, the cached app-user lookup and the Connected-apps revoke pattern, and from the attachment-token middleware the `req.user` + `enforceReadOnly` shape.
  - A token is only ever read by `authenticateIngestToken`; nothing registers it with better-auth, so it cannot stand in for a session by construction.
  - `onPasswordReset` deletes the user's ingest tokens with the other credentials.
- **Unknown card: park, not default account and not plain rejection.**
  - The request is stored with status `parked` and reason `unknownCard`, and the response is 202 with "Not logged yet: link the card 'TBC Visa' to an account in MoneyMatter".
  - The card name appears under **Unlinked cards** in Settings. Linking it offers to log the waiting payments.
  - Why: a default account files a payment on the wrong account, possibly in the wrong currency, and silently corrupts a balance. A plain rejection loses the payment, because the automation never fires again for it. In practice the trigger only fires for cards the user ticked, so this case is the first payment with a new card or a renamed card.
- **Pending: a planned row on bank-connected accounts, a normal row on manual accounts. No "Review" tag, no new `isPending` column.**
  - A connected account refuses manual rows anyway. A planned row is the existing "the bank will confirm this" state: every provider already merges a booked row into it (`matchPlanned`), which settles it in place, keeps the category and payee, and creates no duplicate.
  - Task 9 widens that match for card-payment plans, so a hold that settles at a different amount (tips, FX) still merges, but only when the bank's merchant text shares the plan's merchant tokens. Without merchant affinity the first unrelated same-account expense in range would consume the plan.
  - **Affinity is a token rule, applied automatically, not a suggestion the user confirms.** Bank descriptors differ from Wallet names ("HEART OF BATUMI CAFE BATUMI GE", "SQ \*HEART OF BATU" vs "Cafe Heart of Batumi"), so exact equality almost never holds. The rule compares normalized tokens of the plan's names (Wallet merchant, payee name and its aliases) with the bank's merchant text, or its note when the provider sends no merchant (Monobank card purchases have an empty `counterName` and put the merchant in `description`). It tolerates reordering, extra city/country tokens, processor prefixes and truncation. (⚠️ review round 1: city, country and business-kind words such as "batumi" or "cafe" are shared by different shops and do not count (`generic-merchant-words.ts`); more than half of a name's distinctive tokens must match; a payee the bank text already resolves to that differs from the plan's blocks the merge. When in doubt, no merge and no learned alias.)
    - Why not a confirm step: a tolerance merge is needed for every tipped or foreign-currency payment on a connected account, and asking each time defeats "without typing anything". The amount band, the time window and the single account already confine the candidates, and the token rule only has to rule out a different shop.
    - Why not Fuse (`fuzzyFindBestMatch`): it searches the long bank string as the pattern inside a short name and scores reordered or padded descriptors poorly; the token rule is deterministic and unit-testable with real descriptors.
    - A successful card-payment merge records the bank text as an alias of the plan's payee (`ensureAliasExists`, skipped when the text is ignored or already resolves to another payee), so the next payment at that merchant matches by alias as well.
    - What no rule catches (a descriptor in another script, a renamed merchant) is surfaced, not left behind: card-payment plans still unsettled after `PLANNED_MATCH_WINDOW_DAYS` are listed in Settings → Apple Pay as **Not confirmed by the bank**, where the user deletes the plan (the booked row already exists) or keeps it.
  - Planned rows normally get no automations and no AI (see Context). Card-payment plans are the exception, so a connected account categorizes like a manual one:
    - user automations run at ingest on a planned row whose `externalData` carries `cardPayment` (user-authored plans stay excluded);
    - the merge keeps `cardPayment` and `applyAutomations` in the merged `externalData` and, when the merged row still has the default category and null `categorizationMeta`, queues AI after commit.
  - On a manual account there is no bank to settle against, so the row is final and counts in the balance at once.
  - A "Review" tag would be a per-user name that the code has to create or guess, and nothing would ever settle it.
- **Payee: find or create on first sight.** The ingest calls the existing resolver with a promotion threshold of 1 (a new optional parameter, default unchanged), so the payee and alias are created through the same `insertOrAdopt` path, the ignored-names blocklist still applies, and the logo is resolved by the existing queue. A card merchant name is a deliberate merchant field, not a guess from a note, which is why the promotion threshold does not need to protect it.
- **Category order:**
  1. User automations and the payee's `enforce`/`hint` default (existing `createTransaction` steps). On a connected account the automations run on the planned row too (see Pending).
  2. Else the most frequent category of the user's past non-planned rows with that payee (last 12 months, ignoring the default category), passed as `categoryId` so the payee rule above still wins.
  3. AI, queued through the existing BullMQ job (trigger `sync`, scope `anyCategory`) for every non-planned row whose `categorizationMeta` is still null after create: a `hint` default, a history pick or the default category. That keeps the documented `hint` contract (AI may override it) for Apple Pay rows as for bank rows; an `enforce` payee or a rule sets `categorizationMeta` and gets no job.
     - Only a row in the default category waits for the answer: the request polls it for up to 8 s so a quick answer still reaches the notification, and a slower one says "categorizing…". A `hint` or history row answers at once with that category.
  4. Else the user's default category, as bank sync does.
  - The history pick leaves `categorizationMeta` null like `hint` mode does, so it is never mistaken for a user choice.
- **Missing exchange rate: park with reason `rateUnavailable`**, rather than storing a made-up account amount (the column is NOT NULL). This covers both the payment→account conversion and the account→base `refAmount` that `createTransaction` computes. It is retried from Settings or by resending the same idempotency key. With ISO pairs this is rare; with a custom-currency account it is the normal state until a rate exists.
- **The request log survives every failure.** The `IngestRequests` row is written in its own short transaction and committed before processing starts; processing runs in a second transaction. Rejections and parking are returned outcomes recorded in that transaction, never thrown. An unexpected throw rolls back only the processing, and a third short transaction records the row as `parked` (`rateUnavailable` for `ExchangeRateUnavailableError`, otherwise `processingFailed`), so nothing the shortcut sent is lost.
- **Last-4 mapping is dropped:** iOS does not expose the digits (see Context). Mappings key on the normalized card name. A renamed card parks until it is linked again.
- **Setup code (owner's one-tap design), adjusted where iOS or the code requires it:**
  - **Generated server-side and shown once.** It carries the raw token, which exists only in the create response, and folds in the stored Cloudflare Access secret, which the client never gets back. The page therefore always **mints a new token** for a code; picking an existing token is impossible because tokens are stored hashed. The previous Apple Pay token can be revoked in the same step (default on).
  - **Standard base64 with padding, not base64url.** The Shortcuts **Base64 Encode → Decode** action expects standard base64.
  - **Decoded on every run, not at import.** A shortcut cannot run actions at import; the import question only fills one Text action's value. Decoding at run time costs milliseconds.
  - **The shortcut strips the `v1.` prefix itself** (a Replace Text action, regex `^v1\.` → empty) before Base64 Decode: `.` is not a base64 character and the prefix would shift the 4-character alignment. The prefix stays so a human and the server can tell the format apart; the `v` field inside the JSON versions the payload itself.
- **Idempotency key: a hash of stable Shortcut inputs, plus a server-side repeat window.**
  - iOS gives the shortcut no transaction time (see Context), so a key cannot be fully stable across runs. The bundled shortcut builds the text `<card>|<merchant>|<amount text>|<time>` and sends its SHA-256 hex (**Generate Hash**, 64 characters). `<time>` is the Transaction's own date if Task 11's capture finds one on the input; otherwise it is the run time formatted to the minute (`yyyy-MM-dd'T'HH:mmZZZZZ`). An HTTP retry or a re-run within the same minute sends the same key.
  - The server also treats a request as a repeat when a `logged` request of the same user with the same fingerprint (card, amount, currency and merchant; not time) was received within 120 s of it. That catches the automation firing twice, a manual re-run and a second automation on the same card, which get different keys when the minute changes. The answer is the stored outcome with `duplicate: true` ("Already logged …"), so a genuine second identical payment within two minutes is visible and can be entered by hand; the docs say so.
  - The key rule is `^[\x21-\x7E]{8,128}$` (printable ASCII, no spaces), so a hashed key always fits and other clients can send UUIDs. `externalReference` becomes `<source>:<key>`, at most 162 characters.
- **Amounts:** expense only. A negative or zero amount, or a blank merchant, is rejected: the processing transaction records `rejected` with the reason, commits, and the controller then answers 422. The Settings list therefore shows that a payment came through empty (the known iOS glitch) and the user can enter it by hand.
- **Mappings target accounts the user owns** (no shared accounts in v1). Planned rows require the owner, and the payee and category namespaces are the owner's.
- **Guard coverage:** the ingest route writes transactions and ref amounts, so it carries `checkBaseCurrencyLock`. The coverage test treats `authenticateIngestToken` as an auth middleware too, so the invariant holds for it.
- **The iCloud link is runtime config** (`CARD_PAYMENT_SHORTCUT_ICLOUD_URL` in `window.__APP_CONFIG__`), not a `VITE_` build variable: one image serves hosted and self-hosted instances, and each sets its own link at container start.

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
  - the ingest-token hash helper (same output as the MCP hash it replaces);
  - the summary formatter;
  - the frequent-category picker's selection rule (through e2e, since it reads the DB);
  - the planned-match tolerance rule;
  - the shortcut plist generator, including a drift check against the committed XML and a decode of the setup code the way the shortcut's actions do it.
- **Backend e2e** (HTTP only, colocated with services, tokens created through the settings endpoint; the token store is the app's own table, so no e2e depends on the better-auth mock beyond the session cookie):
  - token create/list/revoke;
  - auth failures: missing, wrong, revoked and expired tokens, missing scope, a session cookie instead of a token, and a token used against a session route;
  - the IP auth-failure budget blocks even a valid token once spent;
  - a password reset revokes the user's tokens;
  - mapping CRUD;
  - ingest happy paths: same-currency, cross-currency, connected account (planned);
  - idempotency: same key returns the stored response; the same key with a different body is a 409; a different key for the same payment within the repeat window is a replay;
  - parking: unknown card and missing rate (payment conversion and base-currency `refAmount`), then retry after linking; concurrent retries log once;
  - rejections: zero amount and blank merchant, with the request row persisted;
  - body limit and rate limits;
  - dry run;
  - category order: payee default, history, AI and default, on manual and connected accounts;
  - setup-code endpoint;
  - bank-sync settlement through a provider mock (exact and merchant-aware tolerance matches, automations and AI after a merge);
  - guard coverage.
- **Frontend vitest:** the setup-code page state (shown once, cleared on leave), the mapping editor, the unlinked-cards list, the ingest URL builder, the runtime iCloud-link config.
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
    → strip "v1.", decode setup code (url, token, CF Access headers)
    → POST {url} JSON {amount, currency?, merchant, card, name?, time, idempotencyKey (SHA-256 hex), source:"apple-pay"}
       headers: Authorization: Bearer mm_ingest_…, CF-Access-Client-Id/Secret (if set)
  → [Cloudflare Access: service token on /api/v1/ingest/* only] → nginx /api/ → backend
  → JSON parser (8 KB for this path) → authenticateIngestToken (IP failure budget, then token lookup)
  → checkBaseCurrencyLock → ingest rate limit → controller
  → tx 1: IngestRequests row (idempotency), committed
  → tx 2: lock row → replay/409/repeat window → parse → card mapping → convert → payee → category
          → createTransaction (planned on connected accounts) → outcome on the row
  → (tx 3 only if tx 2 threw: park the row) → AI queue + bounded wait
  → 200 {summary} | 202 parked {summary} | 422 rejected {message}
  ```

- **Token store:**
  - `IngestTokens` (own Sequelize model): token format `mm_ingest_` + 32 random bytes base64url; only `hashToken(token)` is stored; scope `ingest:transactions`; `purpose` `general` | `card-payment-setup`.
  - `services/ingest-tokens/` provides create (returns the secret once), list (the user's tokens with name, `start`, scopes, `lastUsedAt`, `createdAt`, `expiresAt`), revoke, verify and revoke-all (password reset).
  - `authenticateIngestToken({ scope })` checks the caller IP's auth-failure budget, reads `Authorization: Bearer`, looks the hash up, checks expiry and scope, resolves the app user through `findAppUser` and the existing app-user cache, sets `req.user` and `req.ingestToken`, then runs `enforceReadOnly`.
- **Data:**
  - **`IngestTokens`:** `id` (uuid), `userId` (FK `Users`, cascade), `name`, `purpose`, `tokenHash` (unique), `start` (the first 14 characters, for display), `scopes` (`text[]`), `lastUsedAt`, `expiresAt`, timestamps; index `(userId)`. Excluded from backups: credentials, hashed, useless after a restore.
  - **`CardAccountMappings`:** `id`, `userId`, `cardLabel`, `normalizedLabel`, `accountId` (FK, cascade), timestamps; unique `(userId, normalizedLabel)`. Backed up.
  - **`IngestRequests`:**
    - `id`, `userId`, `tokenId` (FK `IngestTokens`, set null), `source`, `idempotencyKey`, `fingerprint`, `status` (`received` | `logged` | `parked` | `rejected` | `dismissed`), `reason`, `payload` (JSONB, the request body), `cardLabel`, `transactionId` (FK, set null), `duplicateOfId` (self FK, set null), `summary`, timestamps.
    - Unique `(userId, idempotencyKey)`; index `(userId, fingerprint, createdAt)` for the repeat window.
    - Excluded from backups: an operational log that holds raw merchant text, tied to tokens that are not backed up either. (⚠️ review round 1: still deleted by the workspace wipe and by a restore, both through `destroyUserOwnedData`, so raw merchant text and parked payments do not outlive the user's data).
  - **`IngestSettings`:** `userId` PK, `accessClientIdEnc`, `accessClientSecretEnc` (both `encryptToken`), timestamps. Excluded from backups: credentials.
- **Ingest pipeline** (`services/ingest/card-payment/`). The controller calls each phase outside any transaction, so each `withTransaction` opens its own (it would join an active one otherwise):
  1. **Record** (tx 1, committed at once): `INSERT … ON CONFLICT ("userId", "idempotencyKey") DO NOTHING` with status `received`, the fingerprint and the body.
  2. **Process** (tx 2, `processIngestRequest`, shared with retry):
     1. Lock the row (`findOne` with `lock: UPDATE`) and re-read it. `logged` with the same fingerprint → replay (200, `duplicate: true`); `logged` with a different fingerprint → 409; `dismissed` → 409; `received`, `parked` or `rejected` → go on. A concurrent duplicate waits on this lock, then sees `logged` and replays.
     2. Repeat window: take `pg_advisory_xact_lock` on `(userId, fingerprint)`, then look for an **original** `logged` request of the user (`duplicateOfId IS NULL`) with the same fingerprint whose `createdAt` is within 120 s of this row's. If found, mark this row `logged` with its `transactionId` and `duplicateOfId` (the original's id), and replay. A suppressed duplicate never anchors a window, so repeats cannot stretch it past the original payment.
     3. Parse with `parsePayload({ body, receivedAt: row.createdAt })`: amount and currency, time, merchant, card. The time window (5 min ahead, 30 days back) and the default time are measured from `receivedAt`, never from now, so a retry weeks later keeps the payment's own time and passes the same checks it passed at receipt. A failure records `rejected` with the reason and returns.
     4. Resolve the mapping, or record `parked`/`unknownCard` and return.
     5. Load the account and its currency. If the payment currency differs, convert with `calculateRefAmount` (amount owner = account owner) and set `originalAmount`/`originalCurrencyCode`; with no rate, record `parked`/`rateUnavailable` and return.
     6. Resolve the payee with promotion threshold 1.
     7. Pick the history category.
     8. `createTransaction` with expense, `paymentType: mobilePayment`, `rawMerchantName` (only if no payee was found), `payeeId`, `categoryId` (history or default), `applyAutomations: true`, `isPlanned` = account is connected, `externalReference`, and `externalData.cardPayment = { source, card, name, merchant, rawAmount, requestId }`.
     9. Record `logged` with the transaction id and summary.
  3. **Fail-safe** (tx 3, only when tx 2 threw): lock the row and re-read it, because tx 2's rollback released the lock and a concurrent pass (the same key resent, or a Settings retry) may have logged it meanwhile. Only when the status is still what this pass started from (`received`, `parked` or `rejected`) record it `parked` with `rateUnavailable` for an `ExchangeRateUnavailableError` (including the base-currency `refAmount` inside `createTransaction`) or `processingFailed` for anything else (also sent to Sentry), and answer 202 parked; the row stays retryable. If it is already `logged` or `dismissed`, leave it and answer that outcome (a replay or 409).
  4. **Interrupted rows:** a process that dies between tx 1 and the end of tx 2 or 3 leaves the row `received`. A `received` row older than 1 minute counts as waiting: the waiting list shows it (reason `interrupted`), and retry accepts it under the same row lock as a parked one. A younger `received` row is still in flight and is not offered for retry.
  - The controller maps the returned outcome to the HTTP status after commit: `logged` 200, `parked` 202, `rejected` 422, conflict 409.
- **After commit:** if the row is non-planned and its `categorizationMeta` is null, `queueCategorizationJob`. Only when it is in the default category, poll the row (250 ms steps, 8 s budget). Build the summary.
- **Settlement:**
  - `findPlannedMatch` keeps its exact pass (⚠️ review round 2: it reads all exact-amount candidates and, with merchant text, tries a card-payment plan of the same shop (`isSameShop`) first, so two equal-amount plans cannot swap bookings; with no such plan the closest in time still wins, and the exact pass stays permissive). A second pass runs only on plans with `externalData.cardPayment` and only for an incoming row with merchant text (`rawMerchantName`, else the note): the same account, type and currency, the amount within ±25 %, the time within `PLANNED_MATCH_WINDOW_DAYS` (7, as the exact pass), **and merchant affinity** (`hasMerchantAffinity`):
    - tokens: `normalizePayeeName`, split on spaces, drop tokens under 3 characters, pure digits and (⚠️ review round 1) generic city, country and business-kind words;
    - a plan token matches an incoming token when they are equal or, both being at least 4 characters, one is a prefix of the other (descriptor truncation);
    - affinity holds when, for any of the plan's names (Wallet merchant, payee name, each payee alias), more than half of its remaining tokens match (⚠️ review round 1: was "at least half"; a name with no distinctive token never matches). `isSameShop` decides first from the payee the full incoming text resolves to through `resolveNormalizedName`: the plan's own `payeeId` confirms, a different payee blocks the merge whatever the tokens say; only a text that names no known payee falls back to the token rule.
    - (⚠️ review round 2) a plan with splits is skipped when the booking is below its split total, so a merge never leaves the splits larger than the row;
    - SQL selects the tolerance candidates (amount band, window, `cardPayment`); the affinity check runs in code on those few rows, ordered by amount distance, then time distance, and the first that passes is locked (`FOR UPDATE SKIP LOCKED` by id).
  - `mergeIntoPlanned` takes the bank amount when it differs and re-derives `refAmount`; the payment-currency `originalAmount` stays. On a card-payment merge with a payee, the bank text becomes an alias of that payee (`ensureAliasExists`) unless it is an ignored name or already resolves to a payee.
  - Card-payment plans older than `PLANNED_MATCH_WINDOW_DAYS` are listed by `GET /user/settings/card-payments/unconfirmed` (Task 8) so they are never left behind silently. For a card-payment plan it keeps `cardPayment` and `applyAutomations` in the merged `externalData`, and when the merged row still has the default category and null `categorizationMeta` it queues AI after commit (scope `anyCategory`, trigger `sync`) if an AI client resolves for the owner. Automations ran at ingest; the merge keeps their category like any plan's.
  - Known limit (EnableBanking): a PDNG payload with the plan's exact amount merges into the plan; if the booking later arrives at a different amount with a new `entry_reference`, the provider's exact-amount pending upgrade misses it and a second row appears. The same two rows appear today without the ingest; Task 9 pins this behavior with a test and the docs name it.
- **Setup code:**
  - `v1.` + base64 of the JSON `{"v":1,"url":"…","token":"…","cfAccessId":"…","cfAccessSecret":"…"}`, with the CF fields present only when set. At most 2 KB, so the QR code stays scannable.
  - `POST /user/settings/card-payments/setup-code` takes `{ ingestUrl, tokenName?, revokePrevious? }`, mints a token and returns `{ token, setupCode }` once.
- **Generic shortcut:**
  - A generator script writes a reviewable XML plist (`packages/frontend/shortcuts/log-card-payment.plist`).
  - The maintainer signs it once on macOS into `packages/frontend/public/shortcuts/moneymatter-log-card-payment.shortcut`, which nginx serves as a download. An optional iCloud link is set per instance at runtime (`CARD_PAYMENT_SHORTCUT_ICLOUD_URL`).
  - **Actions:**
    1. Text: the setup code (the import question).
    2. Replace Text: regex `^v1\.` → empty.
    3. Base64 decode.
    4. Get Dictionary from Input.
    5. Get Dictionary Value: `url`, `token`, `cfAccessId`, `cfAccessSecret`.
    6. If Shortcut Input has no value, build `{dryRun:true}` (a manual test run). Otherwise read Amount, Merchant, Card and Name from it, and Format Date (ISO 8601 for `time`; the key's time as described under Decisions → Idempotency key).
    7. Text: `<card>|<merchant>|<amount>|<key time>`, then Generate Hash (SHA-256) for the idempotency key.
    8. Get Contents of URL: POST, JSON body, headers `Authorization`, `CF-Access-Client-Id`, `CF-Access-Client-Secret`.
    9. Read `response.summary`, falling back to `response.message`.
    10. Show Notification.
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
  - `time`: optional ISO 8601 with an offset. It defaults to the receive time (the request row's `createdAt`), may be at most 5 minutes ahead of it and at most 30 days before it. Retries measure against the same receive time.
  - `idempotencyKey`: required, `^[\x21-\x7E]{8,128}$` (printable ASCII without spaces; the bundled shortcut sends a 64-character SHA-256 hex).
  - `source`: optional `^[a-z0-9-]{1,32}$`, default `card-payment`.
  - `dryRun`: optional boolean. With `dryRun: true` every other field is optional (the shortcut run by hand has no transaction input); without `card` the summary is `Connected as <username>. <n> cards linked.`
  - Unknown keys are ignored, so newer shortcuts keep working against older servers. The JSON body limit is 8 KB, set by an `'8kb'` entry for this path in `setup-middleware.ts` (the global parser runs first, so a route-level parser would be a no-op); a larger body is a 413.
- **Fingerprint:** SHA-256 over the canonical JSON of the normalized card label, the amount text, whether the amount was sent as a JSON number or as text (⚠️ review round 2: the parser reads 1.234 and "1.234" differently), the currency and the merchant (trimmed, whitespace collapsed). `time` and `name` stay out, so two runs of one payment share it. It serves both the same-key 409 check and the 120 s repeat window.
- **Currency resolution:** an explicit `currency` wins. Otherwise a 3-letter code in the amount string. Otherwise a symbol that maps to exactly one of the user's currencies (`₾` GEL, `€` EUR, `£` GBP; `$` and `¥` only when the user has exactly one dollar or yen currency). Otherwise the mapped account's currency. A code that conflicts with the symbol is a 422.
- **Responses** (the standard `{ status, response }` envelope):
  - 200 `{ outcome: 'logged', summary, transactionId, planned, categoryPending, duplicate? }`.
  - 202 `{ outcome: 'parked', reason, summary, requestId }` (`reason`: `unknownCard` | `rateUnavailable` | `processingFailed`).
  - 200 for a dry run: `{ outcome: 'dryRun', summary: 'Connected as <username>. Card "<card>" → <account>' | '… is not linked yet' }`.
  - 401 for a missing or invalid token, 402 `planRequired` for a read-only plan (the app-wide `enforceReadOnly` contract), 403 for a missing scope, 409 for an idempotency conflict, 413 for a body over 8 KB, 422 for a rejection (`response.message`; the request row is already committed as `rejected`), 423 for the base-currency lock, 429 with `Retry-After`.
- **Summaries** use the user's locale and the currency's decimals:
  - `Logged 47.00 GEL at Cafe Heart of Batumi → Bar, cafe`
  - `Already logged 47.00 GEL at … → …` (a replay or a repeat within the window)
  - `Logged 12.50 EUR (36.71 GEL) at … → …`
  - `Noted 47.00 GEL at … → …; the bank sync will confirm it`
  - `… → categorizing…`
  - `… → Uncategorized`
  - `Not logged yet: link the card "TBC Visa" in MoneyMatter → Settings → Integrations → Apple Pay`
  - `Not logged yet: no EUR→GEL rate for 2026-10-17`
  - `Not logged yet: MoneyMatter could not process it; retry it in Settings → Integrations → Apple Pay`
- **Rate limits:**
  - `ingestTokenRateLimit`: 30 requests per minute per token, `failClosed: false` (a `createRateLimit` middleware after auth).
  - **IP auth-failure budget:** 20 failed authentications per 15 minutes per IP. Not a `createRateLimit` middleware: a helper inside `authenticateIngestToken` reads the IP's failure count with `RateLimitService.getRateLimitStatus` **before** the token lookup and answers 429 with `Retry-After` (the key's TTL) when the budget is spent, even for a valid token, so guessing is throttled and sheds the lookup. Only a failure increments the count (`RateLimitService.checkRateLimit` on the same key). A Redis outage reads as count 0, so the check fails open; the per-token limit still applies.
  - The settings writes (`setup-code`, token create) are limited to 10 per minute per user.
- **Settings API** (session auth):
  - `GET|POST /user/settings/ingest-tokens`, `DELETE /user/settings/ingest-tokens/:id`.
  - `GET|POST /user/settings/card-mappings`, `PATCH|DELETE /user/settings/card-mappings/:id`.
  - `GET /user/settings/card-payments/requests?status=parked|recent` (`parked` includes `received` rows older than 1 minute), `POST /user/settings/card-payments/requests/:id/retry`, `DELETE /user/settings/card-payments/requests/:id` (dismiss).
  - `GET /user/settings/card-payments/unconfirmed`: card-payment plans older than `PLANNED_MATCH_WINDOW_DAYS` (the UI deletes one through the existing transaction delete endpoint).
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
- **Migration:** one file, `migrations/20261017020000-card-payment-ingest.ts`: `IngestTokens`, `CardAccountMappings`, `IngestRequests`, `IngestSettings`.
- **Controllers:** all five live in `controllers/ingest/` (`ingest-tokens`, `card-mappings`, `card-payment-requests`, `card-payment-setup-code`, `card-payment`), like `controllers/mcp/` and `controllers/backup/`.
- **Retention:** a daily cron, `ingest-requests-cleanup`, deletes `logged`/`rejected`/`dismissed` rows older than 90 days. `parked` and `received` rows stay until they are resolved or dismissed.
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

### Task 1: Ingest token store (`IngestTokens`)

**Files:**

- Create: `packages/backend/src/common/lib/hash-token.ts` + `hash-token.unit.ts`; Modify: `packages/backend/src/services/mcp/auth.ts` (imports it)
- Create: `packages/backend/src/migrations/20261017020000-card-payment-ingest.ts` (the `IngestTokens` part; later tasks extend this file)
- Create: `packages/backend/src/models/ingest-tokens.model.ts`
- Create: `packages/backend/src/services/ingest-tokens/{index,ingest-tokens.service,constants}.ts`
- Create: `packages/backend/src/middlewares/ingest-token-auth.ts`
- Modify: `packages/backend/src/config/auth.ts` (`onPasswordReset` step), `packages/backend/src/tests/mocks/better-auth/index.ts` (a `/reset-password` route that runs the configured `onPasswordReset`)
- Modify: `packages/backend/src/services/backup/registry.ts`
- Modify: `packages/shared/src/types/` (new `ingest.ts`: `INGEST_SCOPES`, token DTOs)
- Create: `packages/backend/src/services/ingest-tokens/{session-isolation,password-reset}.e2e.ts`

- [x] move `hashToken` from `services/mcp/auth.ts` to `common/lib/hash-token.ts` unchanged; a unit test pins its output for a fixed input, so stored MCP tokens keep verifying
- [x] write failing e2e (`session-isolation.e2e.ts`): a minted token sent cookie-less as `Authorization: Bearer` and as `x-api-key` to `GET /user` and `POST /transactions` gets 401 (a regression guard: nothing registers the token with better-auth); a revoked token, an expired token and a token without `ingest:transactions` are refused by the ingest middleware (exercised from Task 5's route, so these cases are marked "pass at Task 5")
- [x] write failing e2e (`password-reset.e2e.ts`): after a password reset through the auth mock's `/reset-password` route, the token list is empty and the token gets 401 on the ingest route (the 401 case passes at Task 5)
- [x] migration and model `IngestTokens` (columns in Solution Overview → Data); object-param statics
- [x] `ingest-tokens.service.ts`:
  - `createIngestToken({ userId, name, purpose?, expiresInDays? })` returns `{ token, secret }` with the secret only here; it stores `hashToken(secret)` and `start`;
  - `listIngestTokens({ userId })`; `revokeIngestToken({ userId, id })`, which is a 404 for another user's id; `revokeIngestTokens({ userId, purpose? })`;
  - `verifyIngestToken({ secret })`: hash lookup, expiry check; `lastUsedAt` is updated at most once a minute (a conditional `UPDATE … WHERE "lastUsedAt" < now() - interval '1 minute' OR "lastUsedAt" IS NULL`);
  - `userId` is always the app's `Users.id`; DTO `{ id, name, start, scopes, lastUsedAt, createdAt, expiresAt }`
- [x] `authenticateIngestToken({ scope })` middleware (named function `authenticateIngestToken`): the IP auth-failure budget check (Technical Details → Rate limits) before anything else, Bearer parse, verify, scope check (403), resolve the app user through `findAppUser` and the existing cache, set `req.user` and `req.ingestToken`, Sentry user, then `enforceReadOnly`. A failure is a 401 with `API_ERROR_CODES.unauthorized` and an i18n message, and it increments the IP's failure count
- [x] `onPasswordReset`: add a `'revoke ingest tokens'` step, `DELETE FROM "IngestTokens" WHERE "userId" IN (SELECT id FROM "Users" WHERE "authUserId" = $1)` through the same `pool`, next to the OAuth token steps
- [x] auth mock: a `POST /reset-password` route taking `{ token, newPassword }`, where the mock's reset token is the auth user id, that awaits `config.emailAndPassword.onPasswordReset({ user })`; a helper `resetPasswordForTests({ authUserId })` in `tests/helpers/user.ts`
- [x] backup registry: `IngestTokens` in `BACKUP_EXCLUDED` ("credentials, stored hashed; a restored hash is useless and a restore must not resurrect a revoked token")
- [x] unit tests: Bearer parsing (missing, wrong scheme, extra spaces), the token format and the DTO mapping
- [x] gate (passed: unit 68 tests in 10 suites; e2e 4 suites, 22 passed, 4 skipped until Task 5; typecheck and lint clean; full unit suite 3132 passed): `npm run test:unit -- --testPathPattern='(hash-token|ingest-tokens|ingest-token-auth|backup/registry)'`; `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest-tokens/(session-isolation|password-reset)|mcp/(connected-apps|mcp-scope-gate)).e2e'` (the session and token-list cases pass; the ingest cases stay skipped until Task 5); typecheck and lint

### Task 2: Token management endpoints

**Files:**

- Create: `packages/backend/src/controllers/ingest/ingest-tokens.controller.ts`
- Modify: `packages/backend/src/routes/user.route.ts`, `packages/backend/src/middlewares/rate-limit.ts` (`ingestSettingsWriteRateLimit`)
- Modify: `packages/backend/src/routes/base-currency-guard-coverage.e2e.ts`
- Create: `packages/backend/src/services/ingest-tokens/ingest-tokens.e2e.ts`, `packages/backend/src/tests/helpers/ingest.ts` (exported from `helpers/index.ts`)
- Modify: `packages/backend/src/services/ingest-tokens/{password-reset,session-isolation}.e2e.ts` (token state through the HTTP list and revoke instead of counting rows), `packages/shared/src/types/ingest.ts` (create payload and response types)

- [x] write failing e2e:
  - create returns the secret once and list never contains it;
  - list is empty for a fresh user;
  - revoke removes it and is a 404 on a second revoke;
  - another user's token id is a 404;
  - a name longer than 100 chars is a 422;
  - a demo user is blocked (`blockDemoUsers`);
  - the 11th create in a minute is a 429
- [x] routes `GET|POST /user/settings/ingest-tokens`, `DELETE /user/settings/ingest-tokens/:id` behind `authenticateSession`; zod schemas (`name` 1–100, `expiresInDays` optional 1–3650)
- [x] guard coverage: add an `AUTH_MIDDLEWARES` set (`authenticateSession`, `authenticateIngestToken`) to the invariant; exempt the token `POST`/`DELETE` routes with the reason "credentials, no monetary data"
- [x] i18n keys: none added. Task 1's `ingestTokens.*` (en + uk) already covers the not-found message, and validation failures use zod's 422 messages
- [x] gate (passed: 6 suites, 54 passed and 4 skipped until Task 5, with typecheck and lint clean): `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest-tokens/ingest-tokens|routes/base-currency-guard-coverage).e2e'`

### Task 3: Card mappings, ingest log and access-header storage

**Files:**

- Modify: `packages/backend/src/migrations/20261017020000-card-payment-ingest.ts`
- Create: `packages/backend/src/models/{card-account-mappings,ingest-requests,ingest-settings}.model.ts`
- Create: `packages/backend/src/services/ingest/{normalize-card-label,card-mappings.service,access-headers.service}.ts`, `normalize-card-label.unit.ts`
- Create: `packages/backend/src/controllers/ingest/{card-mappings,access-headers}.controller.ts`, `packages/backend/src/services/ingest/card-mappings.e2e.ts`
- Modify: `packages/backend/src/routes/user.route.ts`, `services/backup/registry.ts`, `routes/base-currency-guard-coverage.e2e.ts`

- [x] failing unit tests for `normalizeCardLabel` (trim, collapse whitespace, case-fold, Unicode NFC, strip a trailing "•••• 1234" if Wallet ever adds it)
- [x] failing e2e:
  - mapping CRUD (create, list empty and filled, rename the label, change the account, delete);
  - a duplicate normalized label is a 409;
  - an account the user does not own, an archived account, or a loan/vehicle account (`isDedicatedFlowAccountCategory`) is a 422;
  - deleting the account removes its mappings;
  - access headers: PUT stores them, GET returns `{ configured: true, clientIdHint: '…a1b2' }` and never the secret, PUT with `null`s clears them
- [x] migration: the three tables, FKs (`userId` cascade, `accountId` cascade, `tokenId`, `transactionId` and `duplicateOfId` set null), unique indexes and the `(userId, fingerprint, createdAt)` index; models with object-param statics
- [x] services and routes `GET|POST /user/settings/card-mappings`, `PATCH|DELETE /user/settings/card-mappings/:id`, `GET|PUT /user/settings/card-payments/access-headers` (encrypted with `encryptToken`; the PUT is behind `blockDemoUsers` and `ingestSettingsWriteRateLimit`)
- [x] i18n keys `cardMappings.*` (en + uk); `owned-reference-guard.unit.ts` lists `card-account-mappings: ['accountId']`
- [x] backup registry: `CardAccountMappings` in `BACKUP_TABLES` (restore remaps `accountId`), `IngestRequests` and `IngestSettings` in `BACKUP_EXCLUDED` with reasons; a mapping round-trips through export and restore
- [x] guard coverage: exempt the mapping and access-header writes with reasons
- [x] gate (passed: unit 20 tests in 3 suites; e2e 3 suites, card-mappings 34 tests, restore-backup round-trip with a mapping and guard coverage green; typecheck and lint clean): `npm run test:unit -- --testPathPattern='(normalize-card-label|backup/registry)'`; `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest/card-mappings|routes/base-currency-guard-coverage|backup/restore/restore-backup).e2e'`

### Task 4: Payload parsing and summaries

**Files:**

- Create: `packages/backend/src/services/ingest/card-payment/{parse-amount,resolve-currency,parse-payload,fingerprint,format-summary}.ts` with a `.unit.ts` each, plus `clean-text.ts` (+ `.unit.ts`), the text cleaner they share
- Modify: `packages/shared/src/types/ingest.ts` (`CARD_PAYMENT_REJECTION_REASONS`), `packages/backend/src/i18n/locales/{en,uk}.json` (`ingest.summary.*`)

- [x] failing unit tests:
  - `parseAmount`:
    - `47`, `"47"`, `"47.00"`, `"47,00"`, `"1,234.56"`, `"1.234,56"`, `"1 234,56"` (NBSP and narrow NBSP), `"₾47.00"`, `"47.00 GEL"`, `"GEL 47"`, `"-47"` (`negative`), `"0"`/`"0.00"` (`zero`), `""` and `"abc"` (`invalid`);
    - an ambiguous `"1,234"` reads as thousands only with exactly 3 digits after the separator and no other separator; otherwise decimal; this rule is documented in the code
  - `resolveCurrency`: explicit wins; a code in the text; a unique symbol among the user's currencies; an ambiguous `$` with two dollar currencies falls back to the account currency; a code vs symbol conflict is an error
  - `parsePayload({ body, receivedAt })`: field limits, the time window measured from `receivedAt` (5 min ahead, 30 days back, default `receivedAt`; a time 40 days before now passes when `receivedAt` is 35 days ago and the time 5 days before it), the `source` pattern, the `idempotencyKey` rule (a 64-char hex passes; 7 chars, 129 chars, a space or `₾` fail), unknown keys ignored
  - `fingerprint`: stable over key order, whitespace, `time` and `name`; changes with amount, currency, merchant or card
  - `formatSummary`: every summary in Technical Details, using the currency's decimals and the user's locale
- [x] implement them as pure functions; currency decimals come in as a parameter, so the units need no DB. `parsePayload` returns the amount parse (decimal string, code and symbol found in the text, explicit `currency`); `resolveCurrency` runs after the card mapping, once the account currency is known. Summaries are `ingest.summary.*` i18n keys (en + uk), formatted with `Intl.NumberFormat` in the user's locale
- [x] gate (passed: 6 suites, 219 tests; typecheck, lint and oxfmt clean): `npm run test:unit -- --testPathPattern='ingest/card-payment'`

### Task 5: Ingest endpoint: auth, validation, rate limits, idempotency, parking and dry run

**Files:**

- Create: `packages/backend/src/routes/ingest.route.ts`, `packages/backend/src/controllers/ingest/card-payment.controller.ts`
- Create: `packages/backend/src/services/ingest/card-payment/{ingest-card-payment,record-request,process-ingest-request}.ts`
- Modify: `packages/backend/src/setup-routes.ts` (mount `${API_PREFIX}/ingest`), `packages/backend/src/setup-middleware.ts` (`'8kb'` body limit for the ingest path), `packages/backend/src/middlewares/rate-limit.ts`
- Create: `packages/backend/src/services/ingest/card-payment/ingest-card-payment.e2e.ts`
- Modify: `packages/backend/src/routes/base-currency-guard-coverage.e2e.ts`, `services/ingest-tokens/{session-isolation,password-reset}.e2e.ts` (un-skip)

- [x] write failing e2e (a token and a mapping created through helpers, requests sent without cookies):
  - happy path: a mapped card in the account's currency → 200 `logged`, then `GET /transactions` shows an expense with the amount, `externalReference` `apple-pay:<key>`, `externalData.cardPayment` and the summary text;
  - empty state: a dry run with no mappings → 200 `dryRun` "… is not linked yet", and nothing is written;
  - unknown card → 202 `parked`/`unknownCard`, nothing is in `GET /transactions`, and the request is listed as parked (Task 8's list; until then asserted through the replay of the same key);
  - the same key and body twice → one transaction, the second answer has `duplicate: true`; the same key with another amount → 409;
  - two requests with different keys and the same card, amount and merchant 5 s apart → one transaction, the second answer has `duplicate: true` ("Already logged …"); with the window shortened for the case (a constant overridable in tests, like the 8 s AI budget) and the second request sent after it → two transactions;
  - with the window shortened to W, three requests for the same payment at 0, 0.75 W and 1.5 W → the second is a duplicate, the third is a new transaction (a duplicate does not anchor the window);
  - two concurrent requests with the same key → one transaction (`Promise.all`);
  - zero amount, blank merchant, negative amount → 422, and the request row persists as `rejected` (the same key replayed reads it back);
  - a body just over 8 KB → 413;
  - missing token 401, bad token 401, revoked token 401, a token without the scope 403, a read-only plan 402 `planRequired`;
  - the base-currency lock → 423;
  - the 31st request in a minute → 429 with `Retry-After`;
  - after 20 bad-token attempts from one IP, the 21st → 429, and a valid token from the same IP → 429 too (reset the limiter keys after the case, as the other limiter e2e do)
- [x] `setup-middleware.ts`: an `'8kb'` entry for `${API_PREFIX}/ingest/card-payment` in the per-path limit map; no route-level parser
- [x] route `POST /api/v1/ingest/card-payment`: `authenticateIngestToken({ scope: 'ingest:transactions' })` (with the IP failure budget inside), `checkBaseCurrencyLock`, `ingestTokenRateLimit`, then the controller
- [x] `ingestCardPayment` with the three phases from Solution Overview → Ingest pipeline, up to and including the parking decision (⚠️ the happy path and the idempotency cases need a logged row, so this task also ships a minimal `processCardPayment` that logs a payment in the account's currency on the user's default category; a payment in another currency is parked as `processingFailed` until Task 6 adds the conversion, payee, history category and rate parking; a request with no usable idempotency key has nothing to key a row on and is answered 422 unrecorded; a reused key with a different body is a 409 for every open status, not only `logged`):
  1. a dry run (`dryRun: true`, or no `idempotencyKey` with `dryRun`) only parses and looks up the mapping, then answers; it writes nothing, not even a request row;
  2. tx 1: insert the request (`ON CONFLICT DO NOTHING`), committed;
  3. tx 2 (`processIngestRequest({ requestId })`): lock the row, replay or 409, the repeat window, parse (→ `rejected`, returned), look up the mapping (none → `parked`/`unknownCard`, returned);
  4. tx 3 on a throw: record `parked` with `rateUnavailable` or `processingFailed`;
  5. the controller maps the returned outcome to 200/202/409/422 after commit; nothing in the pipeline throws `ValidationError` for a rejection
- [x] guard coverage: the ingest route carries the guard (the invariant passes without an exemption); a sanity case asserts the ingest route is discovered with `authenticateIngestToken`
- [x] un-skip the Task 1 ingest-auth and password-reset cases
- [x] i18n `ingest.*` messages in `en` + `uk`
- [x] gate (passed: unit 11 suites, 263 tests; e2e 4 suites, 48 passed, none skipped; typecheck, lint and oxfmt clean): `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest/card-payment/ingest-card-payment|ingest-tokens/(session-isolation|password-reset)|routes/base-currency-guard-coverage).e2e'`

### Task 6: Processing: payee, category, currency, planned rows

**Files:**

- Modify: `packages/backend/src/services/payees/extraction.service.ts`, `resolve-payee-for-incoming-row.ts` (optional `promotionThreshold`)
- Create: `packages/backend/src/services/ingest/card-payment/{pick-history-category,convert-to-account-currency}.ts`; extend `process-card-payment.ts` (⚠️ Task 5 ships a minimal version: same-currency payments on the default category, other currencies parked as `processingFailed`; `park-failed-request.ts` writes the generic `processingFailed` text for a `rateUnavailable` throw, so the pair-specific summary is this task's)
- Modify: `packages/backend/src/services/ingest/card-payment/ingest-card-payment.ts`
- Create: `packages/backend/src/services/ingest/card-payment/processing.e2e.ts`

- [x] write failing e2e (red run: 8 of 16 new cases failed on assertions, the rest already held because `createTransaction` already provides them; see the progress log):
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
    - a user automation that sets a category wins over all of them, on a manual account and on a bank-connected account (the planned row gets the rule's category and the summary names it);
    - a user-authored planned row on a connected account still gets no automation (regression case)
  - **currency:**
    - a USD payment on a GEL account stores `amount` in GEL (half-even, GEL decimals) with `originalAmount` 12.50 USD and `originalCurrencyCode` USD, and the summary shows both;
    - a missing rate (exchange-rate mock returns nothing) → 202 `parked`/`rateUnavailable`;
    - a EUR payment on a EUR account whose owner's base is USD, with no EUR→USD rate (the throw comes from `createTransaction`'s `refAmount`) → 202 `parked`/`rateUnavailable`, no transaction, and the request row persists as parked;
    - a custom-currency account with no rate → parked
  - **connected account:** a mapping to a bank-connected account creates a planned row (`isPlanned: true`, not in the balance) and the summary says the bank will confirm it
  - **time:** the stored `time` equals the sent ISO time
- [x] `resolvePayeeForRawMerchant({ userId, rawMerchantName, promotionThreshold? })`: the parameter overrides the user setting only when given; every existing caller passes nothing
- [x] `pickHistoryCategory({ ownerUserId, payeeId })`: one aggregate over the owner's non-planned, non-transfer rows from the last 12 months, excluding the default category; the most frequent wins, ties go to the latest
- [x] `convertToAccountCurrency({ ownerUserId, amount, from, to, date })`: `calculateRefAmount`, then `roundToCurrency` half-even to the account's decimals; `ExchangeRateUnavailableError` → `{ parked: 'rateUnavailable' }` (⚠️ `calculateRefAmount` throws for a custom currency without a rate and never returns `null`, so there is no `null` branch)
- [x] `isAutomationEligible`: also true for a planned row whose `externalData` has `cardPayment` (ingest-created plans only); its unit test gets both cases
- [x] `processCardPayment` (steps 5–9 of tx 2): the mapping's account (owned, still active), then the conversion, the payee, the history category and `createTransaction` with the parameters from Solution Overview; the outcome is written to the request row; an `ExchangeRateUnavailableError` from anywhere in it reaches tx 3 as `rateUnavailable` (⚠️ `createTransaction`'s throw is rewrapped as `CardPaymentRateUnavailableError`, which names the pair account currency → base currency and the day, so the parked summary is pair-specific; the payee is resolved first and passed as `payeeId`, `rawMerchantName` is not passed again)
- [x] gate (passed: unit 15 suites, 320 tests; e2e 8 suites, 149 passed, none skipped; typecheck, lint and oxfmt clean): `npm run test:unit -- --testPathPattern='transaction-automations/eligibility'`; `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest/card-payment/(processing|ingest-card-payment)|payees/payees|transactions/original-currency-metadata|transaction-automations/).*e2e'`

### Task 7: AI categorization with a bounded wait

**Files:**

- Create: `packages/backend/src/services/ingest/card-payment/categorize-after-commit.ts`
- Modify: `packages/backend/src/services/ingest/card-payment/ingest-card-payment.ts`
- Create: `packages/backend/src/services/ingest/card-payment/ai-categorization.e2e.ts`
- Modify: `packages/backend/src/services/ingest/card-payment/constants.ts` (`aiWaitBudgetMs`, `aiPollIntervalMs`), `packages/backend/src/tests/mocks/gemini/mock-api.ts` (`categorizationsByName`: answer by category name instead of prompt ordinal)

- [x] write failing e2e (red run: 4 of 8 failed on assertions, the 4 'no job' cases already held because nothing queued yet; see the progress log) with the existing AI test environment (`tests/helpers/ai-test-env.ts` / `ai-categorization.ts`):
  - an AI answer within the budget → the summary names the AI's category and `categoryPending: false`;
  - an AI that answers after the budget → "categorizing…", and the row is categorized later (poll the transaction);
  - no AI configured → `categoryPending: false`, "Uncategorized", no job queued;
  - a `hint` payee category or a history category → a job is queued but not awaited: the answer names that category at once, and AI may later override it (as for bank rows);
  - an `enforce` payee category or a rule's category → no job queued (`categorizationMeta` is set);
  - a planned row → no job queued at ingest (AI skips planned rows; Task 9 queues it after the merge)
- [x] after commit: when the row is non-planned, its `categorizationMeta` is null, and an AI client resolves for `AI_FEATURE.categorization`, call `queueCategorizationJob({ userId: owner, transactionIds: [id], scope: anyCategory, trigger: sync })`; only when the row is in the default category, poll it until `categorizationMeta` is set or 8 s pass (the budget is `cardPaymentTimings.aiWaitBudgetMs`, overridable in tests; ⚠️ the lookup is `resolveAIConfiguration`, the same resolver `createAIClient` uses, so no model object is built just to test for a client; a failure anywhere in this step is logged and leaves the logged answer as tx 2 built it)
- [x] gate (passed: e2e 1 suite, 8 tests; typecheck, lint and oxfmt clean): `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='ingest/card-payment/ai-categorization.e2e'`

### Task 8: Waiting payments: list, retry, dismiss, retention

**Files:**

- Create: `packages/backend/src/controllers/ingest/card-payment-requests.controller.ts`, `packages/backend/src/services/ingest/card-payment/{list-requests,retry-request,dismiss-request,run-ingest-pass}.ts` (⚠️ `run-ingest-pass.ts` is the tx 2 / tx 3 / AI sequence the ingest endpoint and the retry share)
- Create: `packages/backend/src/crons/ingest-requests-cleanup.ts` (+ registration where the other crons register)
- Modify: `packages/backend/src/routes/user.route.ts`, `routes/base-currency-guard-coverage.e2e.ts`
- Create: `packages/backend/src/services/ingest/card-payment/requests.e2e.ts`, `packages/backend/src/crons/ingest-requests-cleanup.e2e.ts`

- [x] write failing e2e (red run: 22 of 25 new cases failed on assertions, 404 for the missing routes and the stub cron deleting nothing; the 3 that held were the unknown-id 404s, which a missing route also answers, and the cron's empty case):
  - empty list;
  - a parked `unknownCard` request is listed; after the card is linked, retry → 200 `logged` and the transaction exists;
  - a retry while still unlinked stays parked;
  - a retry of a `logged` request is a 409;
  - two concurrent retries of one parked request (`Promise.all`) → one 200 `logged`, one 409, and exactly one transaction;
  - two parked requests for the same payment (different keys, same fingerprint, 5 s apart), retried after linking → one transaction, the second retry answers `duplicate: true`;
  - a `processingFailed` request is listed as parked and logs on retry;
  - a parked request retried after the clock moves 35 days on (`jest.setSystemTime`, Date only) logs the payment with its original `time`; one sent without `time` gets its receive time, not the retry time;
  - a `received` row left by an interrupted pass (a test hook that throws inside tx 2 and tx 3) is not listed while younger than 1 minute; after the clock moves 2 minutes it is listed with reason `interrupted`, and retry logs it;
  - a tx 3 that loses the race: a pass whose tx 2 throws while a concurrent retry logs the row (test hook that pauses tx 3) leaves the row `logged`, and a later retry is a 409 with one transaction;
  - `GET /user/settings/card-payments/unconfirmed` is empty for a fresh plan and lists a card-payment plan once the clock passes `PLANNED_MATCH_WINDOW_DAYS`; a user-made plan is never listed;
  - dismiss → status `dismissed`, then a second dismiss is a 404;
  - `GET ?status=recent` returns the last 50 of every status, newest first, with summary, card, merchant, amount text and time;
  - `GET /user/settings/card-mappings/unlinked` returns the distinct parked card labels with counts;
  - the cleanup cron deletes `logged`/`rejected`/`dismissed` rows older than 90 days and keeps `parked` and `received` rows
- [x] routes `GET /user/settings/card-payments/requests`, `POST …/requests/:id/retry` (guarded), `DELETE …/requests/:id` (exempt); `GET /user/settings/card-mappings/unlinked`; `GET /user/settings/card-payments/unconfirmed`
- [x] retry runs `processIngestRequest` (tx 2, with tx 3 on a throw) on the stored payload under the request's user, never a client-sent body: inside `withTransaction` it locks the row (`findOne` with `lock: UPDATE`) and re-checks that the status is `parked`, or `received` with `createdAt` older than 1 minute, before processing, so a concurrent retry waits, then sees `logged` and gets a 409 (⚠️ Task 7: a retry that logs a payment should also call `categorizeAfterCommit`; it is exported from `categorize-after-commit.ts`, takes `{ userId, requestId, transactionId, locale }` and returns the replacement answer or `null`; done: `runIngestPass` calls it for both paths, and a retry names the AI category in its answer; a retry of a request that is not waiting (logged, rejected, dismissed, or `received` under a minute) is a 409 `notWaiting`; a retry that is still parked answers 202)
- [x] test hooks for the interrupted and racing cases (⚠️ the repo has no fault-injection pattern, so no production hook was added: the cases use `jest.spyOn` on `CardAccountMappings.findOne` to make tx 2 throw and on `IngestRequests.findOne` to fail or pause tx 3 by its locked read)
- [x] gate (passed: e2e 3 suites, 34 passed; unit 12 suites, 264 passed; typecheck, lint and oxfmt clean): `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest/card-payment/requests|crons/ingest-requests-cleanup|routes/base-currency-guard-coverage).e2e'`

### Task 9: Bank-sync settlement of card-payment plans

**Files:**

- Modify: `packages/backend/src/services/transactions/planned-matching/{find-planned-match,merge-into-planned,index}.ts`
- Create: `packages/backend/src/services/transactions/planned-matching/card-payment-tolerance.ts` + `.unit.ts`
- Create: `packages/backend/src/services/transactions/planned-matching/merge-card-payment.e2e.ts`

- [x] failing unit tests for `isWithinCardPaymentTolerance({ planned, incoming })`: ±25 % of the plan amount, `PLANNED_MATCH_WINDOW_DAYS` window, the same currency; boundary cases
- [x] failing unit tests for `hasMerchantAffinity({ planNames, incomingText })` with real-shaped descriptors: "Cafe Heart of Batumi" vs "HEART OF BATUMI CAFE BATUMI GE" (match), vs "SQ \*HEART OF BATU" (match, truncation), vs "CAFE HEART BATUMI" (match), vs "SPAR BATUMI" (no match), vs "" (no match); a single-token name "Spar" vs "SPAR MARKET 0123 BATUMI" (match); Cyrillic "Сільпо" vs "Сільпо" (match); short and numeric tokens ignored
- [x] failing e2e through a provider mock (Monobank or EnableBanking, whichever helper syncs a single booked row most directly):
  - an exact amount merges as today;
  - a 47.00 plan and a 52.00 booking from the same merchant (tip) merge, the row's amount becomes 52.00, `refAmount` is re-derived, `originalAmount` stays, the payee and category stay;
  - a 52.00 booking whose descriptor differs from the Wallet name ("HEART OF BATUMI CAFE BATUMI GE" for "Cafe Heart of Batumi") merges, and the descriptor becomes an alias of the plan's payee;
  - a cross-currency plan (USD 12.50 → 33.71 GEL) and a 34.02 GEL booking 4 days later merge;
  - Monobank: a card purchase with an empty `counterName` and the merchant in `description` merges by the note;
  - a 52.00 booking whose merchant is an alias of the plan's payee merges too;
  - one 47.00 plan, then a 52.00 booking from another merchant, then a 47.00 booking: the 47.00 merges, the 52.00 becomes a new row;
  - a 47.00 plan and a 70.00 booking do not merge (two rows);
  - a user-made plan (no `cardPayment`) still needs the exact amount;
  - of two card-payment plans, the closer amount wins;
  - automations and AI after a merge: a connected-account card payment whose user rule sets a category keeps it through the merge; one with no category and AI configured gets a categorization job after the merge, and the merged row's `externalData` still has `cardPayment`;
  - EnableBanking PDNG 47.00 merges into the plan, then BOOK 52.00 with a changed `entry_reference` → two rows (the documented limit; the test pins it so a later fix is a visible change)
- [x] `findPlannedMatch`: keep the exact query, then, only when the incoming row has merchant text (`rawMerchantName`, else `note`), the tolerance query restricted to `externalData ? 'cardPayment'` with the plans' payee names and aliases loaded, ordered by amount distance, then time distance; `hasMerchantAffinity` in code picks the first passing candidate, which is then locked by id with `FOR UPDATE SKIP LOCKED` (a skipped lock moves on to the next candidate); `tryMergeIntoPlanned` passes `rawMerchantName` and `note` down
- [x] `mergeIntoPlanned` (⚠️ the bank text is learned as an alias only when `hasMerchantAffinity` holds against the plan's names: an exact-amount booking from an unrelated shop also settles a plan and its text must not become an alias; `queueCategorizationAfterCommit` is new in `services/ai-categorization/`, resolves the AI client at once and defers only the Redis publish, on the outermost transaction, because the hook of a savepoint fires at its release and a query in a hook runs on a finished transaction; `dev` adds `settlePeriodOnConfirm` after the merge in `create-transaction.ts`, outside this code, so the two compose when `dev` is merged): an optional `amount` override applied with the planned → real transition on the same instance; `refAmount` comes from the merged amount; on a card-payment merge with a payee, `ensureAliasExists` for the bank text unless `isPayeeNameIgnored` or `resolveNormalizedName` already resolves it; for a card-payment plan, keep `cardPayment` and `applyAutomations` in the merged `externalData` and, when the row still has the default category and null `categorizationMeta`, queue AI after commit (`queueCategorizationAfterCommit`, the `enqueueLogoResolutionAfterCommit` pattern) if an AI client resolves for the owner
- [x] gate (passed: unit 17 tests in 1 suite, full unit suite 3391 passed; e2e 3 suites, 31 passed, merge-card-payment 13 cases; typecheck, lint and oxfmt clean): `npm run test:unit -- --testPathPattern='card-payment-tolerance'`; `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='transactions/planned-matching/(merge-card-payment|merge-on-sync|merge-on-import).e2e'`

### Task 10: Setup code

**Files:**

- Create: `packages/shared/src/types/ingest/card-payment-setup-code.ts` (⚠️ review round 1: moved from `shared/src/lib/` into `types/ingest/`, imported flat from `@bt/shared/types`; encoder/decoder, shared so the backend and the shortcut generator tests use one definition) + its unit test in `packages/backend/src/services/ingest/setup-code.unit.ts`
- Create: `packages/backend/src/controllers/ingest/card-payment-setup-code.controller.ts`, `packages/backend/src/services/ingest/create-setup-code.ts`
- Create: `packages/backend/src/services/ingest/setup-code.e2e.ts`
- Modify: `packages/backend/src/routes/user.route.ts`, `routes/base-currency-guard-coverage.e2e.ts`, `services/ingest/index.ts`, `tests/helpers/ingest.ts`, `packages/shared/src/types/ingest.ts` (payload and response types), `i18n/locales/{en,uk}.json` (`ingest.setupCodeUnusable`)

- [x] failing unit tests (red run: 18 of 18 failed on assertions against a signature-only stub):
  - `encodeSetupCode`/`decodeSetupCode` round trip with and without the CF fields;
  - the output is standard base64 (no `-`/`_`) prefixed `v1.`;
  - `v` is checked: an unknown version, a bad prefix, bad JSON, a missing `url`/`token` and an input over 2 KB are rejected;
  - a non-http(s) `url` is rejected
- [x] failing e2e (red run: 27 of 28 new cases failed on assertions, 404 for the missing route; the 401-without-session case held) for `POST /user/settings/card-payments/setup-code`:
  - it returns 201 `{ token, setupCode }` (⚠️ `token` is the new token's listing entry without the secret; the secret exists only inside the code, with `Cache-Control: no-store` on the response); the decoded code has the sent `ingestUrl`, the new secret, and the CF id and secret when stored;
  - with `revokePrevious` (default true) the earlier Apple Pay token stops working;
  - the token list shows the new token without a secret;
  - a second call mints another token, so nothing re-reveals the first;
  - an invalid `ingestUrl` is a 422;
  - the 11th call in a minute is a 429;
  - a demo user is blocked
- [x] the service mints setup-code tokens with `purpose: 'card-payment-setup'` (a server-set column, never client input) so `revokePrevious` targets only those
- [x] guard coverage: exempt with the reason "mints a credential, no monetary data"
- [x] gate (passed: unit 18 tests in 1 suite; e2e 2 suites, 37 passed; typecheck, lint and oxfmt clean): `npm run test:unit -- --testPathPattern='ingest/setup-code'`; `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest/setup-code|routes/base-currency-guard-coverage).e2e'`

### Task 11: The generic shortcut: generator, reviewable plist, served asset

**Files:**

- Create: `packages/frontend/scripts/shortcuts/build-card-payment-shortcut.ts` (uses the `plist` package as a dev dependency)
- Create: `packages/frontend/shortcuts/log-card-payment.plist` (generated XML, committed for review)
- Create: `packages/frontend/scripts/shortcuts/build-card-payment-shortcut.spec.ts`
- Create: `packages/frontend/public/shortcuts/README.md` (how the signed file is made and verified)
- Modify: `packages/frontend/vite.config.js` (vitest `include` adds `scripts/**/*.spec.ts`), `packages/frontend/tsconfig.json` (`include` adds `scripts/**/*.ts`; a separate `tsconfig.scripts.json` referenced by `typecheck` if Node types clash with the DOM lib)
- Modify: `packages/frontend/nginx.conf` (`location /shortcuts/`: `application/octet-stream`, `Content-Disposition: attachment`, short cache), `packages/frontend/package.json` (`shortcuts:build` script)
- Modify: `packages/frontend/src/common/config.ts` (`CARD_PAYMENT_SHORTCUT_ICLOUD_URL` in `AppRuntimeConfig`; getter `cardPaymentShortcutIcloudUrl` = `runtime().CARD_PAYMENT_SHORTCUT_ICLOUD_URL || undefined`, `||` because the entrypoint writes an empty string when unset, as `docsUrl` does; no `VITE_` fallback, since nothing needs it in dev), `self-hosting/frontend/docker-entrypoint.sh` (writes the key into `window.__APP_CONFIG__`). No CI build variable: the value is per instance.

- [ ] ⚠️ capture the identifiers the generator cannot guess:
  - the Wallet transaction input class for `WFWorkflowInputContentItemClasses`;
  - the property names for Amount, Merchant, Card or Pass and Name, and whether the input carries any date of its own (if it does, the idempotency key uses it instead of the run time);
  - the identifiers of the Replace Text (regex) and Generate Hash (SHA-256) actions.
  - How: build a minimal shortcut by hand on the iPhone (Receive Transaction input → a Dictionary of those four properties), share it as an iCloud link, read the unsigned plist through the iCloud shortcut record (a known community technique; verify), convert it with `plutil -convert xml1`, and keep the extract as a fixture: `packages/frontend/scripts/shortcuts/fixtures/transaction-input.xml`.
  - If this is not feasible, build the full shortcut by hand from the manual guide (Task 13), export and sign it, commit its decoded XML in place of the generated one, and mark the generator task ➕ follow-up.
- [ ] failing vitest:
  - the generated plist has exactly one import question bound to the first Text action's `WFTextActionText`;
  - the actions appear in the order from Solution Overview;
  - the body keys equal the server's schema keys (imported from `shared`);
  - the headers include `Authorization`, `CF-Access-Client-Id` and `CF-Access-Client-Secret`;
  - a Replace Text action with the regex `^v1\.` sits between the Text action and Base64 Decode;
  - the decode chain, emulated the way the shortcut runs it and **without the shared decoder**: take a code from `encodeSetupCode`, apply the Replace Text action's own pattern and replacement read from the generated plist, `Buffer.from(…, 'base64')`, `JSON.parse`, then read the keys the Get Dictionary Value actions name; it yields the encoded `url`, `token`, `cfAccessId` and `cfAccessSecret`. The same chain on a code without the Replace Text step fails, so the test proves the step is needed;
  - the idempotency key goes through Generate Hash (SHA-256) and the key text joins card, merchant, amount and the key time;
  - the no-input branch sends `dryRun: true`;
  - drift: the committed XML equals the generator output
- [ ] implement the generator: a deterministic UUID per action (seeded), so the XML is stable and diffable
- [ ] vitest for `config.cardPaymentShortcutIcloudUrl`: the runtime value wins, an empty runtime string falls back to undefined (⚠️ the getter, its spec `src/common/config.spec.ts`, the `docker-entrypoint.sh` key and the compose/`.env.example` pass-through were done early in Task 13, whose **Add Shortcut** button reads the getter; what remains for this task is only the line in its gate)
- [ ] gate: `cd packages/frontend && npm run test:unit -- --run scripts/shortcuts/build-card-payment-shortcut.spec.ts src/common/config`; `npm run shortcuts:build` leaves no diff; typecheck (which now covers `scripts/`) and lint
- [ ] the signed `.shortcut` and the iCloud link are made in Post-Completion; until then the **Add Shortcut** button (Task 13) hides itself when the file is absent (a HEAD probe) and the page points to the manual guide

### Task 12: Frontend: Settings → Integrations → Ingest tokens

**Files:**

- Create: `packages/frontend/src/api/ingest.ts`, `packages/frontend/src/pages/settings/subpages/integrations/{index.vue,pages/ingest-tokens.vue,components/create-token-dialog.vue}`
- Modify: `packages/frontend/src/routes/{index,constants}.ts`, `packages/frontend/src/pages/settings/settings.vue`, `packages/frontend/src/common/const/vue-query.ts`
- Create: vitest specs next to the components; `packages/frontend/e2e/tests/integrations/ingest-tokens.spec.ts`

- [x] failing vitest (red runs: the util spec failed 6 of 8 on assertions against a signature-only stub; the composable spec failed 4 of 5 the same way; the two component specs failed to resolve their not-yet-written `.vue` files, which is the red state for a component):
  - the create dialog shows the secret once, with a copy button and a "you won't see it again" note;
  - closing the dialog clears the secret from state and from the vue-query cache;
  - the list renders name, `start…`, scope, last used ("Never" when null) and created;
  - revoke asks for confirmation
- [x] **Integrations** settings group with **Ingest tokens** and **Apple Pay** tabs (container-query layout, Settings conventions from `frontend-rules`) (⚠️ only the Ingest tokens tab exists now: the Apple Pay page is Task 13's, which adds its route and tab entry rather than leaving a dead tab behind)
- [x] i18n `settings.integrations.*` in `en` + `uk` (new chunk `settings/integrations.json` in both locales, `settings.navigation.integrations` in `settings/index.json`, `file-context.json` entry, chunk name in `i18n/types.ts`; written directly, since the `i18n-editor` subagent cannot be spawned in this run)
- [x] Playwright (written and typechecked; not run, the docker dev stack is down): create a token, see it once, reload, see it masked, revoke it (typechecked; run if the docker dev stack is up)
- [x] gate (passed: 4 suites, 32 tests in `integrations/`; full frontend unit run 270 files, 3729 tests; typecheck, lint and oxfmt clean): `cd packages/frontend && npm run test:unit -- --run src/pages/settings/subpages/integrations`; frontend typecheck and lint

### Task 13: Frontend: Apple Pay page with one-tap setup

**Files:**

- Create: `packages/frontend/src/pages/settings/subpages/integrations/pages/apple-pay.vue` and components: `card-links.vue`, `unlinked-cards.vue`, `waiting-payments.vue`, `setup-code-dialog.vue`, `access-headers-form.vue`, `setup-checklist.vue`
- Create: `packages/frontend/src/pages/settings/subpages/integrations/ingest-url.ts` (+ spec)
- Modify: `packages/frontend/package.json` (⚠️ QR library: `uqr@0.1.3`, pinned. A smaller equivalent of `qrcode@1.5.4`: MIT, no dependencies (`qrcode` pulls `yargs`, `pngjs` and `dijkstrajs`), ESM, and its `encode()` returns the module matrix, so the component draws its own SVG path and the secret never passes through `v-html` or a renderer's string output)
- Create: vitest specs; `packages/frontend/e2e/tests/integrations/apple-pay.spec.ts`
- Also created (⚠️ not in the original list): `components/{card-link-dialog,payment-request-summary,unconfirmed-payments,add-shortcut-button,setup-code-qr}.vue`, `composables/{use-generate-setup-code,use-log-waiting-payments,use-shortcut-link}.ts`, `apple-pay.ts` (account filter, shortcut probe and link, reason labels), `qr-code.ts`, `test-support.ts`; `normalizeCardLabel` moved to `packages/shared/src/types/ingest/normalize-card-label.ts` (⚠️ review round 1: was `shared/src/lib/`; the backend re-export file is gone, callers import `@bt/shared/types`) so the frontend matches card labels the way the server does when it retries waiting payments

- [x] failing vitest (red runs: the util specs failed 32 of 44 on assertions against signature-only stubs, `config` 1 of 3, the setup-code composable 3 of 6, the shortcut-link composable 3 of 5 and the log-waiting composable 6 of 7; the component and page specs were written beside their `.vue` files and passed on first run, except the access-headers spec, which caught the secret lingering in the mutation cache and led to a reset after each save):
  - `buildIngestUrl()` returns `${API_HTTP || window.location.origin}/api/v1/ingest/card-payment`;
  - card links: add (account picker limited to owned, active, non-loan/vehicle accounts), rename, re-point, delete;
  - unlinked cards show counts and a **Link** action that pre-fills the label and, after saving, offers **Log N waiting payments** (it calls retry per request);
  - waiting payments: retry and dismiss (interrupted rows included);
  - **Not confirmed by the bank:** lists unconfirmed card-payment plans with date, merchant and amount; **Delete** removes the plan through the existing transaction delete endpoint after a confirmation; hidden when empty;
  - setup:
    - the access-header fields render only when `config.isSelfHost`;
    - the secret field is write-only (a placeholder when configured, **Remove** clears it);
    - **Generate setup code** calls the endpoint and opens a one-time dialog with the code, a copy button and a QR code;
    - closing the dialog drops the code;
    - **Add Shortcut** links the signed file (or the iCloud link when configured, preferred on iOS);
    - the checklist shows three steps: create a Transaction automation in Shortcuts → Automation; choose your cards and **Run Immediately**; select "MoneyMatter: log card payment";
    - a **Test** hint explains that running the shortcut by hand sends a dry run
- [x] link to the docs page (Task 15) for the manual guide (⚠️ `DocsLink` to `/integrations/apple-pay/`, which Task 15 creates; the link 404s on the docs site until then)
- [x] i18n `settings.integrations.applePay.*` in `en` + `uk` (written directly into `settings/integrations.json`, since the `i18n-editor` subagent cannot be spawned in this run; the owner was asleep, so wording was decided from the plan: the `uk` iOS labels in the checklist carry the English label in brackets because the Ukrainian iOS strings were not verified on a device)
- [x] Playwright (`e2e/tests/integrations/apple-pay.spec.ts`: a payment parked by a real ingest call, link the card from the unlinked list, log the waiting payment, generate a setup code, see the QR, copy it, close the dialog and confirm the code is gone, rename and delete a link; written and typechecked, not run: the docker dev stack is down)
- [x] gate (passed: 21 suites, 174 tests in `integrations/` and `common/config`; full frontend unit run 287 files, 3868 passed; typecheck, lint, oxfmt and knip (no finding from this task) clean; backend `ingest/(normalize-card-label|setup-code)` 34 passed, backend typecheck and lint clean after `normalizeCardLabel` moved to `shared`): `cd packages/frontend && npm run test:unit -- --run src/pages/settings/subpages/integrations`; frontend typecheck and lint

### Task 14: Verify acceptance criteria

- [x] a full ingest round trip through HTTP: a token from a setup code (decoded with the shared decoder), a mapped card, a cross-currency payment logged with the right summary, the same key replayed, a parked unknown card logged after linking, and a planned row on a connected account settled by a synced booking at a different amount (verified: `ingest-card-payment.e2e.ts`, `setup-code.e2e.ts`, `processing.e2e.ts`, `merge-card-payment.e2e.ts`, `requests.e2e.ts` pass; the shortcut-generator part is pending Task 11)
- [x] no route authenticated by a token reaches a session route, a password reset revokes the tokens, and the guard invariant covers the ingest route (verified: `session-isolation.e2e.ts`, `password-reset.e2e.ts`, `base-currency-guard-coverage.e2e.ts`)
- [x] backups: a mapping round-trips; tokens, the log and the access headers are not in an export (verified: `card-account-mappings` round-trips in `restore-backup.e2e.ts`; `IngestTokens`, `IngestRequests`, `IngestSettings` sit in `BACKUP_EXCLUDED`, enforced by `registry.unit.ts`)
- [x] backend: `npm run test:unit` (full); `lockf -t 7200 /tmp/mm-e2e.lock npm run test:e2e -- --testPathPattern='(ingest|ingest-tokens|planned-matching|payees|ai-categorization|transaction-automations|backup|mcp|routes/base-currency-guard-coverage)'` (unit 235 suites 3430 passed; e2e 40 suites 475 passed, 1 skipped)
- [x] frontend: `npm run typecheck && npm run lint && npm run test:unit -- --run`; Playwright `integrations/` when the dev stack is up (typecheck, lint, unit 287 files 3871 passed; Playwright `integrations/` 10/10 on a host-run backend and Vite, torn down afterwards)
- [x] root `npm run format:check` and `npm run knip` (`format:check` flags only untracked `.revmux/` files; `knip` is clean for ingest after de-exporting 19 unused symbols; the rest of its backend list (currencies, backup restore, migrations utils) and the frontend `AccountVisual` come from code this branch does not touch)

### Task 15: [Final] Update documentation

- [x] `packages/docs/src/content/docs/integrations/apple-pay.mdx` (new section `integrations`, sidebar group in `astro.config.mjs`), following the `user-docs` skill (written; ⚠️ the one-tap shortcut is described as coming with Task 11: the page gives the manual guide as the current path and keeps one marked Aside plus a `ONE-TAP-SHORTCUT` comment to update when the signed shortcut ships; the page therefore carries no Add Shortcut steps yet):
  - **One-tap setup:** Settings → Integrations → Apple Pay; link your cards; generate the setup code; **Add Shortcut** and paste the code at import (or scan the QR on another phone and copy it); then the three automation steps with exact iOS labels (Shortcuts → Automation → **+** → **Transaction** → choose cards → **Run Immediately** → **Next** → pick "MoneyMatter: log card payment").
  - **Manual guide (fallback):** every action in order with its exact name: Dictionary of Amount, Merchant, Card or Pass, Name from Shortcut Input; Format Date (ISO 8601); Text `<card>|<merchant>|<amount>|<time to the minute>` and **Generate Hash** (SHA-256) for the idempotency key; Get Contents of URL with **Method** POST, **Headers** `Authorization: Bearer <token>` (plus `CF-Access-Client-Id`/`CF-Access-Client-Secret` behind Cloudflare Access), **Request Body** JSON with each key mapped to its variable; Get Dictionary Value `response` → `summary`; Show Notification.
  - **Test request:** a `curl` with `dryRun: true`, then a real one, and the expected responses.
  - **What happens to a payment:** card links, waiting payments and why, categories in order, foreign currencies, bank-connected accounts (planned until the bank confirms; a different settled amount merges only when the bank's merchant text shares the merchant's words; plans the bank never confirms within 7 days appear under **Not confirmed by the bank**; the EnableBanking pending-amount limit), repeats (a second identical payment on the same card at the same merchant within two minutes reads as a repeat: add it by hand).
  - **Troubleshooting:** a 401 (token), a 403 from Cloudflare (service token or policy), an empty amount from iOS, a renamed card.
  - **iCloud link:** say plainly that a shareable link cannot be generated by the app; the maintainer makes it once.
  - screenshots per the skill (the integrations pages with the docs test user), both themes (skipped - not automatable here: the dev stack is down and the Mac is short on memory; three `<Screenshot>` tags with `alt` and `hint` are in place (`integrations/ingest-tokens`, `integrations/apple-pay-card-links`, `integrations/apple-pay-waiting`), missing images are hidden in the production build, and `npm run screenshots:missing` lists them for the owner)
- [x] `packages/docs/src/content/docs/integrations/ingest-tokens.mdx`: what a token can do (only `ingest:transactions`), shown once, revoke, last used, revoked by a password reset
- [x] `packages/backend/docs/card-payment-ingest.md`: the API reference (request, key rule, currency resolution, responses, idempotency and the repeat window, parking, settlement), for other clients
- [x] `self-hosting/docs/environment-reference.md` and `getting-started/self-hosting.mdx` (also a "Proxies with access control" section in `self-hosting/docs/reverse-proxies.md`): `CARD_PAYMENT_SHORTCUT_ICLOUD_URL` as a runtime env var of the frontend container; a note on reverse proxies with access control (path-scoped service auth for `/api/v1/ingest/`)
- [x] `cd packages/docs && npm run build`; the link validator passes (43 pages built, "All internal links are valid"; `npm ci` was needed first, `packages/docs` is a standalone project with no installed dependencies)
- [ ] move this plan to `docs/plans/completed/` after Task 14 passes (waits for Task 11, which stays open until the shortcut export exists; then update the `ONE-TAP-SHORTCUT` section of `apple-pay.mdx` and the Add Shortcut text, and move the plan)

## Post-Completion

_Items requiring manual work or external systems; no checkboxes._

**Sign the shortcut (orchestrator, on the owner's Mac):**

- Check that `shortcuts sign` works on the generated file: `shortcuts sign --mode anyone --input packages/frontend/shortcuts/log-card-payment.plist --output packages/frontend/public/shortcuts/moneymatter-log-card-payment.shortcut`. Convert to a binary plist first if the CLI refuses XML. Signing for "anyone" needs the Mac signed in to an Apple ID; check what identity the signature exposes before committing it to a public repo.
- AirDrop the file to the iPhone, import it, paste a setup code from the dev or ritchie instance at the import question, and run it once by hand: the notification shows the dry-run line.
- Optional: share the imported shortcut from the iPhone to get an iCloud link; set `CARD_PAYMENT_SHORTCUT_ICLOUD_URL` in the frontend container's environment on the owner's instance (read at container start, no rebuild). An iCloud link still asks the import question, so the setup code works the same way.
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

- Build images from this branch, back up the database, migrate, and set `CARD_PAYMENT_SHORTCUT_ICLOUD_URL` on the frontend container if a link exists.

**Bank-sync plan (TBC, separate):**

- When the TBC account becomes connected, new card payments are planned rows that its sync settles (Task 9). Payments logged while the account was manual are real rows; that plan decides how its historical backfill matches them (for example by `externalData.cardPayment` + amount + date) instead of duplicating them.

**Upstream:**

- Open a discussion with the maintainer about personal API tokens (the `IngestTokens` table, and why not the API-key plugin), the generic ingest endpoint and the shortcut asset, and whether it is a paid-plan feature on the cloud. Sign the CLA (`CLA.md`).
- Offer it as PRs in order: tokens + endpoint + processing (Tasks 1–10); the shortcut asset and the Settings UI (Tasks 11–13); docs.
