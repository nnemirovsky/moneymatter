# Custom currencies with per-currency precision and rate sources

## Overview

MoneyMatter stores every transactional amount as 2-decimal integer cents, accepts only ISO 4217 currency codes, and gets rates only from fiat providers. That makes crypto and other non-ISO units impossible to track: `0.00040641 BTC` rounds to `0.00`, `USDT` fails validation (and does not fit the `varchar(3)` code columns), and there is no rate source for it.

This plan delivers three features, in three phases that each leave the app working and can each become a separate upstream PR:

1. **Per-currency precision.** Monetary columns move from BIGINT cents to DECIMAL, and each value is rounded to its currency's own number of decimals (USD 2, JPY 0, KWD 3, BTC 8, USDT 6).
2. **Per-user custom currencies.** A user defines codes such as USDT, USDC, BTC, ETH or SAT with a name, symbol and number of decimals, the same way they own categories. Other users never see them.
3. **Pluggable rate sources** per custom currency: manual dated rates, a peg to another currency (USDT = 1 USD), CoinGecko, and a generic HTTP/JSON source.

Motivation: importing an existing ledger (1932 rows, 44 accounts including USDT, USDC, BTC and ETH accounts) without losing data. The work happens in a fork on `feat/custom-currencies` and is offered upstream as a feature request.

## Context (from discovery)

- **Money core:** `packages/backend/src/common/types/money.ts` (Big.js-backed `Money`), `packages/backend/src/common/types/money-column.ts` (`@MoneyField`, with `storage: 'cents'` mapping to BIGINT and `'decimal'` to DECIMAL).
  - 33 `storage: 'cents'` fields across 13 models: accounts (6), balances, budget-assignments (2), budget-line-goals (3), budget-plans, budget, import-batch-account-effects, loan-details (6), subscriptions, transaction-splits (2), transaction-templates, transactions (6), vehicles (2).
  - 29 fields already use `storage: 'decimal'` (investments, `DECIMAL(20,10)` and one `(36,18)`). This existing path is what phase 1 builds on.
- **Raw access:** 252 `raw: true` queries outside migrations and tests, about 20 money `SUM(...)` aggregates, and 231 `fromCents`/`toCents` call sites. Each raw read of a cents column has to be checked, because after migration it returns a decimal string instead of an integer.
- **Currencies:** the global `Currencies` table (`code varchar(3)` primary key, `currency`, `digits`, `number`, `isDisabled`) is referenced by foreign keys from about 15 tables. `UsersCurrencies` is the per-user list (`isDefaultCurrency`). 21 `STRING(3)` model columns.
  - **Validation:** `common/lib/zod/custom-types.ts` `currencyCode()` (`.length(3)` + `cc.code()` from `currency-codes`), plus `monobank.provider.ts` and `statement-parser/extraction-prompt.ts`.
- **Rates:** `services/exchange-rates/` holds the provider registry (`providers/{currency-rates-api,fawaz-currency-api,api-layer}`, `registry.ts`, `base-provider.ts`, `merge-provider-rates.ts`), `build-daily-pair-rate-resolver.ts`, `get-exchange-rates-for-date.ts`, `ensure-rates-for-date.ts` and `sync-exchange-rates.ts`.
  - Per-user overrides live in `services/user-exchange-rate/` (`UserExchangeRates`: userId, base, quote, rate, date).
  - The CoinGecko client lives in `services/investments/data-providers/coingecko-provider.ts`.
  - Base currency handling: `services/currencies/change-base-currency*`, `base-currency-lock.ts`, and the `checkBaseCurrencyLock` middleware.
- **Frontend:** currency formatting in `frontend/src/js/helpers/formatters.ts` and `frontend/src/composable/formatters.ts` (`Intl.NumberFormat` with `style: 'currency'`, which throws on non-ISO codes such as `USDT`), plus 6 component-level formatters (payees, plan-billing, walutomat, lunchflow, depreciation chart).
- **Conventions (repo CLAUDE.md):**
  - Object params and kebab-case files.
  - Every new endpoint needs e2e tests through HTTP helpers.
  - Use the `test-runner` subagent and never run e2e in parallel.
  - Change unmerged migrations rather than adding new ones.
  - i18n changes go through the `i18n-editor` subagent and always cover `en` and `uk`.
  - API and frontend always work in decimals.
  - Comments describe the current code, not its history.
  - Stop and ask after 1–2 failed fix attempts.

## Development Approach

- **Testing approach:**
  - **Phase 1 is test-first (TDD).** Precision tests are written and failing before the refactor, because the refactor touches the money core and silent corruption is the main risk.
  - **Phases 2–3 are regular:** code first, then tests within the same task.
- Complete each task fully before moving to the next, with small, focused changes.
- **Every task includes new or updated tests** for the code it changes, covering both success and error scenarios. Tests are a required deliverable, not an extra.
- **All tests must pass before the next task starts.** Use the repo's `test-runner` subagent, and run e2e serially.
- **Keep this plan current:** update it when scope changes during implementation.
- **Backward compatibility:**
  - Existing cents data migrates losslessly (value / 100).
  - API payloads keep decimal numbers.
  - ISO-only users see no behavior change except correct rounding for 0- and 3-decimal currencies (JPY, KWD and others).
- **Commits:** none unless the user asks. One phase maps to one future PR.
- **Where tests run:** run e2e and build verification on ritchie (x86, 12 GB) when the Mac's Docker runs out of memory.

## Testing Strategy

- **Backend unit tests** (`npm run test:unit` in `packages/backend`): the Money and rounding helpers, the precision lookup, rate-source resolvers, the HTTP source's URL templating and JSON-path extraction, and the SSRF guard.
- **Backend e2e** (`npm run test:e2e` in `packages/backend`, through HTTP helpers only): every new or changed endpoint, covering happy path, empty state and an error case.
- **Frontend unit tests** (`npm run test:unit` in `packages/frontend`): formatters for ISO and custom codes at 0, 2, 3, 6 and 8 decimals; amount input precision.
- **Frontend Playwright e2e** (`packages/frontend/e2e`): add or extend specs for creating a custom currency, a transaction in it, and configuring a rate source.
- **Typecheck and lint** in both packages after every task.

## Progress Tracking

- Mark completed items `[x]` immediately.
- Prefix newly discovered tasks with ➕ and blockers with ⚠️.
- Keep this plan in sync with the actual work.

## Solution Overview

### Phase 1: precision

- Convert the 33 cents fields to `@MoneyField({ storage: 'decimal', precision: 36, scale: 18 })`, so amounts keep 18 integer digits (no VND/IDR overflow) and 18 decimals.
- A single migration changes each column to `DECIMAL(36,18)` with `USING col::numeric / 100`. The `down` migration multiplies by 100 and rounds.
- **Precision source:** `Currencies.digits` (ISO minor units, already in the table). One cached helper, `getCurrencyDecimals({ code })`.
- **Rounding:** a `roundToCurrency({ money, currencyCode })` helper applied on every write path that creates or derives an amount: transactions, transfers, splits, `refAmount`/`refCommissionRate` (rounded to the base currency), and balances. Values the user enters exactly are rounded to their currency's decimals. Computed values are rounded once, at write time.
- **Raw-query audit:** raw reads of migrated columns switch from `Money.fromCents(x)` to `Money.fromDecimal(x)`, and SQL aggregates drop any cents arithmetic. `centsToApiDecimal` usages on migrated fields are replaced with a decimal serializer.

### Phase 2: custom currencies

- **Code registry:** the global `Currencies` table, so existing foreign keys stay intact. New columns: `isCustom boolean`, `symbol varchar(8) null`, `createdByUserId int null`.
  - A custom code row is created on first definition.
  - **Ownership and visibility are per user**, through `UsersCurrencies`. A user sees ISO currencies plus the custom codes in their own `UsersCurrencies`. The name, symbol and decimals a user sees come from per-user override columns on `UsersCurrencies`, so two users can define `SAT` differently without conflict.
- **Code columns:** widen the 21 `varchar(3)` currency-code columns to `varchar(16)`.
- **Validation:** `currencyCode()` checks the format `^[A-Z0-9]{2,16}$`, plus existence in `Currencies` and visibility to the user. ISO-only checks remain only where a provider genuinely needs ISO (monobank numeric codes).
- **Base currency:** a custom currency cannot be the base currency in this iteration. That keeps the base-currency change pipeline untouched.
- **Missing rates:** a custom currency with no rate for a date yields an explicit "rate missing" state on the transaction (`refAmount` null plus a review flag). It never silently converts at 1.0.

### Phase 3: rate sources

- **Configuration:** `UsersCurrencies` gets `rateSource` (`provider` | `manual` | `peg` | `coingecko` | `http`) and `rateSourceConfig jsonb`. `provider` is the default and keeps today's behavior for ISO currencies.
- **Storage:** all custom-currency rates are stored per user in `UserExchangeRates` (dated, with a new `source` column). The existing user-rate precedence in the resolvers therefore applies unchanged.
  - **manual:** the user enters dated rates; the resolver uses the latest rate on or before the transaction date.
  - **peg:** `{ pegCurrency, factor }`. The resolver computes `factor × rate(pegCurrency, date)` when asked, and nothing is stored.
  - **coingecko:** `{ coinId }`. History is backfilled when configured, then synced daily. Fetches go through the existing CoinGecko client, deduplicated across users by `coinId` per day.
  - **http:** `{ urlTemplate, jsonPath, headers? }`, with `{date}`, `{code}` and `{base}` placeholders. Has a test-fetch preview endpoint and a daily sync.
- **SSRF guard for http:**
  - https only;
  - private, loopback and link-local addresses blocked unless `IS_SELF_HOST`, the same policy as custom AI endpoints;
  - 5-second timeout, 256 KB response limit, no redirects to blocked hosts.

## Technical Details

- **Decimal type:** `DECIMAL(36,18)`. The JS API keeps sending JSON numbers. Inputs beyond float precision are out of scope and documented.
- **Rounding mode:** ROUND_HALF_UP via `Money.round(dp)`, reusing the existing Big.js behavior.
- **Migrations:** three files, one per phase, each with a working `down`.
  - Phase 1: the column type conversion.
  - Phase 2: `Currencies` columns, `UsersCurrencies` overrides, and widening the code columns. Foreign key columns must be widened in dependency order, or the constraints dropped and recreated.
  - Phase 3: the rate-source columns and `UserExchangeRates.source`.
- **API (phase 2):**
  - `POST /user/currencies/custom` (`code`, `name`, `decimals` 0–18, `symbol?`) creates the currency and adds it to the user's currencies.
  - `PUT /user/currencies/custom/:code` updates `name`, `symbol` and `decimals`. Changing decimals is allowed only while no rows use the currency.
  - `DELETE /user/currencies/custom/:code` is allowed only if unused.
  - The existing currency list endpoints include `isCustom`, `symbol` and `decimals`.
- **API (phase 3):**
  - `PUT /user/currencies/:code/rate-source` (`rateSource`, `rateSourceConfig`) validates the config per source and triggers a backfill for coingecko and http.
  - `POST /user/currencies/:code/rate-source/test` returns a preview of today's rate and of one historical date.
- **Frontend formatting:**
  - ISO codes keep `Intl` currency style.
  - Custom codes use `Intl` decimal style with the currency's decimals, followed by the symbol (or the code if there is no symbol).
  - Amount inputs accept up to the currency's decimals.

## What Goes Where

- **Implementation Steps:** all code, migrations, tests and docs in this repo.
- **Post-Completion:** deployment on ritchie, the ledger import script, and upstream discussion and PRs.

## Implementation Steps

### Phase 1: per-currency precision (TDD)

### Task 1: Write failing precision tests

**Files:**
- Create: `packages/backend/src/common/lib/currency-precision.unit.ts`
- Create: `packages/backend/src/controllers/transactions.controller/currency-precision.e2e.ts`

- [ ] unit tests for the planned `getCurrencyDecimals` and `roundToCurrency` helpers: USD 2, JPY 0, KWD 3, unknown code → error
- [ ] e2e: create a KWD account and transaction `1.234` → read back `1.234`; JPY `1500.6` → `1501`; USD `12.176673309` → `12.18`
- [ ] e2e: account balance after several KWD transactions equals the exact sum (no 2-decimal drift)
- [ ] e2e: `refAmount` of a JPY transaction is rounded to the base currency's decimals
- [ ] run the tests and confirm they fail for the expected reason (precision lost), not on setup errors

### Task 2: Currency precision helpers

**Files:**
- Create: `packages/backend/src/common/lib/currency-precision.ts`
- Modify: `packages/backend/src/models/currencies.model.ts`

- [ ] implement `getCurrencyDecimals({ code })` reading `Currencies.digits`, with an in-process cache that is invalidated when a currency changes
- [ ] implement `roundToCurrency({ money, currencyCode })` on top of `Money.round(dp)`
- [ ] check the seeded `digits` values against ISO minor units (JPY 0, KWD 3, BHD 3) and add a data fix to the phase 1 migration if any are wrong
- [ ] make the unit tests from Task 1 pass
- [ ] run the backend unit tests; they must pass before Task 3

### Task 3: Migrate cents columns to DECIMAL

**Files:**
- Create: `packages/backend/src/migrations/20261016000000-money-columns-to-decimal.ts`
- Modify: the 13 models with `storage: 'cents'` (accounts, balances, budget-assignments, budget-line-goals, budget-plans, budget, import-batch-account-effects, loan-details, subscriptions, transaction-splits, transaction-templates, transactions, vehicles)

- [ ] migration: each of the 33 columns becomes `DECIMAL(36,18)` with `USING col::numeric / 100`, keeping nullability and defaults; `down` reverses with `round(col * 100)::bigint`
- [ ] switch the 33 `@MoneyField({ storage: 'cents' ... })` declarations to `storage: 'decimal', precision: 36, scale: 18`
- [ ] add a test that runs the migration up and down on a seeded copy and asserts values round-trip; if the repo has no migration test harness, write a scripted check and record its output in this plan
- [ ] run typecheck; it must pass before Task 4

### Task 4: Audit raw queries and aggregates (transactions, accounts, balances)

**Files:**
- Modify: `packages/backend/src/services/transactions/**`, `services/accounts/**`, `services/balances/**`, `services/stats/**`, `serializers/**`

- [ ] find every raw read of a migrated column (`raw: true`, `sequelize.query`, `literal`, `fn('SUM')`) in these domains and switch `Money.fromCents` to `Money.fromDecimal`
- [ ] remove cents arithmetic from SQL aggregates and serializers (`centsToApiDecimal` on migrated fields)
- [ ] keep `toCents()` only for fields still stored as cents (should be none after Task 3; delete dead helpers if so)
- [ ] run the existing e2e suites for transactions, accounts, balances and stats, plus the Task 1 tests
- [ ] all must pass before Task 5

### Task 5: Audit raw queries and aggregates (budgets, subscriptions, loans, vehicles, imports)

**Files:**
- Modify: `packages/backend/src/services/{budgets,budget-plans,subscriptions,loans,vehicles,import-export}/**`, related serializers

- [ ] same audit as Task 4 for the remaining domains
- [ ] cover the import pipeline: CSV, text-source, OFX, YNAB and Wallet executors write decimals correctly
- [ ] grep check: no `fromCents`/`toCents` remains on a migrated field; record the final count in this plan
- [ ] run the full backend e2e suite serially through `test-runner`
- [ ] all must pass before Task 6

### Task 6: Apply per-currency rounding on write paths

**Files:**
- Modify: `packages/backend/src/services/transactions/create-transaction*`, `update-transaction*`, transfer creation, splits, refund linking, ref-amount calculation, `services/accounts/*balance*`

- [ ] round `amount`, `commissionRate` and `cashbackAmount` to the account currency, and `originalAmount` to its original currency
- [ ] round `refAmount` and `refCommissionRate` to the user's base currency
- [ ] round split amounts to the parent transaction's currency, and make the split-sum validation compare rounded values
- [ ] make all Task 1 e2e tests pass; add tests for transfers between a 0-decimal and a 3-decimal account
- [ ] run the backend unit and e2e tests; they must pass before Task 7

### Task 7: Frontend formatting and inputs by currency decimals

**Files:**
- Modify: `packages/frontend/src/js/helpers/formatters.ts`, `packages/frontend/src/composable/formatters.ts`, amount input components (locate with ast-grep)
- Create/Modify: matching `*.spec.ts` / vitest files

- [ ] formatters take the currency's decimals instead of assuming 2
- [ ] amount inputs accept and show up to the currency's decimals
- [ ] vitest: format and parse for JPY, USD and KWD, plus large VND values
- [ ] run frontend typecheck, lint and unit tests; they must pass before Task 8

### Phase 2: per-user custom currencies

### Task 8: Schema for custom currencies and wider codes

**Files:**
- Create: `packages/backend/src/migrations/20261016010000-custom-currencies.ts`
- Modify: `packages/backend/src/models/currencies.model.ts`, `users-currencies.model.ts`, and every model with a `STRING(3)` currency column (21)

- [ ] add `Currencies.isCustom`, `symbol` and `createdByUserId`, plus `UsersCurrencies.nameOverride`, `symbolOverride` and `decimalsOverride`
- [ ] widen the 21 currency-code columns to `varchar(16)`, handling the foreign key constraints; `down` must refuse if any custom codes exist
- [ ] update the model declarations and shared types (`packages/shared/src/types`)
- [ ] verify the migration up and down on a seeded copy
- [ ] run typecheck and the backend e2e smoke tests (currencies, accounts); they must pass before Task 9

### Task 9: Currency-code validation from the database

**Files:**
- Modify: `packages/backend/src/common/lib/zod/custom-types.ts`, controllers that call `currencyCode()`, `services/import-export/statement-parser/extraction-prompt.ts`
- Create: `packages/backend/src/common/lib/zod/custom-types.unit.ts` (or extend the existing one)

- [ ] `currencyCode()` checks the format `^[A-Z0-9]{2,16}$`; services check existence and that the code is visible to the requesting user
- [ ] keep ISO-specific checks only where needed (monobank numeric mapping)
- [ ] let the statement-parser prompt and import mapping recognise the user's custom codes
- [ ] unit tests for the format, and e2e: another user's custom code is rejected; an unknown code is rejected with the list of valid ones
- [ ] run the tests; they must pass before Task 10

### Task 10: Custom currency CRUD endpoints

**Files:**
- Create: `packages/backend/src/controllers/currencies/custom-currencies.ts`, `services/currencies/custom-currencies.service.ts`
- Modify: the currencies route file and currency list serializers
- Create: `packages/backend/src/services/currencies/custom-currencies.e2e.ts`

- [ ] `POST /user/currencies/custom`: create, or reuse an existing global code row, then attach it to the user with overrides
- [ ] `PUT` and `DELETE` with the "only if unused" rules; currency list endpoints return `isCustom`, `symbol` and `decimals` (with overrides applied)
- [ ] block making a custom currency the base currency
- [ ] e2e: happy path, empty state, duplicate code, another user's code invisible, delete while in use → 409, changing decimals while in use → 409
- [ ] run the tests; they must pass before Task 11

### Task 11: Transactions in custom currencies, explicit missing-rate state

**Files:**
- Modify: `packages/backend/src/services/exchange-rates/build-daily-pair-rate-resolver.ts`, `get-exchange-rates-for-date.ts`, ref-amount calculation, `services/user-exchange-rate/get-exchange-rate.service.ts`
- Create: `packages/backend/src/services/currencies/custom-currency-transactions.e2e.ts`

- [ ] a custom-currency account and transaction use the custom decimals (BTC `0.00040641` round-trips exactly)
- [ ] a missing rate gives `refAmount` null plus a review flag, never 1.0; stats and aggregates skip or flag null ref amounts consistently
- [ ] e2e: BTC 8-decimal round trip, USDT 6-decimal round trip, a transfer USDT→USD with both amounts given, and the missing-rate behaviour
- [ ] run the backend unit and e2e tests; they must pass before Task 12

### Task 12: Frontend custom currency management and display

**Files:**
- Modify: settings currencies page (locate under `packages/frontend/src/pages/settings`), currency pickers, `formatters.ts` / `composable/formatters.ts`
- Create: the custom-currency dialog component, vitest specs, and a Playwright spec under `packages/frontend/e2e`

- [ ] add an "Add custom currency" dialog (code, name, decimals, symbol) and edit/delete actions with the in-use rules
- [ ] formatters: custom codes use decimal style plus symbol or code, never `Intl` currency style
- [ ] currency pickers list custom currencies; amount inputs follow their decimals
- [ ] add the i18n keys for `en` and `uk` through the `i18n-editor` subagent
- [ ] vitest for formatters; Playwright: create USDT, create a USDT account, add a transaction, see `12.345678 USDT`
- [ ] run frontend typecheck, lint, unit and e2e tests; they must pass before Task 13

### Phase 3: rate sources

### Task 13: Rate-source configuration model and endpoint

**Files:**
- Create: `packages/backend/src/migrations/20261016020000-currency-rate-sources.ts`
- Modify: `users-currencies.model.ts`, `user-exchange-rates.model.ts` (`source` column), shared types
- Create: `packages/backend/src/controllers/currencies/rate-source.ts`, `services/currencies/rate-sources/index.ts`, `rate-source.e2e.ts`

- [ ] add `rateSource` and `rateSourceConfig` columns and `UserExchangeRates.source`, with a zod discriminated union for the config
- [ ] `PUT /user/currencies/:code/rate-source` validates the config, saves it, and starts a backfill job for coingecko and http
- [ ] e2e: each source's valid config, an invalid config → 422, a rate source on an ISO currency → allowed only as `provider` or `manual`
- [ ] run the tests; they must pass before Task 14

### Task 14: Manual and peg resolvers

**Files:**
- Create: `packages/backend/src/services/currencies/rate-sources/manual.ts`, `peg.ts`, unit tests
- Modify: the rate resolver from Task 11, `services/user-exchange-rate/*`

- [ ] manual: dated rates through the existing user-rate endpoints, extended to custom codes; the resolver takes the latest rate on or before the date
- [ ] peg: `factor × rate(pegCurrency, date)` computed when asked; reject peg cycles
- [ ] when a source changes, recompute `refAmount` for that currency's transactions (reuse the revalue path in `revalue-accounts-in-currencies.ts`)
- [ ] unit tests for both resolvers; e2e: USDT pegged to USD gives `refAmount = amount`, and the latest manual rate applies to back-dated transactions
- [ ] run the tests; they must pass before Task 15

### Task 15: CoinGecko rate source

**Files:**
- Create: `packages/backend/src/services/currencies/rate-sources/coingecko.ts`, unit tests, e2e with mocked HTTP (follow the existing provider test mocking pattern)
- Modify: the cron registration (`crons/`), `services/investments/data-providers/coingecko-provider.ts` (reuse its client; extract if needed)

- [ ] coin search endpoint for the config UI (reuse the client's search), and a history backfill on configure respecting rate limits
- [ ] daily sync cron, deduplicated by `coinId` per day across users, storing rates in `UserExchangeRates` with `source='coingecko'`
- [ ] tests: backfill fills dates, a sync failure keeps the last rate and logs, and a transaction gets its `refAmount` once the rate exists
- [ ] run the tests; they must pass before Task 16

### Task 16: Generic HTTP/JSON rate source

**Files:**
- Create: `packages/backend/src/services/currencies/rate-sources/http.ts`, `ssrf-guard.ts`, unit tests, e2e with a local mock server
- Modify: the rate-source controller (the test endpoint)

- [ ] URL template substitution (`{date}`, `{code}`, `{base}`), JSON-path extraction, optional headers (stored encrypted the same way as AI connection keys)
- [ ] SSRF guard: https only, private and loopback ranges blocked unless `IS_SELF_HOST`, 5-second timeout, 256 KB limit, redirects re-checked
- [ ] `POST /user/currencies/:code/rate-source/test` returns a preview without saving
- [ ] unit tests for templating, path extraction and the guard (each blocked case); e2e for the preview and a daily sync
- [ ] run the tests; they must pass before Task 17

### Task 17: Frontend rate-source editor

**Files:**
- Modify: the custom-currency dialog or settings page from Task 12
- Create: rate-source form components, vitest specs, a Playwright spec

- [ ] add a source selector with a form per source: manual rates table, peg (currency plus factor), CoinGecko coin search, HTTP (template, path, headers)
- [ ] add a "Test" button showing the previewed rate and any error; show a missing-rate badge on affected transactions
- [ ] add the i18n keys for `en` and `uk` through `i18n-editor`
- [ ] Playwright: peg USDT to USD and check that the converted totals update
- [ ] run frontend typecheck, lint, unit and e2e tests; they must pass before Task 18

### Task 18: Verify acceptance criteria

- [ ] BTC `0.00040641`, ETH `0.0109348` and USDT `4.0765` round-trip exactly through the API and UI
- [ ] existing ISO data is unchanged after migration (spot-check balances before and after on a copy of the ritchie trial database)
- [ ] custom currencies are isolated per user; rate sources work and missing rates are explicit
- [ ] full backend suite: `npm test` in `packages/backend` (lint rules, unit, e2e)
- [ ] frontend: `npm run typecheck && npm run lint && npm run test:unit && npm run test:e2e` in `packages/frontend`

### Task 19: [Final] Update documentation

- [ ] update `CLAUDE.md` rule 6 (Money convention) for decimal storage and per-currency rounding
- [ ] add docs pages under `packages/docs/src/content/docs/settings/`: custom currencies and rate sources
- [ ] update `self-hosting` docs for `IS_SELF_HOST` and the HTTP rate source
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

*Items requiring manual work or external systems; no checkboxes.*

**Deployment on the ritchie trial instance:**
- Build images from this branch (`self-hosting/docker-compose.build.yml`) on ritchie and back up the trial database before migrating.
- Configure USDT/USDC (peg to USD), BTC/ETH (CoinGecko) and the other ledger currencies.

**Ledger import (separate script, outside this repo):**
- Import from the `bt` export: 1932 rows with 1:1 account-currency amounts, `originalAmount`/`originalCurrencyCode` for cross-currency rows, and transfers paired by timestamp. Lone legs become plain income or expense rows. Fees become their own rows, and the Sheets "Balance initialization" rows are imported as ordinary transactions rather than as opening balances.
- Verify the derived balances against the Sheets Balances sheet.

**Upstream:**
- Open a discussion or feature request with letehaha before any PR. Sign the CLA (`CLA.md`).
- Offer one PR per phase, in order. Phase 1 is useful on its own (JPY/KWD correctness).
