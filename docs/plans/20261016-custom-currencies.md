# Custom currencies with per-currency precision and rate sources

## Overview

MoneyMatter stores every transactional amount as 2-decimal integer cents, accepts only ISO 4217 currency codes, and gets rates only from fiat providers. That makes crypto and other non-ISO units impossible to track: `0.00040641 BTC` rounds to `0.00`, `USDT` fails validation (and does not fit the `varchar(3)` code columns), and there is no rate source for it.

This plan delivers three features, in three phases that each leave the app working and can each become a separate upstream PR:

1. **Per-currency precision.** Money moves from BIGINT cents to DECIMAL storage, and each value is rounded to its currency's own number of decimals (USD 2, JPY 0, KWD 3, BTC 8, USDT 6).
2. **Per-user custom currencies.** A user defines codes such as USDT, USDC, BTC, ETH or SAT with their own name, symbol and **number of decimals**, the same way they own categories. Other users never see them, and two users can define the same code differently.
3. **Pluggable rate sources** per custom currency: manual dated rates, a peg to another currency (USDT = 1 USD), CoinGecko, and a generic HTTP/JSON source. When a custom currency's source changes, saved transactions in that currency get their base-currency amounts recomputed.

Motivation: importing an existing ledger (1932 rows, 44 accounts including USDT, USDC, BTC and ETH accounts) without losing data. The work happens in a fork on `feat/custom-currencies` and is offered upstream as a feature request.

## Context (from discovery and review round 1)

- **Money core:** `packages/backend/src/common/types/money.ts` (Big.js-backed `Money`), `packages/backend/src/common/types/money-column.ts` (`@MoneyField`, with `storage: 'cents'` mapping to BIGINT and `'decimal'` to DECIMAL).
  - 33 `storage: 'cents'` fields across 13 models: accounts (6), balances, budget-assignments (2), budget-line-goals (3), budget-plans, budget, import-batch-account-effects, loan-details (6), subscriptions, transaction-splits (2), transaction-templates, transactions (6), vehicles (2).
  - 29 fields already use `storage: 'decimal'` (investments, `DECIMAL(20,10)` and one `(36,18)`). This existing path is what phase 1 builds on.
- **Cents outside `@MoneyField`:**
  - `SubscriptionCandidates.averageAmount` (BIGINT cents, `subscription-candidates.model.ts:37-42`);
  - tag-reminder `settings.amountThreshold` (cents in JSON, `tag-reminders.serializer.ts:93,150`);
  - `LoanDetails.events` JSONB fields read with `fromCents`/`toCents` (`packages/shared/src/types/loans.ts:27-44`);
  - budget-plan goal amounts read with `Money.fromCents` in `data-export/transformers/budget-plans-transformer.ts:50`;
  - the Redis ref-amount cache (`calculate-ref-amount.service.ts:13-17,40-41,73,77,104`), keyed by and storing `toCents()`.
- **Raw cents arithmetic:**
  - 252 `raw: true` queries outside migrations and tests, plus about 20 money `SUM(...)` aggregates.
  - `literal('amount + ${toCents()}')` in `balances.model.ts:445,484`.
  - `Money.fromCents` on dataValues in a `transactions.model.ts:579-587` hook.
  - A `::bigint` sum and raw `INSERT INTO "Balances"` in `revalue-balance-history.service.ts`.
  - `Math.round(x*100)` in `parse-amount.ts:59` and in `round-currency.ts:8`.
- **The `real_transactions` view** (`migrations/20260813000000-create-real-transactions-view.ts:6-12`, helpers in `migrations/utils/real-transactions-view.ts`) depends on `Transactions` columns.
  - Postgres refuses to change the type of a column a view depends on, so every column-type migration must drop the view first and recreate it afterwards, keeping the `deletedAt` filter (`20260928000000-add-transactions-soft-delete.ts:33`). `20260911000000-add-transaction-detail-fields.ts` is the pattern to follow.
- **Backups:**
  - Dumps are `raw: true` (`services/backup/dump-tables.service.ts:134`), and restore writes money values verbatim (`services/backup/restore/bulk-insert.ts:33-36`).
  - `BACKUP_FORMAT_VERSION` is 1 (`packages/shared/src/types/backup.ts:16`).
- **Currencies:**
  - The global `Currencies` table (`code varchar(3)` primary key, `currency` NOT NULL, `digits`, `number` NOT NULL, `isDisabled`) is referenced by foreign keys from about 15 tables, and has 21 `STRING(3)` model columns. `UsersCurrencies` is the per-user list (`isDefaultCurrency`, `liveRateUpdate`).
  - **Global readers of the table:**
    - `getAllCurrencies` (`currencies.model.ts:82-91`), which backs the public `GET /currencies`;
    - the registry's coverage set (`registry.ts:113,137-148`);
    - fawaz and ApiLayer `validCodes` (`Currencies.findAll()`);
    - the historical initializer.
  - **Currency-code validation:**
    - `common/lib/zod/custom-types.ts` `currencyCode()` (`.length(3)` + `cc.code()`);
    - `boundedDecimalAmount` (`custom-types.ts:63-66`, at most 2 decimals);
    - `csv-import/extract-unique-values/validate-currency.ts:11`, `ofx-import/mapping.ts:225`, `ynab-import/parse-ynab.service.ts:407`, `simplefin.provider.ts:1033`;
    - `monobank.provider.ts` (ISO numeric codes);
    - `statement-parser/extraction-prompt.ts`.
- **Rates:**
  - `services/exchange-rates/` holds the provider registry (`providers/{currency-rates-api,fawaz-currency-api,api-layer}`, `registry.ts`, `merge-provider-rates.ts`), `build-daily-pair-rate-resolver.ts` (with `formatRate` truncating to 5 decimals, `:12`), `get-exchange-rates-for-date.ts` and `sync-exchange-rates.ts`.
  - **Per-user rates have limits** (`services/user-exchange-rate/`, `UserExchangeRates`):
    - `date` is only the `createdAt` timestamp, and `getRates` takes no date;
    - `updateRates` overwrites every row of a pair;
    - `resolveCustomRate` (`get-exchange-rate.service.ts:141-149`) applies only when `liveRateUpdate === false` and the quote is the user's base.
  - `crossRateCache` (`get-exchange-rate.service.ts:14-28`) is not user-scoped. `revalue-accounts-in-currencies.ts` only schedules balance-history rebuilds; it never touches `Transactions`.
  - Converted amounts are rounded half-to-even (`calculate-ref-amount.utils.ts:24-28`, `balances.model.ts:254`).
- **Base currency:** `services/currencies/change-base-currency.service.ts` (`rebuildTransactions`, `:334-387`) converts every transaction with `getExchangeRate` before flipping the base.
- **refAmount nullability:** `Transactions.refAmount`, `TransactionSplits.refAmount`, `refCommissionRate` and `Accounts.refCurrentBalance` are NOT NULL. A missing rate throws `ExchangeRateUnavailableError` through `calculateRefAmount`.
- **Outbound HTTP guard:** `common/utils/url-guard.ts` (`assertSafeOutboundUrl`, `isPublicIpAddress`, `createGuardedFetch`, with a self-host/development bypass, DNS checks and credential rejection; accepts http and https).
- **Frontend:** formatting in `frontend/src/js/helpers/formatters.ts` and `frontend/src/composable/formatters.ts` (`Intl.NumberFormat` currency style, which throws on non-ISO codes), plus 6 component-level formatters.
- **Docs that describe current behavior:** `packages/docs/src/content/docs/settings/base-currency-and-currencies.mdx` (custom rate applies to all dates, set against the current base, saved transactions keep their base amounts), `packages/backend/docs/exchange-rates.md`.
- **Conventions (repo CLAUDE.md):**
  - Object params and kebab-case files.
  - Every new endpoint needs e2e tests through HTTP helpers, using the `test-runner` subagent, never in parallel.
  - Change unmerged migrations rather than adding new ones.
  - i18n through the `i18n-editor` subagent, always `en` plus `uk`.
  - API and frontend always work in decimals.
  - Comments describe the current code.
  - Stop and ask after 1–2 failed fix attempts.

## Development Approach

- **Testing approach:** phase 1 is test-first (TDD), because the refactor touches the money core and silent corruption is the main risk. Phases 2–3 are regular: code first, then tests within the same task.
- **Test gates name exactly which tests must pass.** A test written ahead of the code it needs is marked with the task that makes it pass, as the planning rules' "partial implementation" exception allows.
- Complete each task fully before moving to the next, with small, focused changes.
- **Every task includes new or updated tests** for the code it changes, covering both success and error scenarios. All tests named in a task's gate must pass before the next task starts.
- **Keep this plan current:** update it when scope changes during implementation.
- **No behavior change for ISO-only users:**
  - Existing cents data migrates losslessly (value / 100), and old backups restore correctly.
  - API payloads keep decimal numbers.
  - Rounding modes stay what they are today: amounts the user enters round half-up as `toCents()` does now, and converted amounts round half-even.
  - The only visible change is correct precision for 0- and 3-decimal ISO currencies (JPY, KWD and others).
- **Commits:** none unless the user asks. One phase maps to one future PR.
- **Where tests run:** run e2e and build verification on ritchie (x86, 12 GB) when the Mac's Docker runs out of memory.

## Testing Strategy

- **Backend unit tests** (`npm run test:unit` in `packages/backend`): the precision and rounding helpers, rate-source resolvers, recompute selection, HTTP source templating and JSON-path extraction, and the backup v1 conversion mapping.
- **Backend e2e** (`npm run test:e2e` in `packages/backend`, through HTTP helpers only): every new or changed endpoint, covering happy path, empty state and an error case. Backup restore is tested by restoring a v1 fixture archive through the restore endpoint.
- **Migration round-trips:** e2e tests cannot run a migration down and up. A scripted check (`scripts/check-money-migration.ts`, run against a disposable Postgres) seeds rows, runs `up`, `down` and `up` again, and asserts the values; its output is recorded in this plan.
- **Frontend unit tests** (`npm run test:unit` in `packages/frontend`): formatters for ISO and custom codes at 0, 2, 3, 6 and 8 decimals; amount input precision.
- **Frontend Playwright e2e** (`packages/frontend/e2e`): creating a custom currency, a transaction in it, and configuring a rate source.
- **Typecheck and lint** in both packages after every task.

## Progress Tracking

- Mark completed items `[x]` immediately.
- Prefix newly discovered tasks with ➕ and blockers with ⚠️.
- Keep this plan in sync with the actual work.

## Solution Overview

### Phase 1: precision

- **Storage:**
  - The 33 cents fields become `@MoneyField({ storage: 'decimal', precision: 36, scale: 18 })`: 18 integer digits, so no VND/IDR overflow, and 18 decimals.
  - The non-`@MoneyField` cents stores move to decimals as well: `SubscriptionCandidates.averageAmount` becomes `DECIMAL(36,18)`, and the JSON/JSONB fields are rewritten in the same migration.
  - The Redis ref-amount cache switches to exact decimal strings under a new key namespace (`ref_amount:v2:`), so entries written before the deploy are never read.
- **Migration:**
  - One migration drops `real_transactions`, converts every column with `USING col::numeric / 100`, rewrites the JSON fields, and recreates the view with its `deletedAt` filter.
  - `down` reverses all of it with `round(col * 100)::bigint`. That is lossy for values with more than 2 decimals, which is documented in the migration header.
- **Backups:** `BACKUP_FORMAT_VERSION` becomes 2. Restoring a v1 archive divides the migrated money columns and JSON fields by 100, using one shared column list that the migration also imports, so the two cannot drift.
- **Precision source:** `getCurrencyDecimals({ userId, code })`.
  - It returns the user's `UsersCurrencies.decimalsOverride` when one exists (phase 2), and otherwise `Currencies.digits`.
  - The cache is keyed by `userId + code` and invalidated whenever a currency or override changes.
  - Phase 1 ships the user-aware signature, so phase 2 only adds the override lookup.
- **Transition:** moving to DECIMAL removes the implicit 2-decimal half-up rounding the cents setter applies today. A transitional `roundOnWrite: 2` setter option keeps it until Task 7 rounds every write path per currency.
- **Rounding:** `roundToCurrency({ money, userId, currencyCode, mode })`. `mode` is `'half-up'` for amounts the user or an import provides, which matches `toCents()` today. It is `'half-even'` for converted values (`refAmount`, `refCommissionRate`, balance revaluation), which matches `calculate-ref-amount.utils.ts` today. Computed values are rounded once, at write time.
- **Audit:**
  - Every raw read of a migrated value switches from `Money.fromCents` to `Money.fromDecimal`, and every raw write or SQL expression loses its ×100, /100 or `::bigint`.
  - The per-task file lists come from the actual `rg -c 'fromCents|toCents|Cents\b'` distribution, not from guessed directories.
  - `toCents`/`fromCents` remain only where an external source really is in cents, such as provider APIs that return minor units. Nothing is deleted as dead without a reference count of zero.

### Phase 2: custom currencies

- **Registry:** the global `Currencies` table holds the codes, so existing foreign keys stay intact. New columns: `isCustom boolean`, `symbol varchar(8) null`, `createdByUserId int null`. `number` becomes nullable, so custom rows store `null` and can never match an ISO numeric code (monobank looks codes up by `number`).
- **Per-user ownership:**
  - `UsersCurrencies` gains `nameOverride`, `symbolOverride` and `decimalsOverride`.
  - A custom code is visible only to users whose `UsersCurrencies` include it. Defining a code that already exists globally reuses the row and attaches the user's own overrides.
  - **Precision is per user** (`decimalsOverride`). A user can change it only while none of their own rows use the currency.
  - **Shared accounts:**
    - The account owner's definition of the code (name, symbol, decimals) governs every native amount on that account, whoever enters it: `amount`, `commissionRate`, `cashbackAmount`, splits and the account's balances.
    - The author's settings govern only the author's reference values (`refAmount` in the author's base), which is how `create-transaction.ts:398-445` and `:524-544` already split owner and author.
    - A collaborator whose own definition of the same code differs sees that account's amounts with the owner's decimals.
- **Backups of custom currencies:**
  - `services/backup/registry.ts:570` excludes `Currencies`, because today every code is seeded.
  - The backup now also exports the user's referenced custom definitions: the code, `isCustom` and the user's overrides, plus the rate-source config in phase 3.
  - Restore resolves or creates those global rows before restoring `UsersCurrencies`, accounts and transactions.
- **Isolation, before any custom row can exist:**
  - `getAllCurrencies` and the public `GET /currencies` exclude `isCustom` rows.
  - So do the registry's coverage set, the fawaz and ApiLayer `validCodes`, and the historical initializer.
  - So a custom code never counts toward provider coverage and never receives global market rates.
- **Code columns:** widen the 21 `varchar(3)` currency-code columns to `varchar(16)`. That means dropping and recreating `real_transactions`, and handling the foreign keys in dependency order. `down` refuses to run while custom codes exist.
- **Validation:**
  - `currencyCode()` checks the format `^[A-Z0-9]{2,16}$`, and services check that the code exists and is visible to the requesting user.
  - The CSV, OFX, YNAB and SimpleFIN importers use the shared format and visibility check instead of their own 3-letter patterns. ISO-only checks remain only for monobank's numeric mapping.
- **Missing rates:**
  - `refAmount` and `refCommissionRate` become nullable on `Transactions` and `TransactionSplits`. On `Accounts`, `refCurrentBalance`, `refInitialBalance` and `refCreditLimit` become nullable too, because account creation (`accounts.service.ts:219-240`) and base change (`change-base-currency.service.ts:460-491`) compute them through `calculateRefAmount`.
  - A new boolean `refAmountMissing` on `Transactions` drives a review badge.
  - `calculateRefAmount` catches `ExchangeRateUnavailableError` **for custom codes only**: it stores `null` and sets the flag. ISO codes keep throwing as today.
  - Every reader that assumes `refAmount` is a `Money` handles `null`: balance hooks, `Balances` updates, stats sums, budgets and exports. The full caller list is enumerated in Task 13.
- **Cross-rates:** conversions involving a custom code never go through `computeCrossRate`/`crossRateCache` (that cache is keyed only by date and code). They resolve through the user's own rate source.
- **Base-currency change:**
  - **Where custom codes may be used in this iteration:** accounts and their transactions, splits, transfers, refunds, subscriptions and budgets. Portfolios, investment transactions, ventures, vehicles and loans keep ISO-only validation, so their ref fields (`LoanDetails.refOriginalPrincipal` and others, the investment `ref*` fields) never meet a missing custom rate. A follow-up can lift this.
  - A custom currency cannot become the base. A user who holds custom currencies can still change base:
    - **Custom rates are never rewritten on a base change.** A user's rate for a custom code stays in its original quote currency (e.g. USDT → USD). Every lookup, during the rebuild and afterwards, crosses via that quote into the current base, using the normal ISO resolution of that quote into the base for the transaction's own date (`getExchangeRate`, so a manual ISO rate the user set for that pair wins, otherwise the market rate).
    - In phase 2 the custom rate itself is the undated `UserExchangeRates` row. Phase 3 makes it dated and source-aware, without changing the crossing rule;
    - `rebuildTransactions` resolves custom legs this way, so transactions converted during the rebuild and those entered afterwards use the same path. ISO user rates keep today's documented rule: they stay as they are and apply again if the user switches back;
    - a missing custom rate yields `null` plus the flag instead of throwing and aborting the change.

### Phase 3: rate sources

- **Dated user rates:**
  - `UserExchangeRates` gains an `effectiveDate` (date) column in its key, plus `source`.
  - **For custom codes:**
    - `getRates`, `updateRates` and `resolveCustomRate` become date-aware, taking the latest rate on or before the date.
    - They no longer depend on `liveRateUpdate` or on the quote being the base.
    - A cross-rate can use the user's custom → stored-quote rate together with the normal ISO resolution (manual ISO rate if set, otherwise market) for the rest.
  - **ISO codes keep today's documented semantics:** a user's manual rate applies to every date, and the latest row wins regardless of the transaction date.
  - `buildDailyPairRateResolver` and `revalue-balance-history` use per-day user rates.
- **Rate precision:** rates from custom sources are kept at full precision (at least 12 significant digits) and are not passed through `formatRate`'s 5-decimal truncation. Only the resulting money amount is rounded.
- **Configuration:** `UsersCurrencies` gets `rateSource` (`provider` | `manual` | `peg` | `coingecko` | `http`) and `rateSourceConfig jsonb`. `provider` is the default and keeps today's behavior for ISO currencies.
  - **manual:** dated rates entered by the user.
  - **peg:** `{ pegCurrency, factor }`. The resolver computes `factor × rate(pegCurrency, date)` when asked, and nothing is stored. Peg cycles are rejected.
  - **Synced sources quote in a fixed currency:** CoinGecko and HTTP store rates in their configured quote currency (`quoteCurrency`, default USD), whatever the user's base. A base change needs no re-fetch, because the resolver crosses from the stored quote.
  - **coingecko:** `{ coinId, quoteCurrency }`. History is backfilled when configured, then synced daily, through the existing CoinGecko client. Fetches are deduplicated by `coinId` per day and stored per user with `source='coingecko'`.
  - **http:** `{ urlTemplate, jsonPath, quoteCurrency, headers? }`, with `{date}`, `{code}` and `{quote}` placeholders. Has a test-fetch preview and a daily sync.
- **Recompute (custom currencies only):**
  - A transaction's `refAmount` is computed once, at write time, from the rate effective on the transaction's own date, and then stored.
  - A new day's rate never touches older transactions: the daily sync adds a rate for a new date, which only fills rows on that date still flagged `refAmountMissing`.
  - A recompute happens only when the effective rate for an already-covered date changes: the user switches source, a backfill writes dates that were missing, or a manual rate for a past date is edited.
  - The affected set is expanded through the user's peg and quote dependencies first, so a USDC pegged to USDT is recomputed when a historical USDT rate changes.
  - It touches that user's rows in the affected currencies and only on the dates whose effective rate changed: `refAmount`, `refCommissionRate`, split ref amounts, account ref balances and `refAmountMissing`. Then it schedules the balance-history rebuild.
  - ISO currencies keep the documented rule that saved transactions keep their base amounts.
- **HTTP safety:** the HTTP source uses `createGuardedFetch` from `common/utils/url-guard.ts`, with the same self-host bypass as custom AI endpoints. A thin wrapper adds a 5-second timeout, a 256 KB response limit, and https-only while the guard is active. When the self-host bypass is on, http is allowed, matching the existing guard.

## Technical Details

- **Decimal type:** `DECIMAL(36,18)`. The JS API keeps sending JSON numbers; inputs beyond float precision are out of scope and documented.
- **Shared column list:** `packages/backend/src/common/lib/money-columns.ts` exports the list of migrated tables, columns and JSON paths. The phase 1 migration and the backup v1 converter both import it.
- **Migrations:** three files, one per phase.
  - Phase 1: money storage, plus the JSON rewrites and the view drop/recreate.
  - Phase 2: currency registry and code width, nullable ref columns and `refAmountMissing`, plus the view drop/recreate.
  - Phase 3: dated user rates and rate-source columns.
- **API (phase 2):**
  - `POST /user/currencies/custom` (`code`, `name`, `decimals` 0–18, `symbol?`).
  - `PUT /user/currencies/custom/:code`. Changing decimals is allowed only while none of the user's rows use the currency.
  - `DELETE /user/currencies/custom/:code`, only if unused by the user.
  - The user's currency list endpoints return `isCustom`, `symbol` and `decimals` with overrides applied.
- **API (phase 3):**
  - `PUT /user/currencies/:code/rate-source`.
  - `POST /user/currencies/:code/rate-source/test`.
  - The manual-rate endpoints gain `effectiveDate`.
- **Frontend formatting:** ISO codes keep `Intl` currency style. Custom codes use `Intl` decimal style with the user's decimals plus the symbol (or the code). Amount inputs accept up to the currency's decimals.

## What Goes Where

- **Implementation Steps:** all code, migrations, tests and docs in this repo.
- **Post-Completion:** deployment on ritchie, the ledger import script, and upstream discussion and PRs.

## Implementation Steps

### Phase 1: per-currency precision (TDD)

### Task 1: Precision helper stubs and failing tests

**Files:**

- Create: `packages/backend/src/common/lib/currency-precision.ts` (stubs)
- Create: `packages/backend/src/common/lib/currency-precision.unit.ts`
- Create: `packages/backend/src/controllers/transactions.controller/currency-precision.e2e.ts`

- [x] create stubs for `getCurrencyDecimals({ userId, code })` (always returns 2) and `roundToCurrency({ money, userId, currencyCode, mode })` (always rounds to 2, half-up), so the tests compile and fail on assertions (both are `async`, since the real versions read `Currencies.digits`)
- [x] unit tests (mock `Currencies.findOne`; 11 cases): USD 2, JPY 0, KWD 3; an unknown code → error; half-up versus half-even at an exact tie
- [x] e2e **storage** cases (pass at Task 7, skipped until then, because the transitional `roundOnWrite: 2` from Task 3 still rounds to 2 decimals): KWD transaction `1.234` reads back `1.234`; a KWD balance after several transactions equals the exact sum
  - ⚠️ marked with `it.skip` (through the `itPerCurrencyRounding` alias) instead of `it.todo`: jest's `it.todo` takes no body, and the verified bodies must survive until Task 7. Every "stay `it.todo`" in Tasks 5-7 means "stay skipped", and Task 7 flips the alias to `it`.
- [x] e2e **rounding** cases (pass at Task 7, skipped until then): JPY `1500.6` → `1501`; for a user whose base is KWD, a JPY transaction's `refAmount` is rounded half-even to 3 decimals
  - ⚠️ KWD is not a supported base-currency change target, so this case provisions a second user whose base is KWD from the start (`provisionSecondUserWithBaseCurrency`) and uses a manual JPY → KWD rate of 0.0005 so that 5 JPY and 15 JPY convert to exact ties (expected 0.002 and 0.008)
- [x] regression guards that already pass today and must keep passing: USD 2 decimals, the half-up side of the tie case, USD `12.176673309` → `12.18`
- [x] run the tests and confirm that every case exercising new behaviour fails on an assertion (JPY 0, KWD 3, the unknown-code error, the half-even tie, the KWD storage cases, JPY `1500.6`, the KWD-base refAmount) and not on setup or a missing module, while the regression guards pass
  - result: unit 11 cases, 8 fail on assertions (JPY 0, KWD 3, unknown code in both helpers, `1.2345` → `1.235` KWD, JPY `1500.6`, half-even tie at USD and at KWD/JPY decimals) and 3 pass (USD 2, USD `12.176673309` → `12.18`, half-up tie); e2e 6 cases, 4 fail on assertions (KWD `1.23` vs `1.234`, balance `3.13` vs `3.128`, JPY `1500.6` vs `1501`, refAmount `0` vs `0.002`) and 2 USD guards pass

### Task 2: Currency precision helpers

**Files:**

- Modify: `packages/backend/src/common/lib/currency-precision.ts`, `packages/backend/src/models/currencies.model.ts`
- Create: `packages/backend/src/common/lib/currency-decimals-cache.ts` (the cache and its invalidation, separate from the helpers so the model hooks do not import a module that imports the model)
- Modify: `packages/backend/src/common/types/money.ts` (`roundHalfEven`)

- [x] implement `getCurrencyDecimals` from `Currencies.digits` (looked up through `Currencies.findOne`, unknown code → `NotFoundError`, misses are not cached), with a cache keyed by `userId + code` and an invalidation hook (`invalidateCurrencyDecimalsCache`, called from `Currencies` `AfterSave`/`AfterDestroy`/bulk hooks; the per-user override arrives in Task 12)
- [x] implement `roundToCurrency` with both modes (`Big.roundHalfUp` and `Big.roundHalfEven`; `Money.roundHalfEven(dp)` added next to `Money.round`)
- [x] check the seeded `digits` against ISO minor units (JPY 0, KWD 3, BHD 3); record a data fix for Task 3's migration if any are wrong
  - result: the seed comes from `currency-codes@2.1.0` data; all 179 rows match ISO 4217 minor units (0: BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF; 3: BHD IQD JOD KWD LYD OMR TND; 4: CLF UYW; the rest 2, the X-codes 0). No data fix is needed in Task 3's migration
- [x] gate: the Task 1 unit tests pass (11 original cases plus 5 cache cases; `Money.roundHalfEven` has 2 unit tests; full backend unit suite green)

### Task 3: Shared money-column list and the storage migration

**Files:**

- Create: `packages/backend/src/common/lib/money-columns.ts`
- Create: `packages/backend/src/migrations/20261016000000-money-columns-to-decimal.ts`
- Create: `packages/backend/scripts/check-money-migration.ts`
- Modify: `packages/backend/src/common/types/money-column.ts` (transitional `roundOnWrite`), the 13 models with `storage: 'cents'`, `subscription-candidates.model.ts`

- [x] `money-columns.ts`: the 33 `@MoneyField` columns, `SubscriptionCandidates.averageAmount`, and the JSON paths (tag-reminder `settings.amountThreshold`, the `LoanDetails.events` money fields, budget-plan goal amounts if stored in cents)
  - result: `MONEY_COLUMNS` has 34 entries (33 `@MoneyField` + `averageAmount`), checked against the migrated schema (every BIGINT money column in `information_schema`). `MONEY_JSON_FIELDS` has 2 entries: `TagReminders.settings.amountThreshold` (object) and `LoanDetails.events[].fromCents/toCents` (array; the keys keep their names, the values become decimals). Budget-plan goals are not JSON (`BudgetLineGoals.amount` is a column), and subscription matching rules and automation conditions already store decimals, so they are not listed. `Users.totalBalance` (INTEGER) is a legacy field outside this list.
  - a unit test (`money-columns.unit.ts`) checks that every listed column is declared as a DECIMAL(36,18) money field and that no model keeps a BIGINT money field
- [x] migration `up`: drop `real_transactions`; `ALTER ... TYPE DECIMAL(36,18) USING col::numeric / 100` for every column; rewrite the JSON paths ÷100; apply any `digits` data fix; recreate the view with its `deletedAt` filter
- [x] migration `down`: the reverse with `round(col * 100)::bigint` and ×100 JSON rewrites, plus a header noting that `down` is lossy past 2 decimals
- [x] switch the 33 `@MoneyField` declarations to `storage: 'decimal', precision: 36, scale: 18`, and `averageAmount` to a decimal money field
- [x] keep today's write behaviour during the transition: add a `roundOnWrite: 2` option to `@MoneyField`'s decimal setter (half-up, like `toCents()`), set it on every migrated field; Task 7 removes it once every write path rounds per currency
- [x] `check-money-migration.ts`: seed rows (including views and JSON), run up, down and up, assert the values; record its output in this plan
  - run with `npm run check:money-migration` against `docker run --rm -d --name mm-migcheck -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16`. It applies the 151 earlier migrations, seeds 32 rows in 15 tables (34 money columns, `real_transactions` with a planned and a soft-deleted row, tag-reminder settings, loan events), then asserts after `seed`, `up`, `down` and `up-again`: column types, every value (`/100` on up, exact restore on down, NULLs kept), the view definition and its row filter, the JSON fields. It also asserts the documented loss (`1.235` goes down as `124`, `-1.235` as `-124`) and that `0.00040641` is stored exactly.
  - output: `Seeded 32 rows into 15 tables (34 money columns).` then `465 checks passed, 0 failed.` A mutation check (changing `/ 100` to `/ 10`) makes it fail, so the assertions bite.
  - foreign keys on the seeded tables are dropped in the throwaway database first, because the seed fills only the columns each row needs and the migration's JSON `UPDATE`s re-validate the keys of rewritten rows
- [x] gate: typecheck, plus a passing migration check
  - result: backend typecheck, lint (exit 0) and the migration check pass; the full backend unit suite is green (182 suites, 2481 tests), so no unit test started failing because of the storage switch
  - ➕ known breakage for Tasks 5-6 (e2e only, not run in this task): every test that reads money through `raw: true` or SQL aggregates now sees decimal strings instead of cents numbers, e.g. `common/types/money-column.e2e.ts` (the "plain cents via raw: true" cases) and any e2e asserting cents; `transactions.model.ts` filter helpers still pass `toCents()` into `Op.between`/`Op.gte` on `amount`/`refAmount` (lines near 1056-1074); `balances.model.ts` literal updates (`amount + ${toCents()}`); `subscriptions/detect-candidates.ts` still writes `averageAmount` in cents (the serializer already reads the decimal); `models/index.ts` documents the INT8 parser as being for cents columns
  - ➕ `Money` write behaviour is unchanged for now: all 34 fields carry `roundOnWrite: 2`

### Task 4: Backup format v2 with v1 conversion

**Files:**

- Modify: `packages/shared/src/types/backup.ts`, `packages/backend/src/services/backup/restore/**`, `services/backup/dump-tables.service.ts`
- Create: a v1 fixture archive and `services/backup/restore/restore-v1-archive.e2e.ts`

- [ ] bump `BACKUP_FORMAT_VERSION` to 2; new dumps write decimals
- [ ] restoring a v1 archive divides the columns and JSON paths from `money-columns.ts` by 100 before the bulk insert
- [ ] e2e: restoring the v1 fixture through the restore endpoint gives the same balances and amounts as the source; restoring a v2 archive round-trips exactly (2-decimal values here; a KWD 3-decimal round trip is added in Task 7 once writes keep 3 decimals)
- [ ] unit test: the v1 converter covers every entry in `money-columns.ts`, and fails if the list grows without a converter rule
- [ ] gate: these tests pass

### Task 5: Audit raw cents handling, part 1

**Files (from the `rg` distribution):**

- Modify: `services/transactions/**`, `controllers/transactions.controller/**`, `services/accounts/**`, `services/balances/**` (including `revalue-balance-history.service.ts`), `models/balances.model.ts`, `models/transactions.model.ts` (hooks), `services/stats/**`, `serializers/**`, `services/calculate-ref-amount*` (Redis cache key and value), transaction linking, `services/currencies/change-base-currency.service.ts`

- [ ] list every hit of `rg -n 'fromCents|toCents|Cents\b|::bigint|::int|\* ?100|/ ?100|literal\(|INSERT INTO|UPDATE "' ` in these paths, and record the before count in this plan
- [ ] switch raw reads of migrated values to `Money.fromDecimal`, and remove ×100, /100 and `::bigint` from raw writes and SQL expressions (`balances.model.ts:445,484`, the transactions hook, the revalue `::bigint` sum and raw `INSERT`)
- [ ] ref-amount cache: key and value become exact decimal strings under `ref_amount:v2:`; one exported helper builds both the key and the invalidation prefix, and every invalidator uses it (`services/user/user-destroy-lifecycle.ts:139`, `change-base-currency.service.ts:926`, and any other `ref_amount:` pattern found by `rg 'ref_amount:'`)
- [ ] e2e: after a backup restore, a transaction with a previously cached amount, pair and date gets the restored rate, not the cached one
- [ ] run the e2e suites for transactions, accounts, balances, stats and base change
- [ ] gate: these pass (all Task 1 e2e cases stay `it.todo` until Task 7)

### Task 6: Audit raw cents handling, part 2

**Files (from the `rg` distribution):**

- Modify: `services/bank-data-providers/**`, `services/{budgets,budget-plans,subscriptions,loans,vehicles,import-export,demo,transaction-automations,tag-reminders,data-export}/**`, `common/loans/projection.ts`, `parse-amount.ts`, `round-currency.ts`, the related serializers

- [ ] same audit as Task 5 for these paths, keeping `toCents`/`fromCents` only where an external API really speaks in minor units, with a comment saying so
- [ ] subscription-candidate detection, tag-reminder thresholds and loan events read decimals after the migration
- [ ] import executors (CSV, text-source, OFX, YNAB, Wallet, MS Money, bank providers) write decimals correctly
- [ ] record the after count of the Task 5 search in this plan, with each remaining hit explained
- [ ] gate: the full backend e2e suite, run serially through `test-runner`, except the Task 1 e2e cases (storage and rounding), which stay `it.todo` until Task 7

### Task 7: Per-currency rounding on write paths

**Files:**

- Modify: transaction create and update, transfers, splits, refund linking, `calculate-ref-amount*`, balance updates, `common/lib/zod/custom-types.ts` (`boundedDecimalAmount`)

- [ ] round every user-provided money write half-up to its currency's decimals, listing each path: transactions (`amount`, `commissionRate`, `cashbackAmount`, `originalAmount`), splits, accounts (`initialBalance`, `creditLimit`), balance adjustment (`targetBalance`), budgets (`limitAmount`), budget assignments and line goals, subscriptions (`expectedAmount`), transaction templates, vehicles (`purchasePrice` and values), loan details, and every import executor; then remove the transitional `roundOnWrite: 2` from Task 3
- [ ] test: a USD account created with `initialBalance: 100.555` stores `100.56`, as today; a KWD account stores `100.555`
- [ ] round converted values (`refAmount`, `refCommissionRate`, balance revaluation) half-even to the base currency
- [ ] make split-sum validation compare rounded values
- [ ] make `boundedDecimalAmount` precision-aware, so a 3-decimal base currency accepts 3 decimals in budget plans
- [ ] tests: transfers between a 0-decimal and a 3-decimal account, plus the Task 1 rounding cases
- [ ] remove the skip (`itPerCurrencyRounding`) from the Task 1 e2e cases (storage and rounding), and add the KWD 3-decimal v2 backup round trip to the Task 4 e2e
- [ ] gate: the backend unit and e2e tests pass, including every Task 1 case

### Task 8: Frontend formatting and inputs by currency decimals

**Files:**

- Modify: `packages/frontend/src/js/helpers/formatters.ts`, `packages/frontend/src/composable/formatters.ts`, the 6 component-level formatters, amount input components (locate them with ast-grep)
- Create/Modify: matching vitest files

- [ ] formatters take the currency's decimals instead of assuming 2
- [ ] amount inputs accept and show up to the currency's decimals
- [ ] vitest: format and parse for JPY, USD and KWD, plus large VND values
- [ ] gate: frontend typecheck, lint and unit tests

### Phase 2: per-user custom currencies

### Task 9: Schema for custom currencies, wider codes and nullable ref amounts

**Files:**

- Create: `packages/backend/src/migrations/20261016010000-custom-currencies.ts`
- Modify: `currencies.model.ts`, `users-currencies.model.ts`, `transactions.model.ts`, `transaction-splits.model.ts`, `accounts.model.ts`, every model with a `STRING(3)` currency column, the shared types

- [ ] migration:
  - drop `real_transactions`;
  - add `Currencies.isCustom`, `symbol` and `createdByUserId`, and make `number` nullable;
  - add `UsersCurrencies.nameOverride`, `symbolOverride` and `decimalsOverride`;
  - widen the 21 code columns to `varchar(16)`, handling the foreign keys;
  - make `refAmount`/`refCommissionRate` nullable on `Transactions` and `TransactionSplits`, make `Accounts.refCurrentBalance`, `refInitialBalance` and `refCreditLimit` nullable, and add `Transactions.refAmountMissing`;
  - recreate the view
- [ ] `down` refuses while custom codes or null ref amounts exist; otherwise it reverses everything
- [ ] update the model declarations (`allowNull` on the ref money fields) and the shared types
- [ ] extend `check-money-migration.ts` with this migration's up, down and up checks
- [ ] gate: typecheck, the migration check, and the e2e smoke tests (currencies, accounts, transactions)

### Task 10: Keep custom codes out of global readers

**Files:**

- Modify: `currencies.model.ts` (`getAllCurrencies`), the currencies controller and route, `services/exchange-rates/providers/registry.ts`, `providers/fawaz-currency-api/**`, `providers/api-layer/**`, `initialize-historical-rates.service.ts`
- Create: `services/currencies/custom-currency-isolation.e2e.ts`, plus unit tests for the registry coverage set

- [ ] exclude `isCustom` rows from `getAllCurrencies` and `GET /currencies`, the registry coverage set, the fawaz and ApiLayer `validCodes`, and the historical initializer
- [ ] e2e: a custom code created directly in the test DB through a helper endpoint is invisible in `GET /currencies` for every user
- [ ] unit tests: provider coverage reaches "complete" and the ApiLayer early stop still fires while custom rows exist; fawaz never ingests a custom code
- [ ] gate: these tests pass, before any endpoint can create custom rows

### Task 11: Currency-code validation from the database

**Files:**

- Modify: `common/lib/zod/custom-types.ts`, controllers that call `currencyCode()`, `csv-import/extract-unique-values/validate-currency.ts`, `ofx-import/mapping.ts`, `ynab-import/parse-ynab.service.ts`, `bank-data-providers/simplefin/simplefin.provider.ts`, `statement-parser/extraction-prompt.ts`
- Create/Modify: the matching unit and e2e tests

- [ ] `currencyCode()` checks the format `^[A-Z0-9]{2,16}$`; a shared service helper checks existence and that the code is visible to the user
- [ ] the four importers use the shared format and visibility check; monobank keeps its ISO numeric mapping
- [ ] the statement-parser prompt and import mapping recognise the user's custom codes
- [ ] tests: format unit tests; e2e rejects another user's custom code and an unknown code (listing the valid ones); a CSV import into a custom-currency account is accepted
- [ ] gate: these tests pass

### Task 12: Custom currency CRUD with per-user decimals

**Files:**

- Create: `packages/backend/src/controllers/currencies/custom-currencies.ts`, `services/currencies/custom-currencies.service.ts`, `services/currencies/custom-currencies.e2e.ts`
- Modify: the currencies routes and serializers, `common/lib/currency-precision.ts` (override lookup and cache invalidation)

- [ ] `POST`: create the global row (`isCustom`, `number` null) or reuse an existing one, then attach it to the user with their overrides
- [ ] `PUT` and `DELETE` with the "only while unused by this user" rules; list endpoints apply the overrides
- [ ] `getCurrencyDecimals` prefers `decimalsOverride`, and every write invalidates the user's cache entry
- [ ] native amounts on an account are rounded with the **account owner's** definition (pass the owner's `userId`, not the author's); reference amounts use the author's base, as today
- [ ] backup: export the user's referenced custom definitions (`services/backup/registry.ts`, `dump-tables.service.ts`); restore creates or reuses the global rows before `UsersCurrencies` and accounts (`restore/restore-tables.ts`)
- [ ] e2e: Alice (SAT, 8 decimals) shares an account with Bob (SAT, 0 decimals); Bob's 1.25 SAT entry is stored as 1.25. A backup of a user with a USDT account restores on a fresh instance with the currency, overrides and account intact
- [ ] block making a custom currency the base currency, and keep ISO-only validation for portfolios, investment transactions, ventures, vehicles and loans (e2e: creating a USDT loan or portfolio → 422)
- [ ] account and transaction payloads carry the account currency's effective metadata **as defined by the account owner** (`decimals`, `symbol`, `isCustom`), so a collaborator's UI can format by the account rather than by its own currency list
- [ ] e2e: happy path, empty state, duplicate code for the same user, another user's code invisible, delete or decimals change while in use → 409, and two users defining SAT with 0 and 8 decimals each storing their own precision
- [ ] gate: these tests pass

### Task 13: Transactions in custom currencies with an explicit missing-rate state

**Files:**

- Modify: `services/calculate-ref-amount*`, `services/user-exchange-rate/get-exchange-rate.service.ts`, and every `refAmount` reader enumerated in the first step
- Create: `services/currencies/custom-currency-transactions.e2e.ts`

- [ ] enumerate every caller of `calculateRefAmount` reachable with a custom code, and every reader that sums or copies the nullable ref fields; record the list in this plan. Starting set from `rg -l calculateRefAmount`:
  - `accounts.service.ts`
  - `accounts/{measure-spot-ref-balance,remeasure-ref-balances,restamp-ref-initial-balance}.ts`
  - `transactions/{create-transaction,update-transaction}.ts`
  - `transactions/splits/manage-splits.ts`
  - `transactions/planned-matching/merge-into-planned.ts`
  - `common/transaction-linking.ts`
  - `subscriptions/{convert-subscription-amount,suggest-historical-matches,matching-engine}.ts`
  - `budget-plans/get-scheduled.ts`
  - `import-export/core/resolve/create-accounts-if-needed.ts`
  - the transfer and refund recommendation controllers
  - plus the balance hooks, `Balances` updates, stats, budgets, exports and serializers
- [ ] `calculateRefAmount`: for custom codes, catch `ExchangeRateUnavailableError` and store `null` plus `refAmountMissing`; ISO codes keep throwing
- [ ] every reader on the list handles `null` (excluded from sums, or with an explicit "incomplete" marker in stats)
- [ ] custom-code conversions bypass `computeCrossRate`/`crossRateCache` and resolve as: the user's custom rate in its stored quote currency, times the normal ISO resolution from that quote to the target currency (`getExchangeRate`, so a manual ISO rate into the base wins, otherwise market) on the transaction's date (this is the single path Task 14 and Task 16 build on)
- [ ] e2e:
  - an 8-decimal BTC round trip and a 6-decimal USDT round trip
  - a USDT→USD transfer with both amounts given
  - a custom transaction with no rate, which is saved, flagged and excluded from stats sums
  - two users with different SAT definitions getting different results
- [ ] gate: the backend unit and e2e tests pass

### Task 14: Base-currency change with custom holdings

**Files:**

- Modify: `services/currencies/change-base-currency.service.ts`, `base-currency-change-drain.ts`, `services/user-exchange-rate/*`
- Create: `services/currencies/change-base-currency.custom.e2e.ts`

- [ ] `rebuildTransactions` and the per-day balance sweep resolve custom legs through the user's rate source, crossing via the source's quote currency into the new base
- [ ] custom legs resolve through the user's undated custom rate in its original quote, crossed into the new base with the normal ISO resolution of quote → new base for the transaction's date (the Task 13 resolver path, not separate base-change code)
- [ ] no user rate row is rewritten by a base change, custom or ISO
- [ ] a missing custom rate gives `null` plus `refAmountMissing` and never aborts the base change
- [ ] e2e: change base while holding a custom-currency account (with a rate, and without one); ISO-only base change is unchanged; a mixed case (custom holding plus an ISO manual rate such as USD → EUR) keeps the ISO rate row unchanged; in the mixed case, a USDT transaction (USDT → USD custom rate 1, manual ISO USD → EUR 0.95, base EUR) is valued with 0.95, the same as a USD transaction
- [ ] `revalueBalanceHistory` and the `revalueAccountsInCurrencies` trigger resolve custom-currency accounts through the same crossing (undated custom rate in its quote × ISO resolution of quote → base, per day), instead of returning `skipped`
- [ ] e2e: after a base change, a custom-currency account's balance history is expressed in the new base
- [ ] gate: the full base-change e2e suite passes

### Task 15: Frontend custom currency management and display

**Files:**

- Modify: the settings currencies page (under `packages/frontend/src/pages/settings`), currency pickers, `formatters.ts` / `composable/formatters.ts`, the transaction list (missing-rate badge)
- Create: the custom-currency dialog component, vitest specs, a Playwright spec under `packages/frontend/e2e`

- [ ] add an "Add custom currency" dialog (code, name, decimals, symbol) and edit/delete actions with the in-use rules
- [ ] formatters: custom codes use decimal style plus symbol or code, never `Intl` currency style; amounts on an account are formatted and input-limited from the **account's** currency metadata (Task 12), not the viewer's own currency list, so a collaborator sees the owner's decimals; a code the viewer has no definition for (auto-connected through sharing) still renders as custom
- [ ] vitest/Playwright: a collaborator whose SAT definition differs from the owner's sees and enters the owner's decimals
- [ ] currency pickers list the user's custom currencies; amount inputs follow their decimals; transactions with `refAmountMissing` show a badge
- [ ] add the i18n keys for `en` and `uk` through the `i18n-editor` subagent
- [ ] vitest for formatters; Playwright: create USDT, create a USDT account, add a transaction, see `12.345678 USDT` and the missing-rate badge
- [ ] gate: frontend typecheck, lint, unit and e2e tests

### Phase 3: rate sources

### Task 16: Dated, user-scoped rate resolution

**Files:**

- Create: `packages/backend/src/migrations/20261016020000-currency-rate-sources.ts` (the `effectiveDate` and `source` columns go here)
- Modify: `models/user-exchange-rates.model.ts`, `services/user-exchange-rate/{get-user-exchange-rates,update-exchange-rates,get-exchange-rate}.service.ts`, `services/exchange-rates/build-daily-pair-rate-resolver.ts`, `services/balances/revalue-balance-history.service.ts`
- Create/Modify: unit and e2e tests

- [ ] migration: `UserExchangeRates.effectiveDate` (date, part of the key; existing rows get their `createdAt` date) and `source`
- [ ] backup restore: before archive schema analysis, archives without `effectiveDate` (v1, and v2 exported before this migration) get it filled from each rate row's saved date using the migration's rule; e2e restores such an archive with non-empty user rates
- [ ] `getRates` and `updateRates` take and write `effectiveDate`; an edit changes only that date's row
- [ ] for **custom codes**, `resolveCustomRate` takes the latest rate on or before the date, ignores `liveRateUpdate` and the quote-is-base condition, and crosses via the stored quote currency
- [ ] for **ISO codes**, behaviour stays date-independent as documented ("a custom rate applies to every date"): the ISO rate UI path writes no `effectiveDate` semantics of its own, and lookups keep using the latest row regardless of the transaction date
- [ ] e2e: an ISO manual rate set today still applies to a transaction back-dated before it
- [ ] keep custom-source rates at full precision (not through `formatRate`); round only the resulting amount
- [ ] the dated resolver keeps the crossing rule: the custom rate effective on the transaction's date (in its stored quote) times the normal ISO resolution from that quote to the current base on the same date; base change therefore needs no extra code here and never rewrites rate rows
- [ ] e2e: USDT → USD manual rate 1 effective Jan 1 and no later row; USD → EUR market 0.8 on Jan 1 and 0.9 on Jan 2; after a base change to EUR, a 10-USDT transaction on Jan 2 is 9 EUR, both when rebuilt and when newly entered
- [ ] e2e: change base while holding a custom currency with a backfilled multi-date rate history; each historical refAmount matches the per-date conversion
- [ ] `buildDailyPairRateResolver` and `revalue-balance-history` use per-day user rates
- [ ] tests:
  - a back-dated transaction uses the rate effective on its date
  - an edit to one date leaves other dates alone
  - a SAT-sized rate (0.000001) converts one million units to exactly 1
  - the existing ISO user-rate behaviour is unchanged
- [ ] gate: these tests and the existing user-exchange-rate e2e suite pass

### Task 17: Rate-source configuration model and endpoint

**Files:**

- Modify: `20261016020000-currency-rate-sources.ts` (`UsersCurrencies.rateSource` and `rateSourceConfig`), `users-currencies.model.ts`, shared types
- Create: `packages/backend/src/controllers/currencies/rate-source.ts`, `services/currencies/rate-sources/index.ts`, `rate-source.e2e.ts`

- [ ] add the columns, plus a zod discriminated union for the config
- [ ] `PUT /user/currencies/:code/rate-source` validates and saves the config only; Tasks 19–21 add the recompute and backfill triggers to this endpoint
- [ ] e2e: each source's valid config; an invalid config → 422; a rate source on an ISO currency → only `provider` or `manual` allowed
- [ ] gate: these tests pass

### Task 18: Manual and peg resolvers

**Files:**

- Create: `packages/backend/src/services/currencies/rate-sources/manual.ts`, `peg.ts`, unit tests
- Modify: the resolver from Task 16

- [ ] manual: dated rates through the extended user-rate endpoints
- [ ] peg: `factor × rate(pegCurrency, date)` computed when asked; reject peg cycles
- [ ] unit tests for both resolvers; e2e: USDT pegged to USD gives `refAmount = amount`; a back-dated manual rate applies to a transaction on its date
- [ ] gate: these tests pass

### Task 19: Recompute base-currency amounts for custom currencies

**Files:**

- Create: `packages/backend/src/services/currencies/recompute-custom-ref-amounts.service.ts`, unit tests, `recompute-custom-ref-amounts.e2e.ts`
- Modify: the rate-source endpoint, the manual-rate endpoints, the backfill completion hooks

- [ ] expand the affected set first: starting from the changed currency and dates, follow the user's reverse peg and quote dependencies (a currency pegged to, or quoted via, a changed one) until no new currency is added, carrying the affected dates along
- [ ] service: for one user, the expanded set of custom currencies and the dates whose effective rate changed, recompute `refAmount`, `refCommissionRate`, split ref amounts, account ref balances and `refAmountMissing`, then schedule the balance-history rebuild
- [ ] every trigger (source change, manual-rate edit, backfill completion, daily-sync fill) clears the user's ref-amount cache through the Task 5 prefix helper after commit, including entries for dependent currencies; the recompute itself calls `calculateRefAmount` with `bypassCache: true`
- [ ] e2e: after correcting a rate, a new transaction with the same amount, pair and date as an earlier one gets the corrected rate
- [ ] trigger it on source change, backfill completion and manual-rate edits for past dates; the daily sync only fills `refAmountMissing` rows on the newly added date; never for ISO currencies
- [ ] unit test: adding a rate for a new date selects no previously valued transaction
- [ ] e2e: USDC pegged to USDT with a dated manual USDT/USD rate of 1; a 10-USDC transaction; correcting that historical USDT rate to 2 recomputes the USDC transaction to 20
- [ ] e2e: create a custom-currency transaction **before** configuring a source (missing state), configure a peg, and check the transaction's `refAmount`, the account's ref balance and the stats; ISO transactions stay untouched
- [ ] gate: these tests pass

### Task 20: CoinGecko rate source

**Files:**

- Create: `packages/backend/src/services/currencies/rate-sources/coingecko.ts`, unit tests, e2e with mocked HTTP (following the existing provider test mocking pattern)
- Modify: cron registration (`crons/`), `services/investments/data-providers/coingecko-provider.ts` (reuse its client; extract it if needed)

- [ ] coin search endpoint for the config UI; history backfill on configure, respecting rate limits
- [ ] daily sync cron, deduplicated by `coinId` per day, storing rates per user in the configured `quoteCurrency` with `source='coingecko'`, then triggering Task 19
- [ ] e2e: change base while a CoinGecko source is configured; no re-fetch happens and refAmounts come out right through the quote crossing
- [ ] tests: the backfill fills dates; a sync failure keeps the last rate and logs; a transaction gets its `refAmount` after the backfill
- [ ] gate: these tests pass

### Task 21: Generic HTTP/JSON rate source

**Files:**

- Create: `packages/backend/src/services/currencies/rate-sources/http.ts`, unit tests, e2e with a local mock server run under `useSelfHost()`
- Modify: the rate-source controller (the test endpoint)

- [ ] URL template substitution (`{date}`, `{code}`, `{quote}`), rates stored in the configured `quoteCurrency`, JSON-path extraction, optional headers (stored encrypted like AI connection keys)
- [ ] fetch through `createGuardedFetch` from `common/utils/url-guard.ts`, with a thin wrapper adding a 5-second timeout and a 256 KB limit, and https-only **only when `isGuardBypassed()` is false**, so self-hosters can reach LAN http endpoints and the e2e mock server works
- [ ] e2e: with the guard on (no `useSelfHost()`), an http URL is rejected
- [ ] `POST /user/currencies/:code/rate-source/test` returns a preview without saving
- [ ] unit tests for templating, path extraction and the wrapper limits; e2e for the preview and a daily sync
- [ ] gate: these tests pass

### Task 22: Frontend rate-source editor

**Files:**

- Modify: the custom-currency dialog or settings page from Task 15
- Create: rate-source form components, vitest specs, a Playwright spec

- [ ] add a source selector with a form per source: dated manual rates, peg (currency plus factor), CoinGecko coin search, HTTP (template, path, headers)
- [ ] add a "Test" button with the previewed rate or the error
- [ ] add the i18n keys for `en` and `uk` through `i18n-editor`
- [ ] Playwright: peg USDT to USD; the missing-rate badge disappears and the totals update
- [ ] gate: frontend typecheck, lint, unit and e2e tests

### Task 23: Verify acceptance criteria

- [ ] BTC `0.00040641`, ETH `0.0109348` and USDT `4.0765` round-trip exactly through the API and UI
- [ ] ISO data is unchanged after migration, with the same rounding as before (spot-check balances before and after on a copy of the ritchie trial database); a v1 backup restores correctly
- [ ] custom currencies are isolated per user (including decimals); rate sources work; missing rates are explicit and get recomputed once a source exists; changing the base currency works with custom holdings
- [ ] full backend suite: `npm test` in `packages/backend` (lint rules, unit, e2e)
- [ ] frontend: `npm run typecheck && npm run lint && npm run test:unit && npm run test:e2e` in `packages/frontend`

### Task 24: [Final] Update documentation

- [ ] `CLAUDE.md` rule 6 (Money convention): decimal storage, per-currency rounding modes, `money-columns.ts`
- [ ] `packages/docs/src/content/docs/settings/base-currency-and-currencies.mdx`: precision, custom currencies, dated rates, rate-source badges, and that custom-currency transactions get their base amounts recomputed (ISO currencies keep theirs)
- [ ] `packages/backend/docs/exchange-rates.md`: custom sources, the role of `UserExchangeRates` (dated, per user), exclusion of custom codes from provider sync, full-precision custom rates
- [ ] new docs pages under `packages/docs/src/content/docs/settings/` for custom currencies and rate sources; `self-hosting` docs for the HTTP source under `IS_SELF_HOST`
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

_Items requiring manual work or external systems; no checkboxes._

**Deployment on the ritchie trial instance:**

- Build images from this branch (`self-hosting/docker-compose.build.yml`) on ritchie, and back up the trial database before migrating.
- Configure USDT/USDC (peg to USD), BTC/ETH (CoinGecko) and the other ledger currencies.

**Ledger import (separate script, outside this repo):**

- Import from the `bt` export, with the user-approved category, payee and account-group mapping:
  - account-currency amounts 1:1, with `originalAmount`/`originalCurrencyCode` for cross-currency rows;
  - transfers paired by description and timestamp, with fees as their own rows;
  - Sheets "Balance initialization" rows imported as ordinary transactions under Adjustments, not as opening balances.
- Check the derived balances against the Sheets Balances sheet.

**Upstream:**

- Open a discussion or feature request with letehaha before any PR, and sign the CLA (`CLA.md`).
- Offer one PR per phase, in order. Phase 1 is useful on its own (JPY/KWD correctness).
