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
- **Rounding on write:** moving to DECIMAL removed the implicit 2-decimal half-up rounding the cents setter applied. Every write path now rounds to its currency's decimals before the value reaches a model (Task 7); the `@MoneyField` setter stores what it is given.
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

- [x] bump `BACKUP_FORMAT_VERSION` to 2; new dumps write decimals
  - result: `BACKUP_FORMAT_VERSION = 2` (the doc comment lists what each version means). Dumps need no code change: the `raw: true` dump already returns the DECIMAL columns as exact strings (`"1500.750000000000000000"`) and the JSON fields as decimals; the dump comment now says so
- [x] restoring a v1 archive divides the columns and JSON paths from `money-columns.ts` by 100 before the bulk insert
  - result: `restore/convert-v1-money.ts` builds one rule per `MONEY_COLUMNS` and `MONEY_JSON_FIELDS` entry (SQL table to backup file via the registry, SQL column to model attribute) and `loadBackupArchive` runs it for every archive with `formatVersion < 2`, after the checksum check and before the column analysis. Columns become exact decimal strings (`Big`, `toFixed()`), JSON amount keys become JSON numbers, `null` and absent values stay, and a non-numeric cents value is a 422
- [x] e2e: restoring the v1 fixture through the restore endpoint gives the same balances and amounts as the source; restoring a v2 archive round-trips exactly (2-decimal values here; a KWD 3-decimal round trip is added in Task 7 once writes keep 3 decimals)
  - result: `restore-v1-archive.e2e.ts` (7 cases) restores the committed fixture `restore/fixtures/backup-v1/` (3 accounts including a negative -1234566431.87 balance and a USD account, 3 transactions with commission and original amount, a split, 4 balances, a tag reminder, a loan with events, a tracker, a subscription, a template), re-exports it and asserts every amount against the cents in the fixture divided by 100; the accounts endpoint serves the same balances; the exported v2 archive restores and re-exports identically for every data file
  - ➕ `GET /transactions` answers 500 until Task 5 fixes its raw reads, so the e2e asserts transactions through the re-export instead of the transactions endpoint
- [x] unit test: the v1 converter covers every entry in `money-columns.ts`, and fails if the list grows without a converter rule
  - result: `convert-v1-money.unit.ts` (13 cases): one rule per list entry, each resolving to the file whose model owns the table; building the rules throws for a table that is not a backup table, a column the model does not declare, or an unresolvable JSON field; every rule converts a synthetic cents value; edge cases (negatives, sub-unit, 2^53-1, null, absent, corrupt value, JSON object and array shapes). `load-archive.unit.ts` gains 3 cases (v1 converted, v2 untouched, version 3 rejected)
- [x] gate: these tests pass
  - result: backend typecheck, lint (exit 0) and oxfmt check are clean; the full backend unit suite is green (183 suites, 2497 tests); `restore-v1-archive.e2e.ts` 7/7; `check:money-migration` 465 checks passed again
  - ⚠️ found and fixed while running the e2e for the first time: the Task 3 migration recorded itself as applied without altering a column in the e2e template database (every money column stayed BIGINT, which is why account creation returned 500). The e2e template runner transpiles migrations with ts-node's default target, where `[...columnsByTable()]` (a spread of a `Map`) yields an empty array, so no `ALTER TABLE` ran. The migration now uses `Array.from(columnsByTable(), ...)`. The Docker e2e run is the only place that catches this, so any later migration that spreads or iterates a `Map` or `Set` has the same risk
  - ➕ `restore-backup.e2e.ts` after that fix: 33 of 40 cases pass (1 skipped); the 6 failures all call `GET /transactions` (500 until Task 5): `keeps merged and removed bank rows in reconciliation history`, `restores onto another user without colliding on the still-live source ids`, `restores an import batch the target can undo...`, `rolls back a restore whose data violates a foreign key...`, `rejects an empty-manifest / missing-user archive...`, `restoring an empty backup wipes a previously-seeded user...`; Task 5's gate must re-run `restore-backup.e2e.ts`. The `newer than supported` case there now uses `BACKUP_FORMAT_VERSION + 1`

### Task 5: Audit raw cents handling, part 1

**Files (from the `rg` distribution):**

- Modify: `services/transactions/**`, `controllers/transactions.controller/**`, `services/accounts/**`, `services/balances/**` (including `revalue-balance-history.service.ts`), `models/balances.model.ts`, `models/transactions.model.ts` (hooks), `services/stats/**`, `serializers/**`, `services/calculate-ref-amount*` (Redis cache key and value), transaction linking, `services/currencies/change-base-currency.service.ts`

- [x] list every hit of `rg -n 'fromCents|toCents|Cents\b|::bigint|::int|\* ?100|/ ?100|literal\(|INSERT INTO|UPDATE "' ` in these paths, and record the before count in this plan
  - before count (the listed paths, `grep -rEI -c`, tests included): 632 lines in 72 files; 400 outside `*.e2e.ts` / `*.unit.ts`. Most are not storage hits: `Cents`-typed names of the stats pipeline (`Cents`, `asCents`, `*Cents` fields), `literal(` of SQL fragments, `/ 100` percentages
  - the hits that touched stored values were the raw reads and SQL (below); the rest is in-memory integer-cents arithmetic that goes through `Money` getters and stays
  - after count: 606 lines (370 outside tests; the new tests add a few). Remaining non-test hits by group:
    - stats cents domain (`services/stats/**`, `serializers/stats.serializer.ts`, `get-total-balance`): about 300 hits. The reports compute in integer cents derived from hydrated `Money` (`.toCents()`) and convert back with `centsToApiDecimal` at the serializer; they hold base-currency sums rounded to 2 decimals, which is lossless while storage is 2 decimals (`roundOnWrite: 2`). ➕ A base currency with more than 2 decimals (KWD) would round these reports to cents: Task 7 must either scale the stats domain by the base currency's decimals or leave it as a documented limit
    - the only raw stats read of a migrated column, `getBalanceHistory`, now converts the DECIMAL string to cents right after the query (`toCentsRow`)
    - transfer-leg and duplicate matching in memory (`bulk-scan-transfer-recommendations`, `detect-duplicates.service`, `match-stuck-pending`, `stuck-pending`): integer-cents keys and ratios over `Money.toCents()`, no storage involved
    - external minor units, kept on purpose: `link-to-bank-connection` (provider balance and credit limit are cents) and `absorb-link-residual` (the `balanceReconciliation` snapshot in `Accounts.externalData` is documented as cents; only its SQL sum was converted); `Balances.handleTransactionChange` (Monobank `externalData.balance` is in minor units)
    - `services/transactions/splits/types.ts` `MIN_SPLIT_AMOUNT = Money.fromCents(1)`: a 0.01 constant, replaced by the per-currency minimum in Task 7
    - `serializers/loans.serializer.ts` (loan events `fromCents`/`toCents`) and `serializers/tag-reminders.serializer.ts` (`amountThreshold`) stay on cents until Task 6 flips their writers together with them, so reader and writer never disagree
    - `literal(` hits are SQL fragments without money (`HAS_ATTACHMENTS_SQL`, tag and externalData filters, sort expressions)
- [x] switch raw reads of migrated values to `Money.fromDecimal`, and remove ×100, /100 and `::bigint` from raw writes and SQL expressions (`balances.model.ts:445,484`, the transactions hook, the revalue `::bigint` sum and raw `INSERT`)
  - new `toMoneyColumnValue({ money })` in `common/types/money-column.ts`: the exact decimal string a `@MoneyField` setter would store (2-decimal half-up until Task 7), used by every raw write: `Balances` literal updates, `applyIncrementAtSql`, `updateAccountBalance` upsert, the revalue bulk `INSERT`, the base-change `UPDATE ... FROM (VALUES ...)` (cast `::numeric`), and the planned-match `amount` filter
  - `Balances` Monobank per-tx path: the balance is minor units, so it is `Money.fromCents(balance).multiply(rate).roundHalfEven(2)`
  - `calculateRefAmountFromParams` is now `Money` arithmetic (`round(2)`, `multiply(rate)`, `roundHalfEven(2)`), exact instead of float-on-cents
  - `revalue-balance-history`: the `::bigint` sum became a decimal `signedSum`, and the running balance and each day's value are `Money`
  - `transactions.model.ts`: the update hook reads `dataValues` with `Money.fromDecimal`; `hasBalanceRelevantChange` compares amounts by value (`"12.5"` equals `"12.500000000000000000"`); amount filters pass exact decimal strings (`toFilterBound`)
  - `getPlannedSummary`, `matching-transactions` summary (`refAmount` raw string to cents for the shared total helpers), transfer and refund recommendation ranges (`Money` bounds), `absorb-link-residual` SUM, and the payee stats (`netFlowRefCents` renamed `netFlowRef: Money`; outside the plan's list but a raw `SUM` of a migrated column, also used by the MCP payee tools)
  - `serializers/transactions.serializer.ts` serializes raw rows (`GET /transactions` without `include*` flags reads raw): new `moneyToApiDecimal` / `moneyToApiDecimalOrNull` accept a `Money` or the raw DECIMAL string, and `centsToApiDecimal` rejects a string instead of misreading it
  - `models/index.ts` INT8 parser comment now says it serves counts and ids, not money
  - ⚠️ Task 6 follows the same rule: a serializer or service that gets a `raw: true` row must use `moneyToApiDecimal` / `Money.fromDecimal`, not `centsToApiDecimal` / `Money.fromCents`
- [x] ref-amount cache: key and value become exact decimal strings under `ref_amount:v2:`; one exported helper builds both the key and the invalidation prefix, and every invalidator uses it (`services/user/user-destroy-lifecycle.ts:139`, `change-base-currency.service.ts:926`, and any other `ref_amount:` pattern found by `rg 'ref_amount:'`)
  - `services/ref-amount-cache.ts` exports `refAmountCache` (`parseJson: false`, so the decimal strings are not turned into lossy numbers), `buildRefAmountCacheKey`, `serializeRefAmountCacheValue` and `buildRefAmountCachePattern`; `calculate-ref-amount.service.ts`, `user-destroy-lifecycle.ts` and `change-base-currency.service.ts` use them, and `rg 'ref_amount'` finds no other literal
  - ⚠️ found by the new e2e: `CacheClient.delete(pattern, true)` never matched anything under the test Redis prefix, because ioredis applies `keyPrefix` to key arguments but not to the `KEYS` pattern. It now prefixes the pattern itself, so the user-destroy and base-change invalidations are real in tests too
- [x] e2e: after a backup restore, a transaction with a previously cached amount, pair and date gets the restored rate, not the cached one
  - `services/backup/restore/restore-ref-amount-cache.e2e.ts`: exports a backup at rate 40, caches a conversion at rate 50, restores, and checks that both an uncached amount and the cached one convert at 40. Unit tests in `ref-amount-cache.unit.ts`
- [x] run the e2e suites for transactions, accounts, balances, stats and base change
  - one batched run: `common/types/money-column|controllers/transactions.controller|controllers/accounts|services/transactions|services/accounts|services/balances|crons/balance-revalue|services/stats|services/currencies|services/backup/restore|payees|services/user-exchange-rate|services/tx-refunds`
  - e2e fixes: `money-column.e2e.ts` (raw reads are decimal strings; literal updates in decimals), `balance-revalue-sweep.e2e.ts` (raw `INSERT` and read in decimals), `link-balance-reconciliation.e2e.ts` (cents helpers over raw rows)
  - one line of Task 6 scope pulled forward because a Task 5 suite needs it: the Enable Banking pending-upgrade fingerprint filtered `amount` with provider cents (`enablebanking.provider.ts`, `fingerprintBase`)
- [x] gate: these pass (all Task 1 e2e cases stay `it.todo` until Task 7)
  - result: 77 suites, 904 passed, 5 skipped, 3 todo, 0 failed (includes `restore-backup.e2e.ts` 39 passed and 1 skipped, with its 6 former `GET /transactions` failures passing, `restore-v1-archive.e2e.ts` 7/7 and the new restore cache case); backend typecheck, lint (exit 0), oxfmt and the full unit suite (184 suites, 2512 tests) are clean

### Task 6: Audit raw cents handling, part 2

**Files (from the `rg` distribution):**

- Modify: `services/bank-data-providers/**`, `services/{budgets,budget-plans,subscriptions,loans,vehicles,import-export,demo,transaction-automations,tag-reminders,data-export}/**`, `common/loans/projection.ts`, `parse-amount.ts`, `round-currency.ts`, the related serializers

- [x] same audit as Task 5 for these paths, keeping `toCents`/`fromCents` only where an external API really speaks in minor units, with a comment saying so
  - before count (same paths, `grep -rEI`, tests included): 673 lines in 124 files; 431 outside `*.e2e.ts` / `*.unit.ts`. The paths are the Task 6 list plus the loans and tag-reminders serializers
  - bugs found and fixed (a number or a cents value reached a decimal column or filter):
    - `connect-selected-accounts.ts`: `Accounts.create` got provider cents as `initialBalance` / `currentBalance` / `creditLimit`; now `Money.fromCents` of the provider's minor units
    - `auto-link-transfers.ts` and `walutomat/cross-provider-linking.ts`: the `amount` equality filter used `toCents()`; now `toMoneyColumnValue`
    - `suggest-historical-matches.ts`: the same-currency `amount` rule filtered the DECIMAL column with cents; now decimal bounds (the in-memory tolerance math stays on integer cents)
    - `budget-plans/activity/get-plan-activity.ts` and `get-plan-cash.ts`: raw SUMs and balances arrive as decimal strings; converted to the plan's integer-cents domain at the query boundary
    - `demo`: `apply-demo-template` bulk-created transactions from template cents, and `seed-investments` funding transactions from `amountCents`; both now build `Money`
    - `venture` and `portfolio` link snapshots (`metaData.originalTransactionState.amount` / `refAmount`) stored cents and `unlink-tx-from-event` read `refAmount` back as cents; they are decimals now (see the JSON item below)
  - kept on cents on purpose, each commented or documented: the provider boundary (`ProviderAccount`, `ProviderTransaction`, `ProviderBalance` are integer minor units; Monobank speaks them natively, the others convert on the way in; `types.ts` says so), Monobank's `externalData.balance`, the `balanceReconciliation` audit snapshot in `Accounts.externalData`, the CSV `parseAmount` (cents) and `roundCurrency` (2 decimals) whose docs now say they round to 2 decimals whatever the currency
  - after count: 665 lines in 122 files; 423 outside tests. Remaining non-test hits by group:
    - in-memory integer-cents arithmetic over `Money` getters, no storage involved: `budgets/**` stats, `budget-plans/**` fold / goals / suggested lines (`assignmentCents`, `toGoalSpec`, `Money.fromCents` on writes), `loans/**` replay / recompute / projection (`common/loans/projection.ts`), `vehicles/**` anchor, `subscriptions` matching engine and historical matches, `transaction-automations` condition context, duplicate detection in the importers and Walutomat linking
    - provider minor units (above): `bank-data-providers/**`, `connect-selected-accounts`, `list-external-accounts`, the importers' `asCents` / `parseAmount` rows
    - the demo template: `demo-config`, `template/**` and the seeders keep integer cents and build `Money.fromCents` at the model boundary
    - `literal(` SQL fragments without money, `* 1000` / `/ 100` time and percent arithmetic, `INSERT INTO` / `UPDATE "` raw SQL whose money operands are DECIMAL columns (`apply-demo-template`)
- [x] subscription-candidate detection, tag-reminder thresholds and loan events read decimals after the migration
  - `detect-candidates.ts` groups on decimal amounts (the CV and bucket math only compares ratios) and stores `averageAmount` as `Money`; it used to write integer cents into the decimal column
  - tag reminders: `settings.amountThreshold` is the API decimal end to end, so the serializer passes settings through; `check-reminders` sums `Money` and compares against `Money.fromDecimal(threshold)`; the notification message now carries the decimal actual amount (it printed cents). Shared type comments updated
  - loan events: `update-loan.service` writes decimals under the unchanged `fromCents` / `toCents` keys, `loans.serializer` renames them to `from` / `to`; `LoanEvent` docs say the values are decimals and the key names are historical
  - ⚠️ found by the audit: the money migration missed the cents stored in `VentureEventLinks.metaData.originalTransactionState` and `PortfolioTransfers.metaData.originalTransactionState` (`amount`, `refAmount`). `MoneyJsonFieldSpec` gained an optional `path`, both fields are in `MONEY_JSON_FIELDS`, so the migration (up and down), the backup v1 converter and `check:money-migration` handle them; the snapshot writers store decimals and `unlink-tx-from-event` reads `Money.fromDecimal`. `check:money-migration`: 485 checks passed (up, down, up again)
- [x] import executors (CSV, text-source, OFX, YNAB, Wallet, MS Money, bank providers) write decimals correctly
  - every executor builds `Money` (`Money.fromCents` for the CSV cents rows, `Money.fromDecimal` for the rest) before it reaches a model, so they were already correct; the e2e suites for all of them pass. Rounding stays 2 decimals until Task 7
  - e2e fixes: the CSV and Wallet "row fails at the database layer" cases overflowed BIGINT; they now use 1e18, which overflows `DECIMAL(36,18)`. `demo.e2e.ts` reads raw DECIMAL strings with `Big`
- [x] record the after count of the Task 5 search in this plan, with each remaining hit explained
  - see the first item
- [x] gate: the full backend e2e suite, run serially through `test-runner`, except the Task 1 e2e cases (storage and rounding), which stay `it.todo` until Task 7
  - result: full suite, 290 suites: 287 passed, 2 skipped, 1 failed (the new `venture/linking/unlink-tx-from-event.e2e.ts`, whose fixture amount did not satisfy the venture event's sum check; fixed and re-run alone: 2/2). Tests: 3657 passed, 56 skipped, 7 todo. Backend typecheck, lint (exit 0), oxfmt and the unit suite (184 suites, 2513 tests) are clean
  - new e2e: `venture/linking/unlink-tx-from-event.e2e.ts` (unlink restores the transaction from the decimal snapshot; unknown link is rejected). Unit: nested-path case in `convert-v1-money.unit.ts`

### Task 7: Per-currency rounding on write paths

**Files:**

- Modify: transaction create and update, transfers, splits, refund linking, `calculate-ref-amount*`, balance updates, `common/lib/zod/custom-types.ts` (`boundedDecimalAmount`)

- [x] round every user-provided money write half-up to its currency's decimals, listing each path: transactions (`amount`, `commissionRate`, `cashbackAmount`, `originalAmount`), splits, accounts (`initialBalance`, `creditLimit`), balance adjustment (`targetBalance`), budgets (`limitAmount`), budget assignments and line goals, subscriptions (`expectedAmount`), transaction templates, vehicles (`purchasePrice` and values), loan details, and every import executor; then remove the transitional `roundOnWrite: 2` from Task 3
  - `roundOnWrite` is gone from `@MoneyField`, from the 34 declarations and from `toMoneyColumnValue` (which now formats the exact column string without rounding). Rounding happens at the funnel every write of a kind passes through, with `roundMoneyValues` / `roundToCurrency` (new `roundMoneyValues` and `assertMoneyFitsCurrency` in `currency-precision.ts`, `roundTransactionMoney` in `common/lib/round-transaction-money.ts`, `roundToBaseCurrency` in `services/currencies/`):
    - transactions: `Transactions.createTransaction` and `updateTransactionById` (the model functions every service, importer and provider goes through) round `amount`, `commissionRate`, `cashbackAmount` half-up to the account currency, `originalAmount` half-up to `originalCurrencyCode`, and `refAmount` / `refCommissionRate` half-even to `refCurrencyCode` (the stored row's currency when the update payload omits it). `services/transactions/create-transaction.ts` also rounds the entered figures right after the account currency is known (so the planned-row match, the split-sum check and the same-currency `refAmount = amount` copy see stored values) and `destinationAmount` against the destination account currency; `update-transaction.ts` does the same for the edited and destination amounts; `merge-into-planned.ts` rounds the bank's commission, cashback and original amount
    - splits: `manageSplits` rounds the transaction amount, every split amount and a caller-given split `refAmount` (to the base currency) before validation, so the sum check compares stored values; the 0.01 `MIN_SPLIT_AMOUNT` constant is replaced by the per-currency minimum unit (`minSplitAmount`, required by `assertValidSplits`)
    - accounts: `accountsService.createAccount` / `updateAccount` / the opening-balance update and `Accounts.createAccount` / `updateAccountById` (`initialBalance`, `currentBalance`, `creditLimit`); provider accounts (`connect-selected-accounts`, `writeBankBalanceWithHistory`); `adjustAccountBalance` (`targetBalance`); sums and differences of stored values (balance deltas, `absorbBalanceAdjustment`) are already at the currency's decimals and are not rounded again
    - budgets: tracker `limitAmount` (create and edit) rounds to the owner's base currency; budget-plan `expectedIncome`, assignment amounts and line goals are checked with `assertMoneyFitsCurrency` against the plan currency and rejected (422, new key `currencies.amountExceedsDecimals`, `en` and `uk`) instead of rounded, as the 2-decimal schema check did; suggested-line baselines round to the plan currency
    - subscriptions `expectedAmount` (create, update; candidates' computed `averageAmount`), templates (`amount`, to the pinned account's currency), vehicles (purchase price, depreciated value on create and refresh, the reconstructed anchor), loans (`initialBalance`, `originalPrincipal`, `minPayment`, `plannedPayment`, corrected `currentBalance`)
    - imports: every executor reaches the database through `createTransaction` / `createAccount`, so they are covered by the rows above. The Wallet and YNAB parsers no longer round to 2 decimals (`round-currency.ts` became `remove-float-drift.ts`, which only strips float drift at 10 decimals)
    - ⚠️ [deviation] the rounding sits at these funnels, not inside the 14 models' attribute setters: a setter cannot see the currency, and most of the models (splits, balances, budgets, vehicles, loans) have no currency column of their own
- [x] test: a USD account created with `initialBalance: 100.555` stores `100.56`, as today; a KWD account stores `100.555`
  - `currency-precision.e2e.ts` (opening balance and credit limit, plus a KWD balance adjustment)
- [x] round converted values (`refAmount`, `refCommissionRate`, balance revaluation) half-even to the base currency
  - `calculateRefAmountFromParams` takes `baseDecimals` / `quoteDecimals` (default 2, for the investment and display callers); `calculateRefAmount` looks both up with `getCurrencyDecimals`, as do the base-currency change (`localCalculateRefAmount`, balances, FIRE settings), the subscription summary and invoice matching. The balance-history revalue and the Monobank per-transaction balance round half-even to the base currency's decimals. The model functions above round any `refAmount` that reaches them
- [x] make split-sum validation compare rounded values
  - see the splits item
- [x] make `boundedDecimalAmount` precision-aware, so a 3-decimal base currency accepts 3 decimals in budget plans
  - the schema now caps at the 18 decimals the columns store; the service that knows the plan currency applies its decimals (`assertMoneyFitsCurrency`). `set-assignment.e2e.ts`: a KWD-base plan accepts `1.234` and rejects `1.2345`, a USD one still rejects `1.234`
- [x] tests: transfers between a 0-decimal and a 3-decimal account, plus the Task 1 rounding cases
  - `currency-precision.e2e.ts`: a JPY to KWD transfer (each leg rounded to its own currency, base-currency amounts at 2 decimals, exact balances), KWD and JPY split sums. Also e2e: tracker limit rounding (`budget-crud`), subscription, template and loan amounts. Unit: `roundMoneyValues`, `assertMoneyFitsCurrency`, `roundTransactionMoney`, `calculateRefAmountFromParams` with other decimals
- [x] remove the skip (`itPerCurrencyRounding`) from the Task 1 e2e cases (storage and rounding), and add the KWD 3-decimal v2 backup round trip to the Task 4 e2e
  - the alias is gone, the 4 Task 1 cases run; `restore-v1-archive.e2e.ts` gained the KWD round trip (export, restore, re-export compare `3` decimals)
- [x] gate: the backend unit and e2e tests pass, including every Task 1 case
  - result: full e2e suite, 290 suites: 283 passed, 2 skipped, 5 failed; 6 failed tests. Two were mine and are fixed: `original-currency-metadata` and the statement-parser `execute-import` used a JPY original amount of `5000.55`, which now rounds to `5001` (they use CHF; a new case checks JPY and KWD rounding). The other three were load flakes (`get-net-worth-drivers`, `securities-daily-sync` 429, the YNAB 30 s timeout). Re-run of those five plus the touched suites (splits, budget-crud, subscriptions, templates, loans): 11 suites, 223 passed. Before that, `currency-precision`, `set-assignment` and `restore-v1-archive`: 38/38 (all Task 1 cases pass). Backend typecheck, lint (exit 0), oxfmt and the unit suite (185 suites, 2530 tests) are clean
  - ➕ known limits left for follow-ups (the engines below still compute in integer cents, so a currency with more than 2 decimals is stored exactly but reported at cents): the stats cents domain (`services/stats/**`; Task 5 asked Task 7 to scale it or document it, this is the documented limit), the budget-plan fold / goal engine (`assignmentCents`, `toGoalSpec`: the goal endpoint returns cents-rounded values), loan recompute / replay and the vehicle balance history (`toCents`), and the CSV importer's `parseAmount`, which still reads amounts as cents (a 3-decimal CSV amount loses the third decimal before it reaches the executor). The `ref_amount` Redis cache key does not include the decimals, so Task 12 must drop it when a currency's decimals change

### Task 8: Frontend formatting and inputs by currency decimals

**Files:**

- Modify: `packages/frontend/src/js/helpers/formatters.ts`, `packages/frontend/src/composable/formatters.ts`, the 6 component-level formatters, amount input components (locate them with ast-grep)
- Create/Modify: matching vitest files

- [x] formatters take the currency's decimals instead of assuming 2
  - `js/helpers/currency-decimals.ts` is the one place the frontend resolves a currency's decimals by code: a registry the currencies store fills from `CurrencyModel.digits` on every `loadCurrencies` / `loadBaseCurrency` (the field the API already returns for each currency; no new endpoint), then the ISO value from `Intl`, then 2. Task 12 and Task 15 add the per-user override by registering it into the same registry
  - `toLocalFiatCurrency` and `toLocalCurrencyNumber` read it, so the 2-decimal clamp is gone (KWD, BHD render 3, JPY and VND 0). A code `Intl` rejects renders as a bare number with its registered decimals and the code appended
  - `useFormatCurrency` exposes `baseCurrencyDecimals`; `convert` in `useExchangeRates` rounds to the target currency's decimals; the original-amount suggestion no longer clamps to 2; Lunchflow and Walutomat balances go through `formatUIAmount`
  - kept as they are on purpose: the payees net-flow formatters (whole base-currency units by design), the account-selection row for no-currency accounts, the depreciation chart's symbol lookup, and the investment, portfolio and billing formatters (not account-currency amounts)
- [x] amount inputs accept and show up to the currency's decimals
  - `InputField` (`type="number"`) gains `decimals`: digits past the cap are dropped as they are typed or pasted, `0` drops the decimal point (and blocks the `.` key). `FormattedAmountField` gains `decimals` (default 2) for both parsing and display
  - wired to the currency of the amount on: the transaction dialog (amount, transfer target amount, original amount, split rows, templates), inline amount editing, account creation (initial balance, credit limit), the account balance, initial balance and credit limit editors, subscriptions (create, edit, mark paid; dropped the fixed `step="0.01"`), loan form and loan payment, and, in the base currency, trackers and budget-plan inputs. The per-currency decimals validator replaces `currencyDecimal` (message `forms.validators.invalidCurrencyDecimal` now takes `{decimals}`, `en` and `uk`)
  - not wired (left at any precision, documented limit): investment, venture, vehicle, portfolio-transfer, automation-condition and records-filter amount inputs
- [x] vitest: format and parse for JPY, USD and KWD, plus large VND values
  - `formatters.spec.ts` (KWD, BHD, JPY, VND 20.5e9, registered tickers), `currency-decimals.spec.ts` (new), `formatted-amount.test.ts` (parse at 0, 3, 8 decimals, VND with grouping in both separator styles), `formatted-amount-field.test.ts` (new), `input-field.test.ts` (`decimals`), `currencies.test.ts` (store registers decimals), `suggest-original-amount.test.ts`, `balance-adjustment-dialog.test.ts` (USD, KWD, JPY)
- [x] gate: frontend typecheck, lint and unit tests
  - result: typecheck clean, lint exit 0 (warnings only, plus `i18n keys OK`), oxfmt clean, unit suite 246 files, all pass

### Phase 2: per-user custom currencies

### Task 9: Schema for custom currencies, wider codes and nullable ref amounts

**Files:**

- Create: `packages/backend/src/migrations/20261016010000-custom-currencies.ts`
- Modify: `currencies.model.ts`, `users-currencies.model.ts`, `transactions.model.ts`, `transaction-splits.model.ts`, `accounts.model.ts`, every model with a `STRING(3)` currency column, the shared types

- [x] migration:
  - drop `real_transactions`;
  - add `Currencies.isCustom`, `symbol` and `createdByUserId`, and make `number` nullable;
  - add `UsersCurrencies.nameOverride`, `symbolOverride` and `decimalsOverride`;
  - widen the 21 code columns to `varchar(16)`, handling the foreign keys;
  - make `refAmount`/`refCommissionRate` nullable on `Transactions` and `TransactionSplits`, make `Accounts.refCurrentBalance`, `refInitialBalance` and `refCreditLimit` nullable, and add `Transactions.refAmountMissing`;
  - recreate the view
  - result: `20261016010000-custom-currencies.ts` is a new file; the phase 1 migration is untouched. The column lists live in `common/lib/currency-code-columns.ts` (`CURRENCY_CODE_COLUMNS` with the 21 columns, `NULLABLE_REF_COLUMNS` with the 6 ref columns, `CURRENCY_CODE_MAX_LENGTH`), which the migration, the migration check and a model unit test read. The 21 columns were found from `information_schema` after applying all migrations; the investment tables' code columns (`Holdings`, `InvestmentTransactions`, `Securities`, `SecurityCurrencyCaches`) are `varchar(255)` without a foreign key and stay as they are
  - foreign keys: Postgres rebuilds the 16 foreign keys onto `"Currencies"."code"` when its type changes, so no constraint is dropped by hand (the check asserts a code missing from `"Currencies"` is still rejected)
  - ⚠️ found by the first e2e run (all 33 suites failed in setup): the e2e harness resets state with `TRUNCATE ... CASCADE` on every table except the seeded `Currencies`, and a foreign key from `Currencies.createdByUserId` to `Users` made that truncate cascade into `Currencies`, which emptied it. The column therefore has no foreign key; whoever deletes a user clears or ignores the id (Task 12 owns the user-destroy path). The migration check asserts that truncating `Users` with `CASCADE` keeps every currency, and fails when the foreign key is put back
  - `TransactionSplits` has no `refCommissionRate` column; only its `refAmount` becomes nullable
  - the nullable ref columns keep their model-level default `'0'` (`allowNull: true, defaultValue: '0'`), so an omitted value behaves as before; only an explicit `null` is new
  - constraints added beyond the plan text: `CHECK ("isCustom" OR "number" IS NOT NULL)` (an ISO row can never lose its number), `CHECK ("decimalsOverride" BETWEEN 0 AND 18)` (the scale of the money columns), and `createdByUserId` is a plain integer with a partial index, deliberately without a foreign key to `"Users"`
- [x] `down` refuses while custom codes or null ref amounts exist; otherwise it reverses everything
  - result: `down` refuses, naming each blocker, while a row has `isCustom` or a null `number`, a currency-code column holds more than 3 characters (this also covers the columns without a foreign key), a ref column is null, or a transaction is flagged `refAmountMissing`; the refusal leaves the schema untouched. The overrides on `UsersCurrencies` are dropped with their columns, including those set on an ISO code (documented in the migration header)
- [x] update the model declarations (`allowNull` on the ref money fields) and the shared types
  - `Currencies` (`number` nullable, `isCustom`, `symbol`, `createdByUserId`), `UsersCurrencies` (the three overrides), `Transactions.refAmountMissing` and the 16 models with `STRING(CURRENCY_CODE_MAX_LENGTH)`. Shared: `CurrencyModel` (`number | null`, `isCustom`, `symbol`), `UserCurrencyModel` (the overrides), `TransactionModel` and the transaction API response (`refAmountMissing`); `serializeCurrency` and the transactions serializer emit them. Frontend mocks follow
  - ⚠️ [deviation] the TypeScript types of the six nullable ref fields stay `Money` (and `number` in the shared API types). Declaring them `Money | null` produced 116 compile errors in 51 files (stats, budgets, subscriptions, automations, refunds, tests). Those are exactly the readers Task 13 must make null-safe, so Task 13 flips the declarations first and uses the compiler as its caller list; Task 15 does the same for the frontend types. Runtime is already correct: the getter returns `null` for a null column
  - unit test `currency-code-columns.unit.ts` (3 cases): every listed code column is declared `varchar(16)`, no model still declares `varchar(3)`, every `NULLABLE_REF_COLUMNS` entry is declared `allowNull`
- [x] extend `check-money-migration.ts` with this migration's up, down and up checks
  - result: after the money migration's own up/down/up, the script applies this migration on the seeded data, asserts the 21 columns are `varchar(16)` (and `varchar(3)` again after `down`), the new columns and their types, the six ref columns nullable, `real_transactions` exposing `refAmountMissing` with its row filter, the seeded values unchanged, the check constraints (non-custom row without a number, `decimalsOverride` -1 and 19 rejected, 0 and 18 accepted), a 16-character code accepted and a 17-character one rejected, `ExchangeRates` still rejecting an unknown code, and that truncating `Users` with `CASCADE` keeps every currency. It then proves `down` refuses (custom row, null ref amount on a transaction and on a split, a 5-character code in `BudgetPlans`) and leaves the columns widened, runs a clean `down`, and `up` again. Output: `956 checks passed, 0 failed.` Three mutations (no refusal guard; `number` kept NOT NULL; the `createdByUserId` foreign key) each make it fail
- [x] gate: typecheck, the migration check, and the e2e smoke tests (currencies, accounts, transactions)
  - result: backend and frontend typecheck, backend lint (exit 0), frontend lint (warnings only), oxfmt, frontend unit suite (246 files) and the backend unit suite (185 suites, 2533 tests; `expiring-upload-cache.unit.ts` failed once on a DNS lookup in the full run and passes alone, 17/17) are clean. `check:money-migration`: 956 checks passed. E2E, one batched run: `services/currencies|services/accounts|controllers/accounts|services/transactions/(create|update|get|delete)|controllers/transactions.controller|common/types/money-column|services/backup/restore|services/user-exchange-rate`: 33 suites, 382 passed, 1 skipped, 0 failed (it includes the backup restore suites, which dump and restore the new columns)

### Task 10: Keep custom codes out of global readers

**Files:**

- Modify: `currencies.model.ts` (`getAllCurrencies`), the currencies controller and route, `services/exchange-rates/providers/registry.ts`, `providers/fawaz-currency-api/**`, `providers/api-layer/**`, `initialize-historical-rates.service.ts`
- Create: `services/currencies/custom-currency-isolation.e2e.ts`, plus unit tests for the registry coverage set

- [x] exclude `isCustom` rows from `getAllCurrencies` and `GET /currencies`, the registry coverage set, the fawaz and ApiLayer `validCodes`, and the historical initializer
  - result: `getAllCurrencies` filters `isCustom: false` (the public `GET /models/currencies` and the registry's coverage set both read it); fawaz, ApiLayer and `initializeHistoricalRates` call `Currencies.findAll({ where: { isCustom: false } })`. `getCurrency`/`getCurrencies` (lookup by code, used by validation) are untouched: Task 11 owns visibility there
- [x] e2e: a custom code created directly in the test DB through a helper endpoint is invisible in `GET /currencies` for every user
  - result: `seedCustomCurrencyRow` / `removeCustomCurrencyRow` in `tests/helpers/currencies.ts` insert and clean a custom `BTC` row (the mocked providers quote BTC) attached to the primary user. `custom-currency-isolation.e2e.ts` (4 tests): the list excludes it for the owner and for a second user, and the daily sync (fawaz basket, then ApiLayer with fawaz down) and the historical backfill store no `ExchangeRates` row for it
- [x] unit tests: provider coverage reaches "complete" and the ApiLayer early stop still fires while custom rows exist; fawaz never ingests a custom code
  - result: `providers/custom-currency-isolation.unit.ts` (4 tests) fakes `Currencies.findAll` over ISO plus custom rows. All 4 fail when the filter is removed from `getAllCurrencies`, fawaz and ApiLayer (checked by mutation)
- [x] gate: these tests pass, before any endpoint can create custom rows
  - result: backend typecheck, lint (exit 0), oxfmt and the unit suite (187 suites, 2537 tests) are clean. E2E, one batched run: `services/currencies/(custom-currency-isolation|add-user-currency)|services/exchange-rates/|services/user-exchange-rate|services/bank-data-providers/monobank/monobank-flow`: 8 suites, 98 passed, 0 failed

### Task 11: Currency-code validation from the database

**Files:**

- Modify: `common/lib/zod/custom-types.ts`, controllers that call `currencyCode()`, `csv-import/extract-unique-values/validate-currency.ts`, `ofx-import/mapping.ts`, `ynab-import/parse-ynab.service.ts`, `bank-data-providers/simplefin/simplefin.provider.ts`, `statement-parser/extraction-prompt.ts`
- Create/Modify: the matching unit and e2e tests

- [x] `currencyCode()` checks the format `^[A-Z0-9]{2,16}$`; a shared service helper checks existence and that the code is visible to the user
  - result: `common/lib/currency-code-format.ts` holds the pattern; `currencyCode()` is format-only and a new `isoCurrencyCode()` keeps the old ISO 4217 membership check for ISO-only contexts (base currency, change base, portfolios and investments, securities prices, ventures, vehicles, loans, their MCP tools). `services/currencies/assert-currency-codes-visible.ts` has `resolveVisibleCurrencies` (ISO row, or a custom row the user holds; `isoOnly` option), `assertCurrencyCodesVisible` (422, message `Invalid currency code "X". Use an ISO 4217 code, e.g. "USD", or one of your custom currencies: ...`; another user's custom code reads exactly like an unknown one) and `getOwnCustomCurrencyCodes`. Called by `createAccount`, `createTransaction`/`updateTransaction` (`originalCurrencyCode`), the template create/update, subscription create/update, `addUserCurrencies` (so POST /user/currencies never attaches someone else's definition), `editUserExchangeRates` and the pair-rate controller
- [x] the four importers use the shared format and visibility check; monobank keeps its ISO numeric mapping
  - result: CSV `validate-currency` uses the shared format and `resolveVisibleCurrencies`; OFX `CURDEF` and SimpleFIN account currencies use `isCurrencyCodeFormat` (SimpleFIN still skips URL currencies; existence and visibility are checked at connect); YNAB `(CODE)` detection reads three capital letters as before and any other tag only when it is one of the user's own custom codes (`parseYnabRegister({ customCurrencyCodes })`, fed by `createParseController`, whose `parse` now gets `{ userId }` and may be async). All importers' execute steps go through `addUserCurrencies`/`createAccount`, which run the visibility check. Monobank is untouched
- [x] the statement-parser prompt and import mapping recognise the user's custom codes
  - result: `buildStatementExtractionSystemPrompt({ customCurrencyCodes })` appends the user's codes to the prompt; `parseAIResponse({ customCurrencyCodes })` keeps an original currency that is ISO or one of those codes; the execute step keeps the pair only for codes `resolveVisibleCurrencies` returns
- [x] ➕ (found in Task 10) two more `getCurrency({ code })` callers resolve a code from an external source without a visibility check, so they would accept another user's custom code: `bank-data-providers/connection/connect-selected-accounts.ts:218` (bank account currency) and `investments/holdings/create-holding.service.ts:32` (security currency). Both are ISO-only; make them reject `isCustom` rows (or take the new shared helper with an ISO-only option)
  - result: `create-holding` ignores a custom row (investments are ISO-only, 404 as for an unknown currency). `connect-selected-accounts` takes `resolveVisibleCurrencies` without `isoOnly`: another user's code and unknown codes are 400 as before, while the user's own custom code is allowed (a SimpleFIN "XXX" account can be given one by `currencyOverrides`, the case Task 11 asks SimpleFIN to support); NON_CURRENCY_CODES still reject
- [x] tests: format unit tests; e2e rejects another user's custom code and an unknown code (listing the valid ones); a CSV import into a custom-currency account is accepted
  - result: unit `custom-types.unit.ts` (currencyCode / isoCurrencyCode), `assert-currency-codes-visible.unit.ts`, `extraction-prompt.unit.ts` and `parse-ynab.unit.ts` additions; e2e `services/currencies/currency-code-validation.e2e.ts` (11 tests: unknown code on account / transaction / template / subscription / user currencies / rates / pair rate with the valid choices listed, another user's code rejected the same way, CSV steps, the owner creates a BTC account and imports a CSV into it, ISO-only contexts reject a custom code, create-holding ignores a custom code) and two SimpleFIN connect tests in `simplefin-flow.e2e.ts`. `removeCustomCurrencyRow` now clears every referencing code column, so tests can create accounts in a custom code and still clean up
- [x] gate: these tests pass
  - result: backend typecheck, lint (exit 0), oxfmt, unit suite (188 suites, 2584 tests) and the FULL e2e suite (289 suites passed; the only failures were 3 cases of the new file, fixed and rerun: 11 of 11 pass)

### Task 12: Custom currency CRUD with per-user decimals

**Files:**

- Create: `packages/backend/src/controllers/currencies/custom-currencies.ts`, `services/currencies/custom-currencies.service.ts`, `services/currencies/custom-currencies.e2e.ts`
- Modify: the currencies routes and serializers, `common/lib/currency-precision.ts` (override lookup and cache invalidation)

- [x] `POST`: create the global row (`isCustom`, `number` null) or reuse an existing one, then attach it to the user with their overrides
  - result: `POST /user/currencies/custom` (`code`, `name`, `decimals` 0 to 18, `symbol?`, 201) creates the `Currencies` row on first use (reuse when another user defined the code first; a lost insert race adopts the winner's row) and always writes the full definition into the user's own `UsersCurrencies` overrides with `liveRateUpdate: false`. An ISO code (seeded or not) is 409, a second definition by the same user is 409. `GET /user/currencies/custom` lists the user's custom currencies
- [x] `PUT` and `DELETE` with the "only while unused by this user" rules; list endpoints apply the overrides
  - result: `PUT /user/currencies/custom/:code` renames, changes the symbol (null clears) and changes decimals; a decimals change that differs from the current value is 409 while the user has an account, transaction (any of `currencyCode`, `originalCurrencyCode`, `refCurrencyCode`, soft-deleted included), template, subscription, subscription candidate or budget plan in the code (`details.usedBy` names them). `DELETE` has the same check, removes the user's rates for the code, the `UsersCurrencies` row, and the global row once nobody holds it. `GET /user/currencies` returns the custom `currency` with the user's name, symbol and decimals applied (`withEffectiveCurrency`); the legacy `DELETE /user/currency` refuses a custom code (422). All three mutating routes sit behind `checkBaseCurrencyLock`, so `base-currency-guard-coverage.e2e` needed no exemption
- [x] `getCurrencyDecimals` prefers `decimalsOverride`, and every write invalidates the user's cache entry
  - result: custom currencies read `UsersCurrencies.decimalsOverride` (ISO currencies cost the same single lookup as before). `UsersCurrencies` model hooks drop the cached decimals of the user and code (the whole cache on bulk writes); the service drops them again after commit. ⚠️ review fix: a decimals change no longer drops the user's `ref_amount:v2:` Redis entries. `calculateRefAmount` never caches a conversion with a custom side, so no entry depends on a custom currency's decimals (the drop was dead code)
- [x] native amounts on an account are rounded with the **account owner's** definition (pass the owner's `userId`, not the author's); reference amounts use the author's base, as today
  - result: `roundTransactionMoney` takes `accountOwnerUserId` (native amounts and a same-currency reference value follow the owner, reference values and the original amount the author); `Transactions.createTransaction` and `updateTransactionById` accept it and `create-transaction` / `update-transaction` pass the owner. `calculateRefAmount` (`amountOwnerUserId`) and `getConversionDecimals` (`baseOwnerUserId`) round the native side with the owner's decimals; splits do the same. `ensureUserCurrencyConnected` takes `definitionOwnerUserId` and, for a newly connected custom code, copies the owner's definition and sets `liveRateUpdate: false`
- [x] backup: export the user's referenced custom definitions (`services/backup/registry.ts`, `dump-tables.service.ts`); restore creates or reuses the global rows before `UsersCurrencies` and accounts (`restore/restore-tables.ts`)
  - result: new `reference/custom-currencies.json` (`code`, `currency`, `digits`, `symbol`, `isCustom`; no creator) for the custom codes the user holds; `Currencies` moved from `BACKUP_EXCLUDED` to `REFERENCE_TABLES`. `restoreCustomCurrencies` runs inside the restore transaction after the wipe: it validates each definition (format, not an ISO code, decimals 0 to 18, name, symbol), reuses an existing custom row untouched and creates a missing one for the restoring user. A `users-currencies` row may only name an ISO code or a custom code the archive defines (a crafted archive cannot attach someone else's definition), and a row without overrides takes the archive's definition. The format version stays 2: an older v2 archive has no such file and restores as before
- [x] e2e: Alice (SAT, 8 decimals) shares an account with Bob (SAT, 0 decimals); Bob's 1.25 SAT entry is stored as 1.25. A backup of a user with a USDT account restores on a fresh instance with the currency, overrides and account intact
  - result: both in `custom-currencies.e2e.ts`. The backup case wipes the user (the prune deletes the global USDT row), restores, and checks the row, the override list, the account and a 0.123456 USDT transaction
- [x] block making a custom currency the base currency, and keep ISO-only validation for portfolios, investment transactions, ventures, vehicles and loans (e2e: creating a USDT loan or portfolio → 422)
  - result: the ISO-only schemas from Task 11 already reject a custom base (`/user/currencies/base`, `change-base`: 422); `setDefaultUserCurrency` now refuses a custom code at the service, and the base self-heal (`ensure-base-currency`) skips custom candidates. e2e covers a USDT loan, a portfolio with a USDT display currency, `change-base` and `base`
- [x] account and transaction payloads carry the account currency's effective metadata **as defined by the account owner** (`decimals`, `symbol`, `isCustom`), so a collaborator's UI can format by the account rather than by its own currency list
  - result: `currencyMeta: { decimals, symbol, isCustom }` (shared `CurrencyMeta`) on the accounts list, detail, create, update and balance-adjustment responses, and on the transactions list, detail, create, update, link and unlink responses. `attachAccountCurrencyMeta` / `attachTransactionCurrencyMeta` stamp it from the owner's `UsersCurrencies` row (owners are looked up only when a custom code is involved). Other serialization paths (MCP, reconciliation, recommendations) do not carry it; the field is optional
- [x] e2e: happy path, empty state, duplicate code for the same user, another user's code invisible, delete or decimals change while in use → 409, and two users defining SAT with 0 and 8 decimals each storing their own precision
  - result: `services/currencies/custom-currencies.e2e.ts`, 34 tests (validation 422s, ISO 409, duplicate 409, invisibility to another user, 404s, in-use 409s, cache invalidation, shared account, ISO-only contexts, user delete and wipe clean-up, backup round trip, tampered archive). Unit tests: `effective-currency.unit.ts`, `ensure-currency-connected.service.unit.ts`, and new cases in `currency-precision.unit.ts` and `round-transaction-money.unit.ts`
- [x] ➕ user cleanup (found in Task 10): `Currencies.createdByUserId` has no foreign key, so deleting a user (`services/user/delete-user.service.ts`) or wiping their data (`wipe-user-data.service.ts`) removes their `UsersCurrencies` rows through the cascade or the per-table destroy but leaves their global custom `Currencies` rows behind, still pointing at the deleted id. Both flows go through `runUserDestroyLifecycle` (`user-destroy-lifecycle.ts`), and `DELETE /user/currencies/custom/:code` has the same end state. Add one shared helper (for example `pruneUnusedCustomCurrencies`) that deletes `isCustom` rows no `UsersCurrencies` row references any more and clears `createdByUserId` on rows that survive because another user attached them. Call it inside the transaction from the lifecycle after `destroyInTx`, and from the `DELETE` endpoint. e2e: delete a user who defined SAT and assert the row is gone; delete a user whose SAT another user also holds and assert the row stays with `createdByUserId` null
  - result: `services/currencies/prune-custom-currencies.ts` (`pruneUnusedCustomCurrencies`): custom rows no `UsersCurrencies` row holds are deleted unless a currency-code column still references them (checked per candidate, so the foreign key never aborts the transaction; `ExchangeRates` is skipped because custom codes never get global rates), and `createdByUserId` is cleared where the creator no longer holds the code. Called after `destroyInTx` in `runDestroyInTx` (delete user, wipe and backup restore) and from the `DELETE` service. e2e: delete (only holder: row gone; another holder: row stays with a null creator) and wipe
- [x] gate: these tests pass
  - result: backend typecheck, lint (exit 0), oxfmt, frontend typecheck, unit suite (191 suites, 2603 passed), `custom-currencies.e2e` 34/34, and the FULL e2e suite (293 suites: 290 passed, 2 skipped; one load flake in `securities-daily-sync.service.e2e` passed on its rerun 13/13)

### Task 13: Transactions in custom currencies with an explicit missing-rate state

**Files:**

- Modify: `services/calculate-ref-amount*`, `services/user-exchange-rate/get-exchange-rate.service.ts`, and every `refAmount` reader enumerated in the first step
- Create: `services/currencies/custom-currency-transactions.e2e.ts`

- [x] ➕ (found in Task 12) a collaborator who never defined a custom code and writes on a shared account in it is connected to the code by `ensureUserCurrencyConnected` with the owner's definition and `liveRateUpdate: false`, but today that write fails on the missing rate (`ExchangeRateUnavailableError`), so the connection is only covered by a unit test. Once the missing-rate state exists, add the e2e: the collaborator's entry succeeds with `refAmountMissing`, and `GET /user/currencies` lists the code with the owner's decimals
  - result: `custom-currency-transactions.e2e.ts` ("a collaborator who never defined the currency"): Bob accepts a write share of Alice's SAT (8 decimals) account, has no SAT definition and no rate, and enters 0.123456789. The entry is saved as 0.12345679 with `refAmount: null` and `refAmountMissing: true`; `GET /user/currencies` then lists SAT with `digits: 8`, the owner's name and `liveRateUpdate: false`
- [x] enumerate every caller of `calculateRefAmount` reachable with a custom code, and every reader that sums or copies the nullable ref fields; record the list in this plan. Starting set from `rg -l calculateRefAmount`:
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
  - ➕ start from the compiler: Task 9 made the six ref columns nullable in the database but left their TypeScript types as `Money` (116 errors in 51 files appear when they become `Money | null`). Flip `Transactions.refAmount` / `refCommissionRate`, `TransactionSplits.refAmount` and `Accounts.refInitialBalance` / `refCurrentBalance` / `refCreditLimit` to `Money | null` (and the matching `number | null` in the shared `TransactionModel`, `TransactionSplitModel` and `AccountModel`, plus the transactions serializer), then fix every reported reader; the error list is the caller list to record here
  - result, the compiler list: the flip produced 114 errors in 50 files (85 in 43 source files, 29 in 7 e2e files); the frontend added 61 more once the shared types changed. Every one was fixed by hand, none with a blanket `!` outside the e2e files (where a read of a value the test just wrote uses `!`). What each reader does with `null`:
    - **Writers that now store `null` and the flag** (through `calculateRefAmountOrNull`): `accounts.service.ts` (create: `refCreditLimit`, `refInitialBalance`; update: `refCurrentBalance`, `refCreditLimit`), `transactions/create-transaction.ts` (base leg, commission, opposite leg of a same-user and a cross-user transfer, `calcTransferTransactionRefAmount`), `transactions/update-transaction.ts`, `transactions/splits/manage-splits.ts` (split `refAmount`; the refund-floor check is skipped when it is `null`), `planned-matching/merge-into-planned.ts`, `accounts/remeasure-ref-balances.ts` (a custom account measures as `null`), `accounts/restamp-ref-initial-balance.ts`, `accounts/measure-spot-ref-balance.ts` (now `Money | null | undefined`: `null` = custom currency without a rate, stored; `undefined` = no rate reaches the pair, keep the stored value) with its callers `accounts/update-balance-for-changed-tx.ts` and `accounts/absorb-balance-adjustment.ts`, `import-export/core/resolve/create-accounts-if-needed.ts`, `bank-data-providers/connection/connect-selected-accounts.ts`, `bank-data-providers/utils/write-bank-balance-with-history.ts` (no history point is written while there is no value), `loans/recompute-loan-balance.service.ts` and `vehicles/refresh-vehicle-value.service.ts` (ISO-only; typed, never `null` at run time)
    - **Writers that keep throwing** (`calculateRefAmount`; the amount is a native one or the context is ISO-only): `subscriptions/convert-subscription-amount.ts` (a missing rate stays the "no exchange rate, enter the amount" validation error), `subscriptions/matching-engine.ts` and `suggest-historical-matches.ts` (their `catch` already reads a failed conversion as "no match"), `subscriptions/get-subscriptions-summary.ts` (its `catch` skips and warns), `budget-plans/get-scheduled.ts` (its `catch` skips the occurrence), `common/transaction-linking.ts` (portfolio and venture links are ISO-only)
    - **Readers that leave the row out of every sum**: `Balances.handleTransactionChange` and `handleAccountChange` (a missing value moves nothing, `setTodayRowToSpot` pins nothing), budgets (`budgets/stats.ts`, `spending-stats.ts`, `get-category-budget-transactions.ts`, `utils/refund-pairs.ts`), stats (`category-allocation.ts` with the cash-flow, pivot, spendings and expenses-history consumers, `get-cumulative-data.ts`, `get-net-worth-drivers/savings.ts`, `get-pivot/dimensions.ts` and `refunds.ts`, `get-venture-contributions.ts`, `get-credit-limit-adjustment.ts`), `transactions/matching-transactions.ts` (the summary endpoint), `tag-reminders/check-reminders.ts`, `subscriptions/get-subscriptions-summary.ts` (income total), `data-export/transformers/budgets-transformer.ts`, `budget-plans/get-scheduled.ts` (planned rows), `budget-plans/activity/get-plan-cash.ts` (`COALESCE` on the account balance); raw SQL `SUM`s (`payees`, `get-planned-summary`, `get-plan-activity`) already skip `NULL`
    - **Readers that treat the row as having no match**: transfer and refund recommendations (a source with no base-currency amount gets none; candidates are filtered by `refAmount` in SQL, which excludes `NULL`), invoice matching (`score-candidates.ts`: the amount signal is `unknown`), transaction automations (`refAmountCents: null`: a base-currency amount condition never matches)
    - **Readers that pass `null` through**: the transactions and accounts serializers (`moneyToApiDecimalOrNull`; `TransactionApiResponse` and the split response now declare `number | null`), the MCP slimmers, `data-export` (`amountInBaseCurrency` is empty), the link snapshots (`OriginalTransactionStateSnapshot.refAmount` and the venture unlink restore), subscription linked transactions
    - **Loans and loan-side stats** (ISO-only, so `null` is unreachable): `?.toCents() ?? 0` / `moneyEqualsOrNull`
    - **Frontend** (type-only here; display work stays in Task 15): `computeAccountDisplayBalances` and every `Balance*Account` shape take `number | null` and count a missing ref value as 0 in base-currency totals; `sumTransactionTotals` (shared) skips a `null` row; the transaction row shows no base-currency amount for `null`; the balance-trend projection, spike panel, transaction-group summary, credit-utilization widget, FIRE archived-holdings sum, vehicle FX ratio, loans aggregate (`outstandingAmount`) and the linked-payments summary treat `null` as "no value"
    - the plan's "stats incomplete marker" alternative was not used: a stats response carries no per-row marker, the transaction list (`refAmountMissing`) is where the user sees what is excluded; Task 15 adds its badge
- [x] `calculateRefAmount`: for custom codes, catch `ExchangeRateUnavailableError` and store `null` plus `refAmountMissing`; ISO codes keep throwing
  - result: `calculateRefAmount` itself still returns `Money` and throws, so the ISO-only callers keep their contract; `calculateRefAmountOrNull` (same file) returns `null` when the error comes from a conversion with a custom side, and rethrows everything else (an ISO miss, any other error). A zero amount converts to zero without a rate. `refAmountMissing` is derived in the `Transactions` `BeforeCreate`/`BeforeUpdate` hook (`syncRefAmountMissing`): it follows `refAmount` on create and whenever `refAmount` changes, so no write path can set one without the other. Converted amounts of a custom currency never touch the Redis ref-amount cache (the user can change the rate at any time and no edit path invalidates it), and the expected miss is not logged as an error. Custom-code detection is `services/currencies/custom-currency-codes.ts` (an existing row never changes kind, so verdicts are remembered per process)
- [x] every reader on the list handles `null` (excluded from sums, or with an explicit "incomplete" marker in stats)
  - result: see the list above. Covered by the typechecks of both packages, a `sumTransactionTotals` case and an `account-balance` case in the frontend, and the e2e "no rate" test (the summary and the spendings exclude the row, the account's `refCurrentBalance` is `null`)
- [x] custom-code conversions bypass `computeCrossRate`/`crossRateCache` and resolve as: the user's custom rate in its stored quote currency, times the normal ISO resolution from that quote to the target currency (`getExchangeRate`, so a manual ISO rate into the base wins, otherwise market) on the transaction's date (this is the single path Task 14 and Task 16 build on)
  - result: `getExchangeRate` hands any pair with a custom side to `resolveCustomPairRate` (`services/user-exchange-rate/resolve-custom-pair-rate.ts`) before the manual-rate check and before the cross-rate cache. (1) A row the user entered for exactly this pair wins. (2) Otherwise each custom side is walked down through the quote of the user's most recently written rate for it, asking for every quote whether it is custom, so a chain through a custom code outside the pair is walked inside one `visited` set (loops are unavailable and never reach `getExchangeRate` again), and the remaining ISO-to-ISO leg goes through `getExchangeRate` with `requireUserConnection: false`, so a manual ISO rate into the base wins and the market fills in otherwise. Custom rates keep full precision (no 5-decimal formatting) and chain through Big. No rate row is written or rewritten. Unit tests: `resolve-custom-pair-rate.unit.ts` (8), `calculate-ref-amount.service.unit.ts` (7)
- [x] e2e:
  - an 8-decimal BTC round trip and a 6-decimal USDT round trip
  - a USDT→USD transfer with both amounts given
  - a custom transaction with no rate, which is saved, flagged and excluded from stats sums
  - two users with different SAT definitions getting different results
  - result: `services/currencies/custom-currency-transactions.e2e.ts`, one file (BTC 8 decimals, an over-precise amount rounded to 8, USDT 6 decimals with the account balance; a USDT value crossed through its USD quote and a manual USD to base rate, then through a changed ISO rate; a USDT to USD transfer valued on both legs; a transfer whose custom leg has no rate flagging only that leg; a transfer into a base-currency leg taking its value; a transaction with no rate saved, flagged, left out of the summary and spendings, and valued by a later edit once the rate exists; a valued row flagged again when its rate is removed before an edit; two SAT definitions valuing 1.5 and 2.4 differently; the collaborator case above; a backup round trip of a flagged row)
- [x] gate: the backend unit and e2e tests pass
  - result: backend typecheck, lint (exit 0), oxfmt, frontend typecheck, lint and unit suite (246 files, 3390 tests), and the backend unit suite (192 suites, 2618 passed) are clean. E2E: the FULL suite, 292 suites passed (2 skipped), 3747 tests passed, 0 failed; the new file runs 14 tests. No new route was added, so `base-currency-guard-coverage.e2e` needed no classification

### Task 14: Base-currency change with custom holdings

**Files:**

- Modify: `services/currencies/change-base-currency.service.ts`, `base-currency-change-drain.ts`, `services/user-exchange-rate/*`
- Create: `services/currencies/change-base-currency.custom.e2e.ts`

- [x] `rebuildTransactions` and the per-day balance sweep resolve custom legs through the user's rate source, crossing via the source's quote currency into the new base
  - result: `rebuildTransactions` and `recalculateAccounts` go through `getExchangeRate` as before, which already hands a custom pair to the Task 13 resolver; no conversion code was added. The per-day sweep is `revalueBalanceHistory` (below)
- [x] custom legs resolve through the user's undated custom rate in its original quote, crossed into the new base with the normal ISO resolution of quote → new base for the transaction's date (the Task 13 resolver path, not separate base-change code)
  - result: confirmed by the e2e: a USDT priced 1:1 in USD is valued exactly like a USD holding on the same day, both for the transaction and the account's ref balance
- [x] no user rate row is rewritten by a base change, custom or ISO
  - result: nothing in the change touches `UserExchangeRates`; the e2e snapshots every rate row (rate and `date`) before and after and compares them, in the plain and the mixed case
- [x] a missing custom rate gives `null` plus `refAmountMissing` and never aborts the base change
  - result: `localCalculateRefAmountOrNull` (change-base-currency.service.ts) answers `null` for an `ExchangeRateUnavailableError` on a conversion with a custom side (zero amounts convert to zero without a rate); ISO misses keep throwing. It is used for the transaction `refAmount` and `refCommissionRate` and the account `refInitialBalance`, `refCurrentBalance` and `refCreditLimit`. The transaction save skips hooks, so `refAmountMissing` is set from `refAmount` in the rebuild itself. Other tables (loans, investments, holdings) are ISO-only and unchanged
- [x] e2e: change base while holding a custom-currency account (with a rate, and without one); ISO-only base change is unchanged; a mixed case (custom holding plus an ISO manual rate such as USD → EUR) keeps the ISO rate row unchanged; in the mixed case, a USDT transaction (USDT → USD custom rate 1, manual ISO USD → EUR 0.95, base EUR) is valued with 0.95, the same as a USD transaction
  - result: `services/currencies/change-base-currency.custom.e2e.ts`, 8 tests. ⚠️ The 0.95 is asserted for entries made after the change: during the rebuild the base is still the old one, and an ISO manual rate applies only when its quote is the current base (the documented ISO rule, left alone), so the rebuild values the USDT and the USD transaction alike from the market and the test asserts they are equal and that the rate rows are unchanged. ISO-only base change is covered by the existing `change-base-currency.*` suites, which pass unchanged
- [x] `revalueBalanceHistory` and the `revalueAccountsInCurrencies` trigger resolve custom-currency accounts through the same crossing (undated custom rate in its quote × ISO resolution of quote → base, per day), instead of returning `skipped`
  - result: `revalueBalanceHistory` resolves each day of a custom account through `getExchangeRate` (no flat-rate shortcut, no 5-decimal market resolver). When no rate reaches the pair it deletes the account's `Balances` rows and returns `skipped`, because rows left from an earlier base would be read as amounts in the current one. `revalueAccountsInCurrencies` now also revalues custom accounts the user prices through an edited code, however many custom steps away (`withDependentCustomCurrencies`)
- [x] e2e: after a base change, a custom-currency account's balance history is expressed in the new base
  - result: in the same file (history equals the USD account's in the new base and the account's ref balance; rebuilds on a custom-rate edit and on an edit of the quote's ISO rate; cleared while no rate exists)
- [x] gate: the full base-change e2e suite passes
  - result: 22 suites, 252 tests, 0 failed: every `services/currencies/` file, `crons/balance-revalue-sweep`, `budget-plans/{guards,restore-plan}`, `loans/loan-balance-history`, `reconciliation`, `user-settings/fire-settings*`, `user-exchange-rate/`, `balances/` and `routes/base-currency-guard-coverage`. Backend typecheck, lint (exit 0), oxfmt and unit suite (192 suites, 2618 passed) are clean

### Task 15: Frontend custom currency management and display

**Files:**

- Modify: the settings currencies page (under `packages/frontend/src/pages/settings`), currency pickers, `formatters.ts` / `composable/formatters.ts`, the transaction list (missing-rate badge)
- Create: the custom-currency dialog component, vitest specs, a Playwright spec under `packages/frontend/e2e`

- ➕ (found in Task 13) the shared and frontend types of the six ref fields are already `number | null`, and Task 13 made every reader type-correct (a missing value counts as 0 in base-currency totals, `null` rows show no base-currency amount). Task 15 only adds the visible side: the missing-rate badge and any "incomplete" hint on totals
- [x] add an "Add custom currency" dialog (code, name, decimals, symbol) and edit/delete actions with the in-use rules
  - result: `custom-currency-dialog.vue` (create and edit, `ResponsiveDialog`) opened from an "Add custom currency" button next to "Add a currency" and from an Edit button on a custom row. The code is uppercased as typed and checked against `^[A-Z0-9]{2,16}$`, the ISO catalogue and the user's own list; name, symbol (up to 8 characters) and decimals (0 to 18) are validated; a live example (`1,234.500000 USDT`) shows the effect. The code is fixed in edit mode. Decimals are locked (with a hint) while an account holds the currency; a refusal for any other use (transactions, templates) is the API's 409 and its message is shown in the dialog, so the in-use rule is enforced where it is decided. Delete reuses the delete button and goes to `DELETE /user/currencies/custom/:code` for a custom row (a 409 shows the API message). A custom row gets a "Custom currency" badge, no flag, the owner's name, an Edit button instead of "Set as base" (a custom currency cannot be the base), and a manual-rate form without the live-update toggle: its inverse keeps 12 significant digits and an empty rate starts blank, quoted against the base. The store merges the user's custom currencies into `systemCurrencies` (so every picker lists them) and exposes `isoCurrencies` / `isoCurrenciesVerbose` for ISO-only pickers (loan, vehicle, portfolio display currency, investment settlement)
- [x] formatters: custom codes use decimal style plus symbol or code, never `Intl` currency style; amounts on an account are formatted and input-limited from the **account's** currency metadata (Task 12), not the viewer's own currency list, so a collaborator sees the owner's decimals; a code the viewer has no definition for (auto-connected through sharing) still renders as custom
  - result: `resolveCurrencyDisplay({ code, meta })` in `js/helpers/currency-decimals.ts` resolves decimals, kind and symbol: an explicit `CurrencyMeta` first, then the registry the currencies store fills (now with `isCustom` and `symbol`), then a second registry of owner definitions seen on shared accounts (filled by the accounts store from `account.currencyMeta`, read only for codes the user's own lists lack, so a code the viewer never defined still renders as custom), then `Intl`, then 2. `formatUIAmount`, `toLocalCurrencyNumber` and `useFormatCurrency().formatAmountByCurrencyCode` take `meta`; a custom code (or one `Intl` rejects) renders as a plain number with its decimals plus the symbol or the code, never in `Intl` currency style (`Intl` accepts any three letters, so `SAT` and `BTC` would otherwise get a currency sign). `meta` is wired where an account or transaction is at hand: transaction table row and list record (amounts, transfer legs), account list row, account header, the transaction dialog (amount, transfer target amount, split dialog), the inline amount editor, and the balance adjustment, initial balance and credit limit editors. Other formatters keep resolving by code (documented limit: a code defined differently by viewer and owner shows the viewer's definition outside those places)
- [x] vitest/Playwright: a collaborator whose SAT definition differs from the owner's sees and enters the owner's decimals
  - result: vitest: `formatters.spec.ts` (viewer SAT 0 decimals, owner SAT 8: `1.50000000 SAT` with the owner's meta, `2 SAT` without), `currency-decimals.spec.ts` (meta beats the registry, fallback fills only undefined codes), `accounts.test.ts` (the store registers a shared account's owner definition and does not override the viewer's own), `balance-adjustment-dialog.test.ts` (an owner-meta SAT account keeps 8 decimals while the viewer's SAT has 0). The Playwright side is covered by the spec below only for the creator's view; a two-user sharing run was not added
- [x] currency pickers list the user's custom currencies; amount inputs follow their decimals; transactions with `refAmountMissing` show a badge
  - result: `systemCurrencies` carries the user's custom currencies, so the account, transaction (original currency), subscription and template pickers list them; ISO-only forms use `isoCurrencies`. Amount inputs take their decimals from `getCurrencyDecimals`, now with the account's `currencyMeta`. `MissingRateIndicator` (a "No rate" badge with an explanation tooltip) shows on a transaction with `refAmountMissing`, in the table's base-currency cell and in the list record; the account list row shows "No rate" instead of the base-currency estimate while `refCurrentBalance` is `null`. Tested by `missing-rate-indicator.test.ts` and `currencies.test.ts`
- [x] add the i18n keys for `en` and `uk` through the `i18n-editor` subagent
  - result: `settings.currencies.custom.*`, `settings.currencies.row.{customCurrency,edit}` and `common.transactions.record.{missingRate,missingRateTooltip}` in `en` and `uk` (edited directly; no subagent in this run; `i18n keys OK`)
- [x] vitest for formatters; Playwright: create USDT, create a USDT account, add a transaction, see `12.345678 USDT` and the missing-rate badge
  - result: vitest: `formatters.spec.ts` (custom code with and without symbol, three-letter custom code, meta), `custom-currency-dialog.test.ts` (14 tests: create payload, uppercasing, ISO/malformed/duplicate/empty refusals, API refusal shown, edit sends only changes, decimals lock, 409 on a decimals change shown). Playwright: `e2e/tests/currencies/custom-currencies.spec.ts` (create USDT in the settings dialog, a USDT account with a 12.345678 expense shows `12.345678 USDT` and the missing-rate badge, the decimals lock). ⚠️ the spec is typechecked but was not executed: it needs the docker dev stack (frontend on 8100, API on 8081), which this run does not start
- [x] gate: frontend typecheck, lint, unit and e2e tests
  - result: frontend typecheck clean, lint exit 0 (the 5 existing warnings only, `i18n keys OK`), oxfmt clean, unit suite 248 files passed (3425 tests, 33 skipped as before). Playwright not run (see above); no backend change in this task

### Phase 3: rate sources

### Task 16: Dated, user-scoped rate resolution

**Files:**

- Create: `packages/backend/src/migrations/20261016020000-currency-rate-sources.ts` (the `effectiveDate` and `source` columns go here)
- Modify: `models/user-exchange-rates.model.ts`, `services/user-exchange-rate/{get-user-exchange-rates,update-exchange-rates,get-exchange-rate}.service.ts`, `services/exchange-rates/build-daily-pair-rate-resolver.ts`, `services/balances/revalue-balance-history.service.ts`
- Create/Modify: unit and e2e tests

- [x] migration: `UserExchangeRates.effectiveDate` (date, part of the key; existing rows get their `createdAt` date) and `source`
  - result: `20261016020000-currency-rate-sources.ts` adds `effectiveDate` (DATE, NOT NULL, in the primary key in place of the `date` write timestamp) and `source` (varchar(32), default `'manual'`). Existing rows get the UTC day of `date`; a same-day duplicate of a pair keeps the row written last. `down` keeps only the latest-day row of each pair (documented in the header; earlier dated rates are lost). Self-contained, no live lists. Checked by `check:money-migration` (now 986 checks, 0 failed: seed with offset timestamps, UTC dating, duplicate collapse, key columns, same-day insert rejected, down, up again)
- [x] backup restore: before archive schema analysis, archives without `effectiveDate` (v1, and v2 exported before this migration) get it filled from each rate row's saved date using the migration's rule; e2e restores such an archive with non-empty user rates
  - result: `restore/fill-user-rate-effective-dates.ts`, called by `loadBackupArchive` right after the v1 money conversion (so before the schema analysis, for every format version): a rate without `effectiveDate` gets the UTC day of its saved `date` (a bad date is a 422), and rows of one pair landing on one day collapse to the one saved last. Unit tests (5) plus e2e in `dated-user-exchange-rates.e2e.ts`: an archive stripped of `effectiveDate`/`source` restores with rates dated by their saved day, and a dated custom history round-trips
- [x] `getRates` and `updateRates` take and write `effectiveDate`; an edit changes only that date's row
  - result: `getRates` takes `asOfDate` and returns rows latest first; `updateRates` / the `PUT /user/currency/rates` pairs take an optional `effectiveDate` (today when omitted) and write the row of that pair and day only; `DELETE /user/currency/rates` pairs take one too. Every write is `source: 'manual'`. An `effectiveDate` on a pair of ISO currencies is a 422
- [x] for **custom codes**, `resolveCustomRate` takes the latest rate on or before the date, ignores `liveRateUpdate` and the quote-is-base condition, and crosses via the stored quote currency
  - result: the dated lookup lives in `resolve-custom-pair-rate.ts`, which `getExchangeRate` already calls before `resolveCustomRate` for any pair with a custom side: the exact pair and each walk step take the row with the latest `effectiveDate` on or before the UTC day of the date, ignoring `liveRateUpdate` and the base. A day before the first rate is unavailable (null plus `refAmountMissing`). `resolveCustomRate` itself stays the ISO path
- [x] for **ISO codes**, behaviour stays date-independent as documented ("a custom rate applies to every date"): the ISO rate UI path writes no `effectiveDate` semantics of its own, and lookups keep using the latest row regardless of the transaction date
  - result: unchanged. `resolveCustomRate` reads the latest row of the pair whatever the date, ISO pairs keep one row (an edit rewrites it) and refuse an `effectiveDate`
- [x] e2e: an ISO manual rate set today still applies to a transaction back-dated before it
  - result: `dated-user-exchange-rates.e2e.ts` (ISO currencies: a USD to AED rate set today values a transaction 9 days back at the manual rate, not the market's)
- [x] keep custom-source rates at full precision (not through `formatRate`); round only the resulting amount
  - result: custom rates never pass `formatRate` (since Task 13) and chain through Big; e2e: SAT to AED 0.000001, 1,000,000 SAT is exactly 1 AED; unit test on the resolver
- [x] the dated resolver keeps the crossing rule: the custom rate effective on the transaction's date (in its stored quote) times the normal ISO resolution from that quote to the current base on the same date; base change therefore needs no extra code here and never rewrites rate rows
  - result: the walk takes the stored quote of the rate in force on the day, and the ISO leg is `getExchangeRate` for the same date
- [x] e2e: USDT → USD manual rate 1 effective Jan 1 and no later row; USD → EUR market 0.8 on Jan 1 and 0.9 on Jan 2; after a base change to EUR, a 10-USDT transaction on Jan 2 is 9 EUR, both when rebuilt and when newly entered
  - result: in the same file (single USDT to USD rate from day 1, USD to EUR 0.8 and 0.9 on the two days: the 10 USDT on day 2 is 40 AED, 9 EUR after the base change, 9 EUR when entered afterwards, every rate row unchanged)
- [x] e2e: change base while holding a custom currency with a backfilled multi-date rate history; each historical refAmount matches the per-date conversion
  - result: in the same file (USDT 1, 2, 3 on three days and EUR 0.5, 0.5, 0.25: the refAmounts are 5, 10, 7.5 EUR after the change)
- [x] `buildDailyPairRateResolver` and `revalue-balance-history` use per-day user rates
  - result: `revalueBalanceHistory` already resolves a custom account through `getExchangeRate` for each day, so the dated rates apply per day with no change. `buildDailyPairRateResolver` reads market rows and is reached only with two ISO currencies, so it is unchanged; the one caller that could hand it a custom pair, `budget-plans/activity/get-plan-cash.ts` (`storedRate`), now resolves a pair with a custom side through `getExchangeRate` for the day
- [x] tests:
  - result: all four covered in `dated-user-exchange-rates.e2e.ts` and `resolve-custom-pair-rate.unit.ts` (back-dated tx, one-date edit and one-date removal, SAT rate, ISO behaviour). The pre-existing `change-base-currency.custom.e2e.ts` back-dates its transactions, so its USDT rates now start on 2000-01-01; `get-combined-balance-history.e2e.ts` passes `effectiveDate` for its direct insert
  - a back-dated transaction uses the rate effective on its date
  - an edit to one date leaves other dates alone
  - a SAT-sized rate (0.000001) converts one million units to exactly 1
  - the existing ISO user-rate behaviour is unchanged
- [x] gate: these tests and the existing user-exchange-rate e2e suite pass
  - result: backend typecheck, lint (warnings only), oxfmt, frontend typecheck; unit suite 193 suites (the known `expiring-upload-cache` DNS flake aside); `check:money-migration` 986 passed; FULL e2e 296 suites: the only failures were `get-combined-balance-history` (fixed, a direct insert needed `effectiveDate`), `get-net-worth-drivers` (a market-rate flake, passes with the former on rerun: 2 suites, 53 tests) and the known `securities-daily-sync` load flake
- [x] ➕ (found in the phase 2 review) `getExchangeRate` built `customCodes` from the requested pair only, so a custom rate quoting another custom code was walked as ISO and the ISO resolution re-entered the custom path with a fresh `visited` set: SAT to COIN plus COIN to SAT (the editor stores both directions) hung a conversion of SAT into any currency without an exact rate
  - result: the resolver now takes `isCustom({ code })` and asks it at every step (so it walks the whole chain in one `visited` set and the ISO leg only ever gets ISO codes), and a step skips rates that quote a code already walked, so the reverse rate the editor stores beside every pair cannot win over a rate that leads out. A walk with nothing left is unavailable. Unit tests (2) and e2e through the pair endpoint and a transaction (2): a pure loop answers 404 / flagged missing, and with COIN to USD present SAT resolves through it

### Task 17: Rate-source configuration model and endpoint

**Files:**

- Modify: `20261016020000-currency-rate-sources.ts` (`UsersCurrencies.rateSource` and `rateSourceConfig`), `users-currencies.model.ts`, shared types
- Create: `packages/backend/src/controllers/currencies/rate-source.ts`, `services/currencies/rate-sources/index.ts`, `rate-source.e2e.ts`

- [x] add the columns, plus a zod discriminated union for the config
  - result: `UsersCurrencies.rateSource` (varchar(16), default `'provider'`) and `rateSourceConfig` (jsonb, null) in the phase 3 migration `20261016020000-currency-rate-sources.ts` (rule 11: same unmerged file; a custom currency row that exists gets `'manual'`, since it has no market feed; `down` drops both columns). Model, shared types (`CURRENCY_RATE_SOURCES`, `PegRateSourceConfig`, `CoingeckoRateSourceConfig`, `HttpRateSourceConfig`, `UpdateCurrencyRateSourceBody`, `CurrencyRateSourceResponse`; `UserCurrencyModel` carries both fields) and the strict zod union in `services/currencies/rate-sources/index.ts`. `check:money-migration` extended (1000 checks, 0 failed: column types, ISO row on `provider`, custom row on `manual`, down removes both, up again). New custom currencies are created on `manual`
- [x] `PUT /user/currencies/:code/rate-source` validates and saves the config only; Tasks 19–21 add the recompute and backfill triggers to this endpoint
  - result: body `{ rateSource, config? }`, behind `checkBaseCurrencyLock` (the 423 is asserted in `routes/base-currency-guard-coverage.e2e.ts`, and the invariant test sees the route as guarded). The service (`rate-sources/set-rate-source.service.ts`) answers 404 for a currency the user does not hold, 422 for a source the currency kind cannot take, a self-peg, a peg to a code the user cannot use, or a synced-source quote that is not an ISO currency; it replaces source and config together and writes no rate. The list endpoint returns both fields
- [x] e2e: each source's valid config; an invalid config → 422; a rate source on an ISO currency → only `provider` or `manual` allowed
  - result: `rate-sources/rate-source.e2e.ts` (40 tests: defaults, each source valid, quote default, source switch drops config, rates untouched, ISO provider/manual accepted and the other three rejected, 28 invalid-body cases that leave the saved source alone, self-peg, foreign/unknown peg, custom or unknown quote, 404 for a code not held or another user's, per-user sources) plus `rate-sources/index.unit.ts` (28)
- [x] gate: these tests pass
  - result: rate-source e2e (40), base-currency-guard-coverage, custom-currencies, add-user-currency, backup (export, restore, v1 restore, ref-amount cache), dated-user-exchange-rates and the user-exchange-rate suites: 12 suites passed; backend typecheck, lint (warnings only), oxfmt, unit suite (194 suites), `check:money-migration` 1000 passed; frontend typecheck and lint (mock user currencies gained the two fields)
  - ⚠️ `http` config has no `headers` yet: Task 21 adds them (encrypted at rest), so the strict schema rejects the key until then and no secret is stored in the clear

### Task 18: Manual and peg resolvers

**Files:**

- Create: `packages/backend/src/services/currencies/rate-sources/manual.ts`, `peg.ts`, unit tests
- Modify: the resolver from Task 16

- [x] manual: dated rates through the extended user-rate endpoints
  - result: the endpoints were extended in Task 16; `rate-sources/manual.ts` now owns the dated stored-rate reads (`findStoredPairRate` for an exact pair, `findStoredCustomRate` for a walk step: latest `effectiveDate` on or before the day, last written wins on a tie), moved out of `resolve-custom-pair-rate.ts` so manual and the synced sources (which store rows the same way) share them
- [x] peg: `factor × rate(pegCurrency, date)` computed when asked; reject peg cycles
  - result: `rate-sources/peg.ts` `findPeg({ userId, code })` returns `none`, `invalid` or `peg`, parsing the saved config defensively with `pegRateSourceConfigSchema` (a backup restores it verbatim). A peg is a step of the one walk in `resolve-custom-pair-rate.ts` (`priceInIsoCurrency`), so there is no second resolver: the step multiplies the factor and moves to the peg currency, which may itself be custom (USDC pegged to USDT, then USDT's dated rate) or ISO (the ISO leg resolves for the same day). The walk's single `visited` set makes a cycle of any length (A to B to A, a restored self-peg) unavailable: `ExchangeRateUnavailableError`, which the callers turn into `null` plus `refAmountMissing` for custom codes and a 404 on the pair endpoint; an unreadable peg config is unavailable too. Factors chain in Big, so 0.1 times 0.2 is exactly 0.02
  - saved-time cycle detection is unchanged (self-pegs only, Task 17)
- [x] unit tests for both resolvers; e2e: USDT pegged to USD gives `refAmount = amount`; a back-dated manual rate applies to a transaction on its date
  - result: `resolve-custom-pair-rate.unit.ts` (pegs: factor, ISO crossing, inverse direction, stale rows ignored, peg onto a custom currency's dated rate, chained factors, two- and three-currency cycles, restored self-peg, 6 unreadable configs, a manual currency unaffected) and `peg.unit.ts` (config parsing); the manual lookups keep their existing resolver unit coverage. e2e `rate-sources/peg-rate-source.e2e.ts` (7): a peg to the base gives `refAmount = amount`; a peg to USD crosses the market rate of the day; the factor and its inverse; a peg beats rows stored before it; switching back to manual restores them; USDC pegged to USDT follows USDT's dated manual rates; a peg cycle answers 404 and flags the transaction `refAmountMissing`. The back-dated manual rate case is `dated-user-exchange-rates.e2e.ts` (Task 16)
- [x] gate: these tests pass
  - result: e2e (one batched run, 5 suites, 85 tests): peg-rate-source, rate-source, dated-user-exchange-rates, custom-currency-transactions, change-base-currency.custom; backend unit suite (195 suites), typecheck, lint (warnings only), oxfmt

### Task 19: Recompute base-currency amounts for custom currencies

**Files:**

- Create: `packages/backend/src/services/currencies/recompute-custom-ref-amounts.service.ts`, unit tests, `recompute-custom-ref-amounts.e2e.ts`
- Modify: the rate-source endpoint, the manual-rate endpoints, the backfill completion hooks

- [x] expand the affected set first: starting from the changed currency and dates, follow the user's reverse peg and quote dependencies (a currency pegged to, or quoted via, a changed one) until no new currency is added, carrying the affected dates along
  - result: `recompute-scope.ts` (pure): `buildScope` and `expandScope` follow the dependency edges (`loadDependencyEdges`: the user's peg configs and the base-to-quote pairs of their stored rates, dependents restricted to custom codes) to a fixpoint; a dependent inherits every interval and mode of its source, and a cycle ends because an interval is added once per currency. Unit tests: pegged, chain, unrelated, cycle, inherited intervals
- [x] service: for one user, the expanded set of custom currencies and the dates whose effective rate changed, recompute `refAmount`, `refCommissionRate`, split ref amounts, account ref balances and `refAmountMissing`, then schedule the balance-history rebuild
  - result: `recomputeCustomRefAmounts({ userId, changes, remeasureSpot })` in `recompute-custom-ref-amounts.service.ts`, one DB transaction joined with the caller's. A change is `{ currencyCode, from, to, mode }` (UTC days, `to` exclusive, `null` open). Per currency it loads the author's rows (planned, adjustments and soft-deleted included) in the span, keeps those the intervals match, converts with `calculateRefAmountOrNull` (`bypassCache`, the account owner's decimals) and writes only a row whose value differs, with hooks off like the base change does (the hooks would move balances this does not touch), setting `refAmountMissing` from the new value. Splits follow their transaction. Accounts: `restampRefInitialBalance` (boundary-date opening stamp), `remeasureRefBalances` now takes `currencyCodes` for a targeted spot re-measure, then `scheduleBalanceRevalue` per account. A transfer leg whose counterpart (same author) is in the base currency is anchored to that leg's amount, not a rate, so it is skipped
- [x] every trigger (source change, manual-rate edit, backfill completion, daily-sync fill) clears the user's ref-amount cache through the Task 5 prefix helper after commit, including entries for dependent currencies; the recompute itself calls `calculateRefAmount` with `bypassCache: true`
  - result: the service calls `clearUserRefAmountCacheAfterCommit` (`services/clear-ref-amount-cache.ts`, the `buildRefAmountCachePattern` prefix delete, deferred to the ambient transaction's `afterCommit`) once per call, which covers the whole expanded set because the pattern is the user's. Conversions involving a custom code are never cached in the first place, so the clear is a guard for entries of other pairs; the recompute converts with `bypassCache: true`
- [x] e2e: after correcting a rate, a new transaction with the same amount, pair and date as an earlier one gets the corrected rate
  - result: `recompute-custom-ref-amounts.e2e.ts` (corrected 3 to 4: the saved 10 USDT goes 30 to 40, the next identical one is 40, the account's ref balance is -80); also splits, a correction that covers only its own days, a quoted custom currency, and an anchored transfer leg that keeps its value
- [x] trigger it on source change, backfill completion and manual-rate edits for past dates; the daily sync only fills `refAmountMissing` rows on the newly added date; never for ISO currencies
  - result: wired for a source change (`setCurrencyRateSource`, only when the saved source or config differs and the currency is custom), and for manual-rate edits and removals (`editUserExchangeRates`, `removeUserExchangeRates` via `custom-rate-changes.ts`: `planRateChanges` before the write, `resolveRateChanges` after it adds the day the new state ends). A rate that replaces a stored one, lands on a past day, or is removed values every row of its days (`recompute`); a rate for a new day that is not in the past only fills `refAmountMissing` rows (`fill`). The backfill-completion and daily-sync entry points are the same service: ➕ Tasks 20 and 21 call it (`recompute` over the backfilled days, `fill` for the new day) when they add those jobs. ISO pairs never plan a change (only a custom base side does) and an ISO source change is skipped
- [x] unit test: adding a rate for a new date selects no previously valued transaction
  - result: `recompute-scope.unit.ts` (11): a `fill` interval matches only a row with `refAmountMissing`, a `recompute` interval matches valued and unpriced rows alike, the end day is exclusive, open sides are unbounded, the envelope of several selectors
- [x] e2e: USDC pegged to USDT with a dated manual USDT/USD rate of 1; a 10-USDC transaction; correcting that historical USDT rate to 2 recomputes the USDC transaction to 20
  - result: in the new e2e, twice (a peg set before the transaction, and the same with a COIN currency pegged to nothing staying at 70). The rate is USDT to the base (AED) rather than to USD, which keeps the assertion on the peg dependency instead of on a market cross
- [x] e2e: create a custom-currency transaction **before** configuring a source (missing state), configure a peg, and check the transaction's `refAmount`, the account's ref balance and the stats; ISO transactions stay untouched
  - result: the unpriced 10 USDT row becomes 10 (flag cleared), the account's ref balance goes from null to -10, the category stats sum is 50 with the ISO row; the market rate of the ISO row's day is doubled before the peg and the ISO transaction keeps 40. Also: re-saving the same source writes nothing (`updatedAt` unchanged), and an ISO manual rate leaves a saved ISO transaction alone
- [x] gate: these tests pass
  - result: one batched e2e run, 8 suites, 164 tests, after fixing one wrong test assertion (the create response carries no splits) re-run of the new file alone: 14 passed. Batch: recompute-custom-ref-amounts, the phase 2 sanity files (custom-currency-transactions with the SAT/COIN loop and the bulk-selection cases, custom-currencies with backup and prune, transaction-portfolio-link), and the Task 16-18 files this touches (dated-user-exchange-rates, rate-source, peg-rate-source, update-exchange-rates.service). Backend typecheck, lint (warnings only), oxfmt, unit suite (196 suites, 2694 tests)

### Task 20: CoinGecko rate source

**Files:**

- Create: `packages/backend/src/services/currencies/rate-sources/coingecko.ts`, unit tests, e2e with mocked HTTP (following the existing provider test mocking pattern)
- Modify: cron registration (`crons/`), `services/investments/data-providers/coingecko-provider.ts` (reuse its client; extract it if needed)

- [x] coin search endpoint for the config UI; history backfill on configure, respecting rate limits
  - result: `GET /user/currencies/coingecko/search?query=` (read-only, not behind the base-currency guard; 503 without `COINGECKO_API_KEY`) returns `{ coinId, symbol, name, logoUrl, marketCapRank }`, reusing `CoinGeckoDataProvider.searchSecurities` (derivative tokens filtered). The SDK client moved to `data-providers/clients/coingecko-client.ts` (`createCoingeckoClient`, `getCoinGeckoKey`, `requireCoinGeckoKey`), shared by the securities provider and the rate source. `rate-sources/coingecko.ts` holds the calls (`fetchCoingeckoHistory`: one `getRange` over the last 364 days, always wider than 90 days so CoinGecko answers one point per day; `toDailyRates` keeps the latest point of each UTC day; `fetchCoingeckoLatestPrices`: batched `simple/price`, `precision: 'full'`). `PUT .../rate-source` with a changed coingecko source answers once the save has committed and then runs `backfillCoingeckoRates` (outside the save's transaction); a failed backfill is logged (`COINGECKO_RATE_BACKFILL_FAILED`) and never fails the save. One call per configure, so the limit is respected by construction; saving the same source again fetches nothing
- [x] daily sync cron, deduplicated by `coinId` per day, storing rates per user in the configured `quoteCurrency` with `source='coingecko'`, then triggering Task 19
  - ➕ call `recomputeCustomRefAmounts` (Task 19, `mode: 'fill'` for the new day, `mode: 'recompute'` over the days a backfill wrote, `remeasureSpot` left on) after the rates commit; also call it when the configure-time backfill completes
  - result: `crons/coingecko-rates-sync.ts` (`30 0 * * *` UTC, prod-only list in `background-jobs.ts`, behind a Redis lock) runs `syncCoingeckoRates` (`rate-sources/coingecko-sync.ts`). Sources are grouped by coin and quote, so a coin is fetched once however many users or currencies take it, with `COINGECKO_SYNC_SPACING_MS` (2.5 s) between calls to stay under the Demo plan's per-minute limit. A currency with no rows from this source yet is backfilled (last year) instead of asked for today's price, which is how a failed configure-time backfill heals. `storeCoingeckoRates` writes one user's rates and calls `recomputeCustomRefAmounts` in the same transaction: a backfill is `recompute` from its earliest written day, a new day is `fill`, and a day whose price changed is `recompute`
- [x] e2e: change base while a CoinGecko source is configured; no re-fetch happens and refAmounts come out right through the quote crossing
  - result: `coingecko-rate-source.e2e.ts`: USD-quoted BTC history, base AED to EUR; the rebuilt transaction is 0.5 x 20 x EUR-per-USD, a new one is valued the same way, neither `getRange` nor `simple/price` is called again and the rate rows are identical
- [x] tests: the backfill fills dates; a sync failure keeps the last rate and logs; a transaction gets its `refAmount` after the backfill
  - result: unit `coingecko.unit.ts` (daily grouping, latest point of a day, midnight edge, tiny prices, malformed points, 429 detection) and the e2e above (16 tests): search (mapped and derivative-free, empty, blank query 422, 503 without key); backfill values a waiting transaction (a day before the first rate stays missing) and later ones; a failed backfill keeps the source, logs, and the daily sync backfills; 503 and nothing saved without a key; saving twice fetches once; a manual rate survives the backfill and switching coin drops the old coin's rows; a new day's rate leaves valued rows alone and prices only new ones; a changed price for a stored day values it again, an identical one writes nothing; one `simple/price` call for two currencies on the same coin; a failed price call keeps the last rate and logs `COINGECKO_RATE_SYNC_FAILED`; a 429 ends the run; empty sync. CoinGecko is never called for real (the SDK is mocked globally, each test rebinds `getRange`, `simple.price.get` and `search.get`)
- [x] gate: these tests pass
  - result: one batched e2e run, 6 suites: coingecko-rate-source, rate-source, peg-rate-source, securities-daily-sync.service and securities search (both use the extracted client), base-currency-guard-coverage. The new file's first run had 2 wrong test expectations (spot balance is re-measured at the latest rate; `coinsFetched` counts a coin once), fixed and the file alone re-run: 16 passed. Backend typecheck, lint (warnings only), oxfmt, unit suite (197 suites, 2701 tests). Shared type `CoingeckoCoinSearchResult` added; frontend typecheck not run (additive type only)

### Task 21: Generic HTTP/JSON rate source

**Files:**

- Create: `packages/backend/src/services/currencies/rate-sources/http.ts`, unit tests, e2e with a local mock server run under `useSelfHost()`
- Modify: the rate-source controller (the test endpoint)

- [x] URL template substitution (`{date}`, `{code}`, `{quote}`), rates stored in the configured `quoteCurrency`, JSON-path extraction, optional headers (stored encrypted like AI connection keys)
  - result: `rate-sources/http.ts` (`buildHttpRateUrl`, `readJsonPath` against `JSON_PATH_PATTERN`, own properties only and array positions only, `toRate` for a JSON number or plain decimal string, `extractRate`, `fetchHttpRate`). Rates are stored in the config's `quoteCurrency` (default USD) with `source='http'`, at full precision. Headers: the body takes `headers` (RFC token names, printable-ASCII values, at most 10, no `Host`/`Cookie`/`Content-Length`-style names, unique case-insensitively), saved as one `encryptToken` blob in the new `UsersCurrencies.rateSourceHeadersEncrypted` column (phase 3 migration, rule 11; `check:money-migration` extended) that the model's default scope leaves out of every ordinary read. The saved config carries only `headerNames`; responses, the user-currency list and logs never carry a value. An update that names no headers keeps the saved ones, `{}` removes them. Backups drop the blob and the names (`stripSecret: 'rateSourceHeaders'`, also enforced on restore)
- [x] fetch through `createGuardedFetch` from `common/utils/url-guard.ts`, with a thin wrapper adding a 5-second timeout and a 256 KB limit, and https-only **only when `isGuardBypassed()` is false**, so self-hosters can reach LAN http endpoints and the e2e mock server works
  - result: `fetchJson` in `http.ts` wraps `createGuardedFetch()` (`isGuardBypassed` is now exported): 5 s `AbortSignal.timeout` covering the body, a 256 KB cap checked on `Content-Length` and while streaming, https required while the guard is on (also checked when the source is saved or previewed), `redirect: 'error'` always so a header never follows a redirect (the guard already refuses 3xx). Errors carry a `reason` and never the URL or a header
- [x] e2e: with the guard on (no `useSelfHost()`), an http URL is rejected
  - result: `http-rate-source.e2e.ts` cloud group: an http URL is a 422 on save and on preview (no request made); loopback, private, link-local and IPv6-loopback https URLs answer a preview with `ok:false, reason:'blocked'`; a blocked first fetch does not fail the save
- [x] `POST /user/currencies/:code/rate-source/test` returns a preview without saving
  - result: body `{ rateSource: 'http', config, date? }` (same rules as the save, headers optional and defaulting to the saved ones), answers `{ ok: true, date, rate, quoteCurrency }` or `{ ok: false, reason, message }` (200, so the editor can show it), saves nothing. 20 per minute per user (`rateSourceTestRateLimit`); exempt from the base-currency guard (listed in `base-currency-guard-coverage.e2e.ts`). Shared types `TestCurrencyRateSourceBody/Response`, `RATE_SOURCE_TEST_FAILURES`
- [x] unit tests for templating, path extraction and the wrapper limits; e2e for the preview and a daily sync
  - ➕ the daily sync calls `recomputeCustomRefAmounts` (Task 19) with `mode: 'fill'` for the new day
  - result: unit `http.unit.ts` (templating, paths, rate parsing, timeout including a stalled body, size limit with and without `Content-Length`, https-only, redirects, error mapping), `http-headers.unit.ts`, `index.unit.ts` (header and test-body schemas). e2e `http-rate-source.e2e.ts` (42): preview (filled URL, headers sent, nothing saved or stored, each failure reason, saved headers reused, redirect not followed, 404/422 cases), save (header names only in responses and in `GET /user/currencies`, blob not readable, today's rate fetched and stored in the quote, waiting rows valued, keep/replace/clear headers, old rows replaced on a URL change and kept on a header change, a manual rate for the day kept, failed first fetch logged without URL or secret), backup (secrets and names never exported, an archive's own blob and names ignored on restore) and the daily sync (`cron http-rates-sync`, 00:45 UTC, Redis lock, prod-only list: a changed rate is replaced and its rows valued again, unchanged writes nothing, rows waiting after a failed first fetch get priced, failures keep the last rate, one failing currency does not stop the others, identical requests of two users make one call, different headers do not merge). The store is shared with CoinGecko (`store-synced-rates.ts`, `storeSyncedRates({ source })`), which now also lets a synced source replace a day written by another synced source (never a manual one)
- [x] gate: these tests pass
  - result: one batched e2e run, 8 suites (http-rate-source, rate-source, peg-rate-source, coingecko-rate-source, base-currency-guard-coverage, export-backup, restore-backup, custom-currencies): the 7 existing suites passed at once; the new file needed two re-runs of that file alone (an awaited body cancel stalled under MSW, and a second user without a base currency cannot save a recomputing source): 42 passed. Backend typecheck, lint (warnings only), oxfmt, unit suite (199 suites, 2774 tests), frontend typecheck and lint
  - ⚠️ no history backfill for HTTP sources (the endpoint is arbitrary, a request per day is unsafe): configuring fetches today's rate and the daily sync keeps going; earlier days stay `refAmountMissing` until the user enters rates by hand

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
