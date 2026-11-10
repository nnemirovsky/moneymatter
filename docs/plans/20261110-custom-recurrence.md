# Custom recurrence intervals for subscriptions

## Overview

- A subscription or bill can repeat only on six presets today: weekly, biweekly, monthly, quarterly, semi-annual, annual. Some bills follow a fixed day count instead: a Magti mobile plan renews every 30 days, so a "monthly" schedule drifts about a day a month and its periods stop lining up with the payments.
- Add a seventh frequency, `custom`, with a number and a unit: every N days, weeks, months or years. The six presets stay as they are; existing rows are untouched.
- Recurring-payment detection learns to spot a fixed day cadence and proposes "every N days" instead of forcing it into "monthly".
- Two upstream PRs to letehaha/moneymatter, based on upstream `dev`:
  - **PR A** (`feat/custom-recurrence`): the custom frequency end to end (tasks 1–7, 9–10).
  - **PR B** (`feat/custom-recurrence-detection`, stacked on A): detection of day cadences (task 8). Kept separate so A stays reviewable.

## Context (from discovery, checked against upstream `dev` f1207ed13)

- Frequency enum: `SUBSCRIPTION_FREQUENCIES` in `packages/shared/src/types/subscriptions.ts`. DB: `Subscriptions.frequency` and `SubscriptionCandidates.detectedFrequency` are Postgres ENUMs today (`enum_Subscriptions_frequency`, `enum_SubscriptionCandidates_detectedFrequency`).
- Repo convention is no Postgres enums; precedent on this very table: `20260624000003-add-installment-type-to-subscriptions.ts` turned `type` from ENUM into VARCHAR(50) to add a value. Constraints are named `chk_subscriptions_*`.
- Schedule maths and their consumers:
  - `services/subscriptions/calculate-next-due-date.ts`: next period's due date, month-end clamped to `anchorDay`; used by `ensure-next-period.ts` (creates the next period from the latest one when the open period is consumed).
  - `services/subscriptions/subscription-date.utils.ts` (`addFrequency`): next expected date without a `dueDate`.
  - `services/subscriptions/period-match-window.ts` (`FREQUENCY_INTERVAL_DAYS` 7/14/30/90/180/365): tolerance for settling the one open period; used by `settle-period-on-match.ts`.
  - `services/subscriptions/get-upcoming-payments.ts` (`paymentDatesInRange`, response carries `frequency`), also used by `services/budget-plans/get-scheduled.ts:125`.
  - `services/subscriptions/get-subscriptions-summary.ts` (`MONTHLY_MULTIPLIERS`, explicit `attributes` list at :77).
  - `get-pay-preview.ts`, `get-subscriptions.ts`, `create-subscription.ts`, `update-subscription.ts`.
  - Frontend: `components/widgets/upcoming-payments-strip.ts`, `pages/planned/subscriptions/linked-payments-summary.ts` (30.44/91.3/182.6/365.25 averages) via `linked-transactions-section.vue`.
- Inputs and validation: `controllers/subscriptions/shared-schemas.ts` (create + update, with payload-level `superRefine`s), merged-state asserts in `services/subscriptions/helpers.ts` (`assertInstallmentScheduleComplete`, `assertAmountCurrencyConsistent`, `assertAutoRecordConsistent`) called from `update-subscription.ts:81-114`; newer messages use backend i18n keys (`backend/src/i18n/locales/*.json`, `subscriptions.validation.*`).
- Update today does nothing to the open period on a frequency change; only a changed `dueDate` moves it (`update-subscription.ts:194-220`).
- Candidate accept does not create a subscription: `resolve-candidate.ts` marks it accepted and links samples to an existing `subscriptionId`; the frontend prefills quick-add from the candidate (`discover-candidates-dialog.vue:98-107`) and accepts with the new id. MCP works the same way.
- MCP: `create_subscription` / `update_subscription` (`defineTool`, inputs from the REST shape, REST schema parsed in `run`); read tools `get_subscriptions` (`mcp/tools/get-subscriptions.ts:25-38`) and `slimSubscriptionDetailForMcp` (`mcp/serializers.ts:141-178`) pick fields one by one. Metadata via `npm run mcp:generate-metadata`.
- Data export: `data-export/transformers/subscriptions-transformer.ts:53`, `data-export/types.ts:180`. Backup/restore reads attributes dynamically: no change.
- Frontend: quick-add chips come from `Object.values(SUBSCRIPTION_FREQUENCIES)` (`quick-add-subscription-dialog.vue:96`), `quick-add-payload.ts`, `edit-schedule-dialog.vue`, `utils.ts` labels, list item, details page, `candidate-card.vue`, `discover-candidates-dialog.vue`. Playwright suite in `packages/frontend/e2e` (`tests/planned/recurring-payments.spec.ts:159` "schedule editor sets a due date and frequency"; `e2e/helpers/api-client.ts:623` hard-codes a `SubscriptionFrequency` union).
- `packages/shared` has no test runner; shared logic lives in domain folders (`shared/src/goals/goal-math.ts`) and is tested from the backend through the `@bt/shared/(.*)` jest mapping.
- Out of scope: tag reminders and budget-line goals (own frequency types). The fork-only `dueDate within_days` matching rule (`due-date-window.ts`, fork commit `e88137984`) is not on upstream `dev`; see Post-Completion.

## Development Approach

- **testing approach**: TDD. Failing unit tests and e2e cases first, then the code.
- complete each task fully before moving on; small, focused commits.
- **CRITICAL: every task MUST include new/updated tests**, success and error cases.
- **CRITICAL: all tests must pass before starting the next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- Tests through the `test-runner` subagent on Node 24.21.0 (`mise exec node@24.21.0 --`), e2e serialized with `lockf -t 7200 /tmp/mm-e2e.lock`; lint/types through `linter`; frontend i18n through `i18n-editor` (en + uk together).
- Backward compatibility: preset rows and preset API calls behave exactly as before. Each preset's existing numbers (tolerance, summary multiplier, linked-payment averages) stay in their tables; only a custom branch is added.

## Testing Strategy

- **unit tests** (backend jest, also for the shared helper): step resolution and normalization; each schedule function per unit with month-end clamping; detection rule on synthetic date series; MCP tool and serializer tests.
- **backend e2e** (HTTP helpers only): create/update/read with custom intervals, validation errors, periods advancing by the step, settling within tolerance, upcoming payments, summary, budget-plan scheduled items, data export, detection.
- **frontend**: vitest specs for payload, labels, strip, linked-payments summary, candidate prefill; one Playwright case for the custom schedule editor.

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix

## Solution Overview

- **One recurrence step.** A shared pure helper turns a subscription's schedule into `{ unit: 'day' | 'week' | 'month' | 'year', count }`. Presets map to fixed steps (weekly → week×1, biweekly → week×2, monthly → month×1, quarterly → month×3, semi_annual → month×6, annual → year×1); `custom` reads `intervalUnit` / `intervalCount`. Date-stepping functions (next due date, next expected date, upcoming dates) switch on the step's unit, which gives presets identical dates.
- **Number tables stay.** Tolerance, the summary multiplier and the linked-payment averages keep their per-preset tables untouched and gain one custom branch computed from the step (day: N, week: 7N, month: 30N / 30.44N, year: 365N / 365.25N, matching what each table uses for its month-based presets).
- **Storage.** `frequency` (and `detectedFrequency`) become VARCHAR(50) with the enum types dropped, following `20260624000003`; two nullable columns hold the step; one named CHECK ties them together.
- **Normalization.** A custom step equal to a preset is stored as the preset: week×1 and day×7 → weekly, week×2 and day×14 → biweekly, month×1/3/6 → the month presets, month×12 and year×1 → annual. Anything else stays as typed (day×28 stays "every 28 days").
- **Open period on a step change.** As with preset changes today, changing the step keeps the open period; the next period after it follows the new step.
- **Detection (PR B).** Intervals in UTC day numbers. A day cadence is: at least 3 intervals, all exactly N days, N ≥ 7, and N not a preset equivalent after normalization. A calendar-monthly bill cannot produce three equal intervals in a row (no two 30-day months are adjacent and three 31-day months never follow each other), so the exact rule has no calendar false positives. One missed payment (a doubled interval) or a day of jitter falls back to the preset mapping, as today.

## Technical Details

- **Shared** (`packages/shared/src/types/subscriptions.ts`):
  - `SUBSCRIPTION_FREQUENCIES.custom = 'custom'`
  - `enum SUBSCRIPTION_INTERVAL_UNITS { day = 'day', week = 'week', month = 'month', year = 'year' }`
  - `SUBSCRIPTION_INTERVAL_LIMITS`: min 1, max per unit day 366, week 104, month 120, year 10.
  - response types gain `intervalUnit: SUBSCRIPTION_INTERVAL_UNITS | null`, `intervalCount: number | null`; candidates `detectedIntervalUnit`, `detectedIntervalCount` (PR B); upcoming payments gain the step.
- **Shared helper** `packages/shared/src/subscriptions/recurrence.ts`:
  - `resolveRecurrenceStep({ frequency, intervalUnit, intervalCount })`; throws for `custom` without a step.
  - `normalizeRecurrence({ frequency, intervalUnit, intervalCount })`: the stored triple (preset-equal steps folded, step cleared for presets).
  - `addRecurrenceStep({ date, step, anchorDay? })`: day/week add days; month/year add months, clamped to `anchorDay` when given.
  - spec: `packages/backend/src/services/subscriptions/recurrence.unit.ts`.
- **Migration** `20261110000000-subscription-custom-interval.ts`, one transaction:
  - `ALTER COLUMN "frequency" TYPE VARCHAR(50) USING "frequency"::text`, `DROP TYPE "enum_Subscriptions_frequency"`; same for `SubscriptionCandidates."detectedFrequency"` and its type. Add CHECKs listing the allowed frequency values (as `20260624000003` does for `type`).
  - add `intervalUnit VARCHAR(10) NULL`, `intervalCount INTEGER NULL` to `Subscriptions` (and the `detected…` pair to `SubscriptionCandidates` in PR B's migration, or here so PR B needs none: decided here, both pairs in this migration).
  - `chk_subscriptions_custom_interval`: `("frequency" = 'custom' AND "intervalUnit" IN ('day','week','month','year') AND "intervalCount" BETWEEN 1 AND 366) OR ("frequency" <> 'custom' AND "intervalUnit" IS NULL AND "intervalCount" IS NULL)`; the same shape for candidates.
  - down: drop constraints and columns, restore the ENUM types; it fails while `custom` rows exist, with a comment saying so (precedent `20260624000003`, `20261109000000`). No live shared code in the migration.
  - models: `frequency` / `detectedFrequency` as `DataType.STRING(50)`, the new columns declared.
- **Validation**:
  - schemas: `frequency` accepts `custom`; payload-level `superRefine` on create and update: a step with a preset is refused, count within the unit's limit, create with `custom` needs both fields.
  - `assertRecurrenceConsistent` in `services/subscriptions/helpers.ts`, called on the merged state in update (and on create): `custom` needs a step; the service writes `intervalUnit: null, intervalCount: null` itself when the merged frequency is a preset, and normalizes preset-equal steps before saving.
  - messages as backend i18n keys `subscriptions.validation.customInterval*` in `backend/src/i18n/locales` en + uk.
- **Schedule consumers** pass the step: `calculate-next-due-date` (`ensure-next-period`), `subscription-date.utils`, `period-match-window` (`settle-period-on-match`), `get-upcoming-payments` (+ `budget-plans/get-scheduled`), `get-pay-preview`, `get-subscriptions`, `get-subscriptions-summary` (add the two columns to its `attributes`).
- **MCP**: `create_subscription` / `update_subscription` gain `intervalUnit` / `intervalCount` from the REST shape, descriptions mention `custom`; `get_subscriptions` and `slimSubscriptionDetailForMcp` return the step. If #803 (tool `validate`) is merged first, the custom rule sits in the tools' `validate`.
- **Data export**: the step columns in the subscriptions transformer and types.
- **Frontend**: a "Custom" chip/option in the quick-add and edit-schedule dialogs revealing `input-field` (count, per-unit max) + `select-field` (unit) with placeholders, container-query layout; labels "Every 30 days" / "Every 2 months" via en + uk plural keys; the strip and linked-payments summary use the shared helper; candidate prefill passes the step (PR B).

## What Goes Where

- **Implementation Steps**: code, migration, tests, i18n, MCP metadata, docs in this repo.
- **Post-Completion**: PRs, deploy, switching Magti, reconciling with the fork-only `within_days` rule.

## Implementation Steps

### Task 1: Shared recurrence types and helper (PR A)

**Files:**

- Modify: `packages/shared/src/types/subscriptions.ts`
- Create: `packages/shared/src/subscriptions/recurrence.ts`
- Create: `packages/backend/src/services/subscriptions/recurrence.unit.ts`

- [x] failing tests: `resolveRecurrenceStep` for the six presets and custom; throws for custom without a step
- [x] failing tests: `normalizeRecurrence` folds week×1, day×7, week×2, day×14, month×1/3/6/12, year×1; keeps day×28, day×30, month×2; clears the step for presets
- [x] failing tests: `addRecurrenceStep` day/week/month/year, month×2 from Jan 31 (Mar 31, May 31; clamps on Apr 30 and returns), year×2 from Feb 29
- [x] implement the types, limits and helper
- [x] run tests – must pass before task 2

### Task 2: Migration and models (PR A)

**Files:**

- Create: `packages/backend/src/migrations/20261110000000-subscription-custom-interval.ts`
- Modify: `packages/backend/src/models/subscriptions.model.ts`
- Modify: `packages/backend/src/models/subscription-candidates.model.ts`

- [x] write the migration (ENUM → VARCHAR for both columns, drop the types, value CHECKs, the step columns for both tables, `chk_subscriptions_custom_interval` and the candidates' twin, down path that fails while custom rows exist)
- [x] update both models
- [ ] run the existing subscription and candidate e2e suites (the setup migrates from scratch) – must stay green; the CHECK is defence in depth behind the schema and service, so it is not tested through an endpoint
- [ ] run tests – must pass before task 3
- ⚠️ backend e2e blocked: the worktree has no root `.env.test` (copying it was denied by the permission system); waiting on the lead

### Task 3: Schedule consumers on the recurrence step (PR A)

**Files:**

- Modify: `packages/backend/src/services/subscriptions/calculate-next-due-date.ts` (+ `.unit.ts`)
- Modify: `packages/backend/src/services/subscriptions/subscription-date.utils.ts` (+ `compute-next-expected-date.unit.ts`)
- Modify: `packages/backend/src/services/subscriptions/period-match-window.ts` (+ `.unit.ts`)
- Modify: `packages/backend/src/services/subscriptions/get-subscriptions-summary.ts`
- Modify: `packages/backend/src/services/subscriptions/get-upcoming-payments.ts`, `get-pay-preview.ts`, `get-subscriptions.ts`, `ensure-next-period.ts`, `settle-period-on-match.ts`
- Modify: `packages/backend/src/services/budget-plans/get-scheduled.ts`

- [x] failing unit tests: next due date and next expected date for day×30, week×3, month×2 (clamping), year×2; tolerance for custom (day×30 → 15) and unchanged preset values
- [x] switch the date functions to `addRecurrenceStep`; add the custom branch to the tolerance table and the summary multipliers, preset entries untouched
- [x] pass the step through every consumer; add `intervalUnit` / `intervalCount` to the summary `attributes`; add the step to the upcoming-payments response
- [ ] run unit tests and the subscription + budget-plan e2e suites – must pass before task 4 (unit green; e2e ⚠️ blocked, see task 2)
- ➕ pay preview's period window (`get-pay-preview.ts`) also steps by the recurrence; covered by an e2e case in `subscription-custom-interval.e2e.ts`

### Task 4: Create and update accept custom intervals (PR A)

**Files:**

- Modify: `packages/backend/src/controllers/subscriptions/shared-schemas.ts`
- Modify: `packages/backend/src/services/subscriptions/helpers.ts`, `create-subscription.ts`, `update-subscription.ts`
- Modify: `packages/backend/src/i18n/locales/en.json`, `uk.json` (backend messages)
- Modify: `packages/backend/src/tests/helpers/subscriptions.ts`
- Create: `packages/backend/src/services/subscriptions/subscription-custom-interval.e2e.ts`
- Modify: `packages/backend/src/services/budget-plans/get-scheduled.e2e.ts`

- [x] failing e2e: create every 30 days with a dueDate D → read returns `custom`/`day`/`30`; pay the open period → the next period is due D+30, then D+60
- [x] failing e2e errors: custom without a step, a step with a preset, count 0, count above the unit limit, unknown unit; update to custom without a step
- [x] failing e2e: custom every 1 month is stored as monthly; update monthly → every 30 days keeps the open period, and after paying it the next one is due +30 days; update custom → monthly clears the step; updating only the count works
- [x] failing e2e: a payment within 15 days of a 30-day due date settles it; 16 days away it does not
- [x] failing e2e: upcoming payments list the custom dates; the summary counts a custom subscription with its monthly equivalent; budget-plan scheduled items include the custom dates
- [x] implement the schema rules, `assertRecurrenceConsistent`, normalization and the null-write for presets; backend i18n keys en + uk
- [ ] run the new and touched e2e files plus the subscription suites – must pass before task 5 (⚠️ blocked, see task 2)
- ➕ update merges the step with the stored one only while the subscription stays `custom`; a step on a stored preset without switching to `custom`, a merged count above the stored unit's limit, and clearing the unit of a custom subscription are refused (e2e cases added)

### Task 5: MCP tools, read serializers and data export (PR A)

**Files:**

- Modify: `packages/backend/src/services/mcp/tools/create-subscription.ts`, `update-subscription.ts`, `get-subscriptions.ts` and their unit tests
- Modify: `packages/backend/src/services/mcp/serializers.ts` (+ `serializers.unit.ts`)
- Modify: `packages/backend/src/services/data-export/transformers/subscriptions-transformer.ts`, `data-export/types.ts`, `export-data.e2e.ts`
- Modify: generated `server-card.json`, connect-moneymatter `SKILL.md`, `agent-skills/index.json`

- [x] failing tests: write tools accept and pass the step, refuse custom without one with the REST message; `get_subscriptions` and the slim detail return the step
- [x] failing e2e: export contains the step columns for a custom subscription
- [x] implement; `npm run mcp:generate-metadata`
- [ ] run `npm run test:unit -- --testPathPattern='services/mcp/'` and the export e2e – must pass before task 6 (MCP unit gate green, 1088 tests; export e2e ⚠️ blocked, see task 2)
- ➕ the generated metadata did not change: only the tools' later sentences and parameter descriptions changed, and the server card and SKILL.md tables carry first sentences only. `npm run mcp:generate-metadata` needs a dev env this worktree lacks, so the files were regenerated through `buildMcpMetadataFiles` under the unit-test environment, and the drift tests pass

### Task 6: Frontend schedule editing and labels (PR A)

**Files:**

- Modify: `packages/frontend/src/api/subscriptions.ts`
- Modify: `packages/frontend/src/pages/planned/subscriptions/utils.ts` (+ spec), `quick-add-payload.ts` (+ spec), `linked-payments-summary.ts` (+ spec), `subscription-fixtures.ts`
- Modify: `components/quick-add-subscription-dialog.vue`, `components/edit-schedule-dialog.vue`, `components/linked-transactions-section.vue`, `components/subscription-list-item.vue`, `subscription-details.vue`
- Modify: `packages/frontend/src/components/widgets/upcoming-payments-strip.ts` (+ spec)
- Modify: `packages/frontend/e2e/helpers/api-client.ts`, `packages/frontend/e2e/tests/planned/recurring-payments.spec.ts`

- [x] failing specs: payload sends the step only for custom; labels "Every 30 days", "Every 2 months"; strip projects day×30 dates; linked-payments summary counts periods of a custom step
- [x] "Custom" chip/option with count + unit fields in both dialogs (container queries, per-unit max, inline validation); `custom` handled in the chip list instead of appearing as a bare chip
- [x] shared helper in the strip and linked-payments summary; custom label in list item, details page
- [x] i18n keys through `i18n-editor` (en + uk plural forms)
- [x] Playwright: the schedule editor sets a custom 30-day interval; update the `SubscriptionFrequency` union
- [ ] run frontend specs, Playwright case, lint and types – must pass before task 7 (vitest, vue-tsc, oxlint, i18n key check green; Playwright not run yet, it needs the running dev stack)
- ➕ the strip steps local calendar dates with date-fns by the shared `resolveRecurrenceStep`; the shared `addRecurrenceStep` works in UTC and would shift local-midnight dates west of UTC
- ➕ shared `custom-interval-fields.vue` (count + unit, `@container` layout) used by both dialogs; `isIntervalCountValid` in `utils.ts` for the inline validation

### Task 7: User docs (PR A)

**Files:**

- Modify: the closest existing docs page under `packages/docs/src/content/docs/` (no subscriptions page exists; follow the `user-docs` skill)

- [x] short section on presets vs a custom interval with the 30-day example; a dedicated subscriptions page with screenshots is a follow-up, not this PR
- ➕ no page covers recurring payments yet, so the custom interval is a sentence on the Recurring Payments entry of `getting-started/what-is-moneymatter.mdx`

### Task 8: Detection proposes fixed day cadences (PR B, stacked on A)

**Files:**

- Modify: `packages/backend/src/services/subscriptions/detect-candidates-utils.ts` (+ `.unit.ts`)
- Modify: `packages/backend/src/services/subscriptions/detect-candidates.ts`, `serialize-candidate.ts`
- Modify: `packages/backend/src/services/subscriptions/detect-candidates.e2e.ts`
- Modify: `packages/frontend/src/api/subscription-candidates.ts`, `components/discover-candidates-dialog.vue` (prefill), `components/candidate-card.vue`, quick-add form state

- [ ] rewrite the existing "monthly" fixtures in `detect-candidates.e2e.ts` to calendar-month dates (`addMonths`) first, keep them green on the current code
- [ ] failing unit tests for `detectFixedDayCadence({ dates })` (UTC day intervals): payments every 30 days ×4 → day×30; every 28 days → day×28; calendar-monthly on the 10th and on the 31st → null; every 14 days → null (preset); every 3 days → null (N < 7); one missed payment → null; one interval off by a day → null; fewer than 3 intervals → null
- [ ] implement; use it before `mapIntervalToFrequency`; store and serialize the detected step
- [ ] failing e2e: transactions every 30 days → candidate `custom`/day/30; create a subscription with that step and accept the candidate with its id; calendar-monthly transactions still give `monthly`
- [ ] frontend: discover dialog prefills quick-add with the step; candidate card shows the label; spec for the prefill
- [ ] run tests – must pass before task 9

### Task 9: Verify acceptance criteria

- [ ] a subscription can repeat every N days/weeks/months/years; presets unchanged
- [ ] detection proposes day cadences and still proposes presets for calendar schedules (PR B)
- [ ] backend unit: `npm run test:unit`
- [ ] backend e2e: `npm run test:e2e -- --testPathPattern='(subscriptions/|budget-plans/get-scheduled|data-export/export-data|services/mcp/(connected-apps|mcp-scope-gate))'`
- [ ] frontend specs, Playwright planned suite, lint and types

### Task 10: [Final] Update documentation

- [ ] `.claude/docs` or skills only if a new pattern emerged (the recurrence step as the one place for date stepping)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

_Items requiring manual intervention or external systems_

**Upstream PRs**

- Push `feat/custom-recurrence` and `feat/custom-recurrence-detection` to the fork, open PR A and PR B (B based on A) against `letehaha/moneymatter:dev`; PR text approved by the user first. If letehaha declines, both stay in the fork.

**Fork reconciliation**

- The fork's `dueDate within_days` rule (`due-date-window.ts`, `daysFromSchedule`) is not upstream and has no PR. When merging this into the fork, give `daysFromSchedule` the step; that rule also needs its own upstream PR.

**User's instance**

- Deploy, then switch the Magti bill to custom every 30 days anchored on its last payment.

**Manual verification**

- Custom schedule inputs at a narrow container width (sidebar open).
- Detection on the user's own data: Magti comes back as every 30 days.
