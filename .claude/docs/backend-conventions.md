# Backend Conventions

## Architecture

Strict **route → controller → service** pattern. No business logic in routes or controllers.

```
src/
├── routes/{feature}.route.ts
├── controllers/{feature}.controller.ts
└── services/{feature}/{action}.service.ts
```

## Path Aliases

Defined in `packages/backend/tsconfig.json`:

- `@routes/*` → `src/routes/*`
- `@controllers/*` → `src/controllers/*`
- `@services/*` → `src/services/*`
- `@models/*` → `src/models/*`
- `@middlewares/*` → `src/middlewares/*`
- `@common/*` → `src/common/*`
- `@js/*` → `src/js/*`
- `@crons/*` → `src/crons/*`
- `@tests/*` → `src/tests/*`
- `@root/*` → `src/*`
- `@bt/shared/*` → `../../shared/src/*`

## Route Layer

```typescript
import { Router } from 'express';
import { authenticateSession } from '@middlewares/better-auth';
import featureController from '@controllers/feature.controller';

const router = Router();

router.get('/', authenticateSession, featureController);

export default router;
```

## Controller Layer

Always use `createController` factory. Keep controllers thin — delegate to services.

```typescript
import { createController } from '@controllers/helpers/controller-factory';
import * as featureService from '@services/feature.service';
import { z } from 'zod';

const schema = z.object({
  params: z.object({ id: recordId() }).optional(), // custom Zod types from @common/lib/zod/custom-types
  query: z.object({}).optional(),
  body: z.object({}).optional(),
});

export default createController(schema, async ({ user, params, query, body }) => {
  const data = await featureService.doSomething({ userId: user.id, ...params });
  return { data }; // return { data, statusCode? }
});
```

## Service Layer

- Always use **object-based parameters** with interfaces
- Use `withTransaction` for **writes only** — services that modify data (create / update / delete / link / unlink, or any multi-statement mutation). Plain reads (`get*`, `list*`, `find*`) are single-statement queries and do **not** need a transaction; wrapping them adds overhead and confuses the read-vs-write contract at a glance.
- Use functions, never classes
- Error types from `@js/errors`: `NotFoundError`, `ValidationError`, `ConflictError`, `NotAllowedError`, `Unauthorized`
- For `findOne(...) → throw NotFoundError` use the `findOrThrowNotFound` helper from `@common/utils/find-or-throw-not-found` instead of hand-rolling the null check. It keeps the call site short and the throw consistent.
- Throw with an i18n key, not a literal English string: `t({ key: 'feature.thingNotFound' })`. Errors surface in user-facing UI eventually and the i18n loader handles missing-key fallback.

```typescript
// Read — no transaction wrapper
import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import { t } from '@i18n/index';
import * as FeatureModel from '@models/feature.model';

export const getFeatureById = ({ userId, id }: { userId: number; id: string }) =>
  findOrThrowNotFound({
    query: FeatureModel.findOne({ where: { id, userId } }),
    message: t({ key: 'feature.featureNotFound' }),
  });
```

```typescript
// Write — withTransaction wraps the mutation
import { withTransaction } from '@services/common/with-transaction';

const createFeatureImpl = async ({ userId, name }: { userId: number; name: string }) => {
  // …multi-step mutation that must be atomic…
};

export const createFeature = withTransaction(createFeatureImpl);
```

## API Response Format

```typescript
// Success
{ status: API_RESPONSE_STATUS.success, response: unknown }

// Error
{ status: API_RESPONSE_STATUS.error, error: { message: string, code?: string, details?: unknown } }
```

## Common Middleware

- `authenticateSession` — authentication (better-auth sessions)
- Request validation is built into `createController` (422 on a Zod failure). `validateEndpoint(schema)` exists only to reject a bad request ahead of earlier middleware such as rate limiters (see `landing.route.ts`)

## Shared Types

- API envelope, error codes, their `details` payloads and generic request primitives: `packages/shared/src/types/api.ts`
- A new enum, model, request/response type or limit goes in `packages/shared/src/types/<domain>.ts`, where the domain is the backend routes/services feature that owns it — all kinds together
- No file is organised by kind (no `enums.ts`, `models.ts`, `endpoints.ts`)
- Import flat: `import { ... } from '@bt/shared/types'`
- A domain becomes a folder only when it has separable sub-features (e.g. `transactions/`, `stats/`)
- `investments/` and `venture/` predate this rule (kind-named files, deep imports) — not a pattern to copy
- Non-domain constants live in `packages/shared/src/const/`

## E2E Tests

**Location**: E2E tests live **in the service layer**, colocated with the service file they test:

```
src/services/{feature}/action.e2e.ts
```

Examples:

- `src/services/accounts/delete-account.e2e.ts`
- `src/services/transactions/get-transactions.e2e.ts`
- `src/services/trackers/tracker-crud.e2e.ts`

**Never** place e2e tests in the controllers layer. Even when testing a full HTTP endpoint, the test file belongs next to the corresponding service.

## E2E Test Helpers

Test helpers live in `packages/backend/src/tests/helpers/`. Always type the return value:

```typescript
import { createInvestmentTransaction as _createInvestmentTransaction } from '@services/investments/transactions/create.service';

export async function createInvestmentTransaction<R extends boolean | undefined = false>({
  payload,
  raw,
}: {
  payload: ReturnType<typeof buildInvestmentTransactionPayload>;
  raw?: R;
}) {
  return makeRequest<Awaited<ReturnType<typeof _createInvestmentTransaction>>, R>({
    method: 'post',
    url: '/investments/transaction',
    payload,
    raw,
  });
}
```

## Database

- Use Sequelize for all DB operations
- Always use transactions for multi-step operations (`withTransaction`)
- Define proper indexes

## Payment ingest and the Automation inbox

The ingest pipeline (`services/ingest/`, user guide `packages/docs/.../integrations/ios-automation.mdx`, API `packages/backend/docs/card-payment-ingest.md`) has rules that are easy to break:

- **Every pipeline logs through `logIngestedPayment`.** A tap, a Wallet notification and a bank notification share it, so slots, the unconfirmed flag and `INGEST_PAYMENT_LOGGED` stay in one place. `IngestRequests.pipeline` (server-set) is the discriminator; `source` is the client's label and is never branched on.
- **Dedup is two tiers.** Deterministic rules (exact twin, settlement) run under the `ingest-dedup:<userId>` advisory lock and attach automatically. Anything AI-judged only writes a `DuplicateSuggestions` row. No AI path merges, attaches or moves a payment by itself.
- **Notification text is encrypted at rest.** It lives only in `IngestRequests.textEnc` (`encryptToken`), never in plain JSON, and is wiped or expired on the schedule in the API doc.
- **Inbox items are system proposals.** The Automation inbox is a `ChatThreads.kind = automationInbox` thread that never runs AI (`startChatRun` refuses it). Post items with `createSystemProposal` (run-free `storeProposal`), never `createProposal`, and close them through `inbox-resolution` (`resolvedElsewhere`) when the record settles elsewhere. A new record kind needs a `proposalId` column, an `onInboxCardRejected` branch and a `nullOnRestore` backup entry.
- **BullMQ job ids join their parts with `-`**, never `:` (`${requestId}-${attempt}`).
- **Each new job-backed or mutating route is classified** in `base-currency-guard-coverage.e2e.ts`; a job checks `isBaseCurrencyChangeLocked` itself and re-delays without using an attempt.

## Times and zones

- `Transactions.time` is an instant. `timeZone` and `utcOffsetMinutes` (both nullable, `null` means unknown) say where it happened.
- A row's zone is decided by `resolveRecordedZone` (`@bt/shared/time-zone`) for sources that state an offset or bring a request zone, and stored through `deriveStoredZone` / `deriveZoneUpdate` (`services/transactions/recorded-zone.ts`), which `createTransaction`, `updateTransaction`, the planned merge and the portfolio transfers share. The bulk zone edit derives offsets in SQL. A stated offset beyond ±14:00 counts as not stated.
- The candidate zone for recording is a zone somebody chose: `getStoredUserTimeZone` (a user with no setting records `null`), or the request's own zone where a request carries one (imports use `timezone`, ingest passes `timeZone` as the explicit zone). `getUserTimeZone` (`UTC` fallback) is for reading wall clocks and cutting days, never for recording.
- Day bounds, report buckets and budget periods use the user's zone (`zonedDayStart` / `zonedDayEnd`, `tzOptions`, `AT TIME ZONE :zone`). A row's own zone never decides which day it belongs to. `Balances` and net-worth history stay on UTC days.
- MCP and chat tools take a ledger time through `resolveTimeInput` and filter or tracker date ranges through `resolveRangeBound` (`normalizeRangeBounds`); they never require UTC from the model. Market data (security prices, investment trades) keeps UTC input. `get_spending_by_categories`, `get_expenses_for_period` and `get_balance_history` take `yyyy-MM-dd` days (cut in the user's zone by the report); any other string they receive is an ISO time read in UTC (an end bound runs to the end of its UTC day).
- Update tools never re-zone a row: without `timeZone` the stored zone stays and the offset is recomputed at the new time; `timeZone: null` clears both columns.
