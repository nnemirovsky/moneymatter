# Card-payment ingest API

Two endpoints log payments from a machine client. The iOS shortcuts are the first clients; a script, a bank webhook relay or any other automation can use the same endpoints.

- `POST /api/v1/ingest/card-payment` logs one card payment: the iOS 26 shortcut's Wallet tap. It is described first.
- `POST /api/v1/ingest/event` is the iOS 27 shortcut's single endpoint. Its `kind` picks the pipeline: `walletTransaction` runs the card-payment pipeline unchanged, and `notification` forwards a bank or Wallet notification. See [Event endpoint](#event-endpoint).

The card-payment endpoint maps the card to an account, finds or creates the payee, picks a category, converts the currency when it differs from the account's, stores the transaction and answers with one line the client can show as a notification.

## Authentication

Send a personal ingest token as a Bearer token:

```
Authorization: Bearer mm_ingest_…
```

Create a token in the app under Accounts → iOS Automation → Devices. The secret is shown once. A token carries the scope `ingest:transactions` and nothing else: it cannot read data, and it cannot call any other route. Tokens are stored hashed, can expire, and are revoked by a password reset.

If the instance sits behind a gateway that asks for its own credentials (Cloudflare Access, for example), the client sends those headers on the same request (`CF-Access-Client-Id` and `CF-Access-Client-Secret`). They are not MoneyMatter's concern and are not read by it.

| Status | Meaning                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| 401    | The token is missing, malformed, unknown, revoked or expired.                                              |
| 403    | The token lacks the `ingest:transactions` scope. (A 403 that is not JSON comes from the gateway in front.) |
| 402    | The user's plan is read-only. Write requests are refused.                                                  |
| 429    | Rate limit: 30 requests per minute per token, and 20 failed authentications per 15 minutes per IP.         |

## Request

`Content-Type: application/json`. Unknown keys are ignored, so a newer client keeps working against an older server.

| Field            | Type             | Required | Notes                                                                                                                                                      |
| ---------------- | ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotencyKey` | string           | yes      | 8 to 128 printable ASCII characters, no spaces. See [Idempotency](#idempotency).                                                                           |
| `amount`         | string or number | yes      | A positive expense amount. Text may carry a currency code or symbol and locale separators: `47.00`, `47,00 GEL`, `₾47`, `1.234,56 €`.                      |
| `merchant`       | string           | yes      | Up to 200 characters. A blank merchant is refused.                                                                                                         |
| `card`           | string           | yes      | The card's name as the client knows it, up to 100 characters. Case and a trailing masked number (`•••• 1234`) are ignored.                                 |
| `currency`       | string           | no       | A 3-letter code. Wins over the amount text. See [Currency](#currency).                                                                                     |
| `time`           | string           | no       | ISO 8601 date and time **with an offset**: `2026-10-17T14:05:00+04:00`. Defaults to the time the request was received.                                     |
| `timeSource`     | string           | no       | `run` (default) or `transaction`: whether `time` is the time the client ran or a time the transaction itself carries. See [Repeat window](#repeat-window). |
| `name`           | string           | no       | The payment's own name, up to 200 characters. Kept with the transaction's data.                                                                            |
| `source`         | string           | no       | Which client sent it, 1 to 32 characters of `a-z`, `0-9` and `-`. Defaults to `card-payment`.                                                              |
| `dryRun`         | boolean          | no       | `true` only checks the connection and a card link. Nothing is validated beyond `card` or written.                                                          |

Text fields lose control and invisible characters, and their whitespace is collapsed. A `time` more than 5 minutes in the future or more than 30 days in the past is refused.

### Dry run

```json
{ "dryRun": true, "card": "TBC Visa" }
```

Answers `200` with `outcome: "dryRun"` and a summary that says who the token belongs to and, when `card` was sent, which account the card is linked to. Without `card` it says how many cards are linked.

## Responses

Every response uses the API envelope. Success: `{ "status": "success", "response": { … } }`. Failure: `{ "status": "error", "response": { "message", "code", "details"? } }`.

### Logged (200)

```json
{
  "status": "success",
  "response": {
    "outcome": "logged",
    "summary": "Logged 47.00 GEL at Cafe Heart of Batumi → Bar, cafe",
    "transactionId": "0d9f6c1e-5b7a-4c1e-9a52-3f1d2b8e7a10",
    "planned": false,
    "categoryPending": false
  }
}
```

- `summary` is the notification line, in the user's language, with the currency's own decimals. When the payment currency differs from the account's it shows both: `Logged 20.00 EUR (57.40 GEL) at …`.
- `planned: true` means the account is bank-connected and the row waits for the bank's own transaction (the summary says "Noted … the bank sync will confirm it"). See [Settlement](#settlement-on-bank-connected-accounts).
- `categoryPending: true` means the AI categorization is still running. The request waits up to 8 seconds for it; after that the summary says "categorizing…" and the category is filled in later.
- `duplicate: true` appears on a replay of the same request or a repeat inside the repeat window, with the summary "Already logged …".
- `transactionId` is `null` when the transaction has since been deleted.

### Parked (202)

```json
{
  "status": "success",
  "response": {
    "outcome": "parked",
    "reason": "unknownCard",
    "summary": "Not logged yet: link the card \"TBC Visa\" in MoneyMatter → Accounts → Apple Pay",
    "requestId": "7b3e2a94-1c6d-4f08-8e35-a2d94c51b6f3"
  }
}
```

The payment was stored but not logged, and waits for the user. Nothing is lost.

| `reason`           | Cause                                                     | How it resolves                                                                   |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `unknownCard`      | No card link matches the `card` name.                     | The user links the card on the iOS Automation page and logs the waiting payments. |
| `rateUnavailable`  | The payment's currency has no exchange rate for its date. | Retry from the iOS Automation page later, or resend the same `idempotencyKey`.    |
| `processingFailed` | An unexpected error while processing.                     | Retry from the iOS Automation page, or resend the same `idempotencyKey`.          |

A parked request is re-evaluated when the same `idempotencyKey` arrives again, so a client that retries on any non-200 answer is safe.

### Refused (422)

The payload is unusable. The request is recorded as `rejected` so the owner can see what the client sent, and a replay of the same key gets the same answer. `details.reason` is one of:

`invalidBody`, `invalidIdempotencyKey`, `invalidSource`, `invalidAmount`, `zeroAmount`, `negativeAmount`, `invalidCurrency`, `currencyConflict`, `blankMerchant`, `merchantTooLong`, `blankCard`, `cardTooLong`, `nameTooLong`, `invalidTime`, `timeInFuture`, `timeTooOld`.

A body that is not a JSON object, or has no usable `idempotencyKey`, has nothing to key a record on and is refused without one.

Only expenses are logged: a zero or negative amount is refused, and so is a blank merchant. iOS sometimes runs the automation with an empty amount and merchant; the request is stored as refused and appears under **Show recent payments** in Accounts → iOS Automation, so the user can enter the payment by hand.

### Conflict (409)

`details.reason`:

- `keyReused`: the key was already used for a different payment (another card, amount, currency or merchant).
- `dismissed`: the user dismissed this payment on the iOS Automation page.

## Idempotency

`idempotencyKey` identifies one payment attempt. Sending the same key with the same payment again returns the stored outcome (`duplicate: true`) and writes nothing, so a client may retry freely after a timeout.

A key cannot be fully stable when the client has no transaction time of its own (Apple's Wallet trigger has none). The iOS 26 shortcut sends the SHA-256 hex of `<card>|<merchant>|<amount text>|<time to the minute>`. Other clients may send a UUID or any string that matches the key rule.

### Repeat window

The server also compares each request to the payments it already logged. A request is a **repeat** when a logged payment of the same user has the same fingerprint and the two times are close. The fingerprint covers the normalized card, the amount text, the explicit currency and the merchant, and not `time` or `name`. This catches an automation that fires twice, a manual re-run and two automations on one card, which would otherwise get different keys when the key's time changes.

How close depends on what the times mean:

| Both requests carry                                         | Window                                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `time` with `timeSource: transaction`                       | 2 seconds. One payment has one timestamp.                                                    |
| `time`, otherwise (the shipped shortcut sends its run time) | 20 seconds. A double fire runs twice within seconds; a second terminal payment takes longer. |
| no `time` on one of them                                    | 120 seconds, measured from receipt.                                                          |

A repeat answers like a replay (`duplicate: true`, "Already logged …") and logs nothing. The consequence: a genuine second identical payment inside the window reads as a repeat, and the user has to add it by hand. The iOS 26 shortcut cuts its idempotency key to the minute, so two identical taps in one calendar minute share a key and the second replays regardless of the window.

A stored key is kept as `externalReference` on the transaction, as `<source>:<idempotencyKey>`.

## Processing

### Account

The `card` name is looked up among the user's card links (Accounts → iOS Automation → Card links). Matching ignores case, extra spaces and a trailing masked number. Links point at accounts the user owns. No link means [parked](#parked-202).

A card may have several rows: one per currency, and one default row with no currency. Once the payment currency is known, the row for that currency takes the payment, else the default row; a payment in a currency without a row and without a default is parked as `unknownCard`. A payment whose currency is not known yet can only use the default row. Rows may also carry the card's last digits (4 to 8 digits), by which a bank notification finds the same card.

### Currency

The payment currency is, in order:

1. the request's `currency`, when present;
2. a 3-letter code written in the amount text (`47.00 GEL`);
3. the symbol in the amount text (`₾47`), when it names one currency. A shared symbol (`$`, `¥`, `kr`) resolves when exactly one of its currencies is one the user holds;
4. the linked account's currency.

A code and a symbol in the same text that disagree (`€47 USD`) are refused as `currencyConflict`. When the payment currency differs from the account's, the amount is converted to the account's currency at the rate for the payment date, and the original amount and currency are stored on the transaction. A missing rate parks the payment as `rateUnavailable`.

### Payee and category

The merchant text goes through the normal payee extraction: an exact name or alias match, then a fuzzy match, and otherwise a new payee is created on first sight. Then the category, in order:

1. the user's automations and the payee's default category (`enforce` or `hint` mode);
2. the most frequent category the user used for that payee in the last 12 months;
3. AI categorization, queued for every row that no rule or `enforce` payee settled, with a short wait for the answer when the row is still in the default category;
4. the user's default category.

### Settlement on bank-connected accounts

A bank-connected account refuses ordinary manual rows. A card payment on one is stored as a **planned** row (`planned: true`), and the bank sync's own transaction later settles it in place instead of creating a duplicate:

- the same account, the same currency, a booked amount within 25% of the planned amount, and a booking time within 7 days;
- when the amounts are equal, no further check; when they differ (a tip, a foreign-currency hold), the bank's merchant text must share distinctive words with the plan's merchant. City, country and business-kind words (`batumi`, `cafe`) do not count;
- the settled row keeps the plan's category and payee and takes the bank's time and data. The bank's merchant text is stored as an alias of the payee, so the next payment matches by alias.

A plan that is not settled within 7 days is listed on the iOS Automation page as **Not confirmed by the bank**, where the user deletes it (the bank's own row already exists) or keeps it.

On a manual account there is no bank to settle against: the row is final and counts in the balance at once.

## Event endpoint

`POST /api/v1/ingest/event` takes everything the iOS 27 shortcut forwards. It uses the same token, the same `ingest:transactions` scope, the same 30 requests a minute per token and the same envelope as the card-payment endpoint.

While a base-currency change runs, it answers `423` with "MoneyMatter is busy updating your currency. This payment wasn't saved, try again in a minute." The message is written for a notification banner. The request is not recorded, so the client retries with the same `idempotencyKey`.

### Kind

`kind` is required and the server never guesses it. A missing or unknown value is refused with `422` and `details.reason: "invalidKind"`.

| `kind`              | Pipeline                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `walletTransaction` | The card-payment pipeline, with the same body, the same outcomes and the same status codes. The answer carries `notify: true`: its banner always shows. |
| `notification`      | The notification pipeline below.                                                                                                                        |

A `dryRun: true` body with a valid `kind` answers the connection check of the card-payment path.

### Notification request

`Content-Type: application/json`. Unknown keys are ignored.

| Field            | Type   | Required | Notes                                                                                                   |
| ---------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `kind`           | string | yes      | `"notification"`.                                                                                       |
| `idempotencyKey` | string | yes      | As for a card payment. The shortcut keys to the second.                                                 |
| `title`          | string | no       | Up to 500 characters; a longer one is cut.                                                              |
| `subtitle`       | string | no       | Up to 500 characters.                                                                                   |
| `body`           | string | no       | Up to 4000 characters. `message` and `text` are accepted for it.                                        |
| `app`            | string | no       | The app's display name, up to 255 characters. `appName` and `sourceApp` are accepted.                   |
| `bundleId`       | string | no       | The app's bundle id. Wallet is `com.apple.Passbook`; a display name such as "Wallet" is recognized too. |
| `time`           | string | no       | The notification's own date, ISO 8601 with an offset. Defaults to the time of receipt.                  |
| `raw`            | string | no       | The notification as the device rendered it, line breaks kept. Over 8 KB is refused as `rawTooLong`.     |
| `source`         | string | no       | The client label, as for a card payment; defaults to `ios-notification`.                                |

Text fields lose control and invisible characters and have their whitespace collapsed.

### Answer

Every answer uses the API envelope. A notification's `response` is:

```json
{
  "outcome": "logged",
  "summary": "Logged 43.60 GEL at Wolt → Food",
  "requestId": "7b3e2a94-1c6d-4f08-8e35-a2d94c51b6f3",
  "notify": true
}
```

The client shows `summary` as a banner when `notify` is `true` and stays silent otherwise. On a non-2xx answer it shows `response.message`.

| `outcome`   | Status | `notify` | Meaning                                                                                               |
| ----------- | ------ | -------- | ----------------------------------------------------------------------------------------------------- |
| `logged`    | 200    | true     | A transaction was created.                                                                            |
| `attached`  | 200    | true     | The notification described a payment that was already logged and joined it ("Already logged …").      |
| `parked`    | 202    | true     | It waits for the user ("Needs your OK in MoneyMatter: …", or "Not logged yet: …"). `reason` says why. |
| `queued`    | 202    | true     | Still being processed when the wait budget ran out ("Queued, will appear shortly"). The job goes on.  |
| `ignored`   | 200    | false    | Read, and not a payment. `reason` is `declined`, `security`, `promo`, `info` or `other`.              |
| `dropped`   | 200    | false    | Stopped before anything was stored. `reason` is `noAmount`, `security`, `promo`, `muted` or `self`.   |
| `duplicate` | 200    | false    | The same `idempotencyKey` again, or the same text inside the 5-second fold.                           |

Errors: `422` for an unusable body (the card-payment reasons plus `invalidKind` and `rawTooLong`), `409 keyReused` when the key belongs to different text, `429` over the per-user caps below, and the token and plan statuses of the card-payment endpoint.

The endpoint records the request, hands it to the `ingest-notification` job without delay and polls the row every 250 ms for up to 10 seconds, so the banner shows the real outcome in the common case.

### Order of checks

1. The body (`kind`, key, fields, time).
2. The key: a repeat is answered from the earlier row, or `409` when the text differs.
3. The **prefilter**, before anything is stored: the same amount gate as the shortcut, at the user's strictness (`strict`, `standard` or `loose`, set at `PUT /user/settings/card-payments/gate-strictness`); then the drops `self`, `noAmount`, `security` and `promo`.
   - `self`: the notification comes from the Shortcuts app or the MoneyMatter web app, or starts with one of MoneyMatter's own banner or push templates in any supported language. It never creates a source.
   - `security`: the text asks to enter, confirm or not share a code and contains a standalone 4 to 8 digit code. Phrases such as "authorization code" mark a completed payment and override it.
   - `promo`: a strong promotion marker and neither card digits nor a balance.
4. A **muted** source drops the notification.
5. The per-user caps: 120 stored notifications an hour and 1000 a day (dropped ones don't count). Over a cap the answer is `429` and the source counts `rateLimited`.
6. Tx 1 records the request (`pipeline: notification`) with its text encrypted, then upserts the source.

A dropped notification is answered and **not stored**: only a counter on an already existing source changes. A source row is created only after the prefilter passes.

### Pipeline column

`IngestRequests.pipeline` is `cardPayment` or `notification`, set by the server. It decides list, retry, retention, summaries and inbox wiring. `source` stays the client's label and is never branched on.

### Text at rest

A notification's title, subtitle, body and `raw` are never stored as plain JSON. They are stored only as `IngestRequests.textEnc`, encrypted with AES-256-GCM (`encryptToken`). `payload` keeps non-text metadata: app, bundle id, time and key.

| State                                                                                | What is kept                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read and not a payment                                                               | `textEnc` and `summary` are nulled in the classifying transaction and `parsed` is reduced to `{ parser, kind, confidence }`. The row is deleted after 7 days. |
| Not read yet: `sourceNotApproved`, `aiUnavailable`, `aiCapReached`, `aiLimitReached` | `textEnc` stays at most 7 days, then the row is deleted and the source counts `expiredUnclassified`.                                                          |
| A payment                                                                            | `textEnc` is kept under the 90-day retention, for review and retry.                                                                                           |
| A source nobody approved                                                             | Deleted with what it holds after 30 days.                                                                                                                     |

The inbox card shows only the amount the gate matched, at most 32 characters, never the message.

### Sources

A **source** is `NotificationSources`: the app (bundle id, else the normalized app name) and, for messaging and mail apps, the sender (the notification's title). Its `mode`:

| Mode       | Meaning                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `auto`     | Trusted from the start: Wallet and a seed list of known bank apps.                                                               |
| `pending`  | Every other new source. Its notifications park as `sourceNotApproved` without an AI call, and its first one posts an inbox card. |
| `approved` | The user said yes. Approving enqueues the requests it holds.                                                                     |
| `muted`    | The user said no. Muting deletes the held requests and drops new ones.                                                           |

`GET /user/settings/notification-sources` lists them. `PATCH` takes `{ mode?, defaultAccountId? }` (`pending`, `approved` or `muted`; `auto` is never set by a user), and `DELETE` forgets a source. A source's `defaultAccountId` takes a payment whose text names no card.

### Processing job

`ingest-notification`, with up to 4 attempts and a back-off that doubles from 5 seconds. A job id is `${requestId}-${attempt}`, never containing `:`. After the last attempt the request parks as `processingFailed`.

1. While a base-currency change holds the user's lock, the job re-delays itself by 60 seconds without using an attempt, and the request stays `received`.
2. A source muted since the request arrived deletes the request. A source that is not trusted parks it as `sourceNotApproved`.
3. The text is **read**:
   - a Wallet notification by its layout in code (title is the card, subtitle the merchant, body only an amount), with no AI;
   - anything else by the `notificationParsing` AI feature. The model returns the kind (`debit`, `credit`, `declined`, `security`, `promo`, `info`, `other`), the stage (`authorization`, `settlement` or `payment`), the amount and currency (and the original amount when the text states two), the merchant, the card's last digits and name, whether it is an own-account transfer, a stated balance, the time the text states, the payee and a confidence.
4. A `debit` becomes an expense and a `credit` income. `declined`, `security`, `promo`, `info` and `other` are `ignored`. An own-account transfer (`ownTransfer`) and a confidence under 0.6 (`lowConfidence`) park for approval.
5. The account is resolved and the payment is logged by the shared logging core (`logIngestedPayment`), the same one the tap uses.

Park reasons of a notification: `sourceNotApproved`, `unknownAccount`, `ownTransfer`, `lowConfidence`, `rateUnavailable`, `aiUnavailable`, `aiCapReached`, `aiLimitReached` and `processingFailed`. `POST /user/settings/card-payments/requests/:id/retry` re-runs a parked request. Retrying `ownTransfer` or `lowConfidence` needs `force: true`, which is the approve action.

### Account resolution

1. The card the notification names: its Wallet card name, else its last digits. Then the payment currency's row, else the card's default row.
2. The source's `defaultAccountId`.

Archived accounts and loan or vehicle accounts don't count as found. With none, the request parks as `unknownAccount`. The server never guesses: the inbox card is pre-filled with the user's only usable account in the payment's currency when there is exactly one.

### Payee resolution

The parse call resolves the payee with the model:

1. An exact lookup first: when the raw merchant resolves through the normalized name, that payee is used and the model's payee answer is ignored.
2. Otherwise up to 15 candidates go into the prompt: token matches on payee names and aliases (tokens of 3 or more characters that are not digits and not generic merchant words), fuzzy matches, and the source's 5 most recent payees. The model returns `{ candidateId }` or `{ newName }`.
3. `applyPayeeChoice` applies it: a candidate becomes the payee and a differently normalized raw spelling is saved as an alias (unless the name is ignored or already belongs to another payee). For `newName` an existing payee with that normalized name is adopted rather than created, so a name clash can't fail the request.

### AI limits

Every AI call goes through `trackAiUsage`. `INGEST_AI_DAILY_LIMIT` (default 300, `0` disables) is a per-user daily counter in Redis shared by notification parsing, the duplicate judge and the short-balance composer; over it the request parks as `aiLimitReached`. A spent monthly allowance parks it as `aiCapReached`, and a user with no usable AI connection as `aiUnavailable`. Wallet notifications need no AI.

### Balances

A bank's stated balance is stored with the payment as `balanceAfter = { amount, currency, authoritative, scopeHint }` in `externalData.ingest.sources[]`. It is `authoritative` only when every other-currency account of the same bank (the account's connection, the accounts the source logged to or defaults to, and the account group) is zero. A `scopeHint: "total"` makes it non-authoritative. Nothing reads an authoritative balance yet, and no balance is changed from it.

### Logged now, confirm in the inbox

Every automated payment, tap or notification, is written at once, with `externalData.ingest.unconfirmed` set, and `DOMAIN_EVENTS.INGEST_PAYMENT_LOGGED` posts one **confirm card** per transaction to the Automation inbox. `GET /user/settings/card-payments/unconfirmed` lists unconfirmed rows with any open correction and conversion suggestion. Confirming clears the flag (`confirm_ingest_payment`, also an MCP tool), editing the row elsewhere clears it too, and rejecting the card deletes the payment. A second source of the same payment updates the card rather than posting another.

### Dedup

One payment can arrive as a tap, Wallet's notification, a bank push and a bank SMS, and later again from sync or a statement import.

**Slots.** A row holds at most one source per slot: `tap`, `wallet-notification`, and `bank:<sourceKey>:<stage>`. A second source in an occupied slot is a second payment, never a twin.

**Tier 1, exact twin (automatic).** Under a per-user advisory lock (`ingest-dedup:<userId>`) in both pipelines, a new source joins an existing row when all of these hold:

- the same account and direction;
- a free slot;
- the same amount and currency, or the same original amount and currency;
- within 30 minutes (`dedupConfig.twinWindowMs`);
- the same shop (the merchant text, the payee or one of its aliases agree; a missing merchant doesn't veto).

When several rows qualify they are interchangeable, so the **earliest** with a free slot wins: two coffees stay two rows whatever the arrival order. The joining source is appended to `externalData.ingest.sources[]`. On a twin the bank's amount in the account's currency wins and the charged currency stays as `originalAmount` (through `updateTransaction`), a missing payee is filled, and differing spellings become aliases. The event is re-emitted, so the one confirm card refreshes.

**Settlement rule (automatic).** A `settlement`-stage notification joins the earliest row that holds the **same source's** `authorization` slot with its `settlement` slot free, at the same amount (or original amount), the same normalized merchant text, at most 7 days old. A bank prints its wall-clock time without a zone. When a bank notification enriches a row, `inferBankTime` places that time by the quarter-hour offset that brings it within 5 minutes of the notification's arrival; a time that fits no offset is not trusted.

**Fold.** The notification fingerprint (SHA-256 of the source key, title, subtitle and body) folds a repeat only inside 5 seconds (`notificationTimings.foldMs`): the same notification on two devices, or a double fire.

**Tier 2, AI judge: suggestions only.** The `duplicateMatching` feature runs after the logging transaction commits (as categorization does), never inside the lock. It compares the new row with up to 5 candidates within 72 hours whose amount is within the card-payment tolerance (or whose charged amount is equal). A match with confidence of at least 0.6 becomes a `DuplicateSuggestions` row (`INSERT … ON CONFLICT DO NOTHING` on the ordered pair) and an inbox card. Two rows that hold the same slot count as one payment pair only when they are within 30 seconds (a double fire). The scan job (`duplicate-scan`) does the same for rows brought by `TRANSACTIONS_SYNCED` and by a statement import, the newest 100 of a run. **There is no AI auto-attach and no AI auto-merge.**

**Suggestion lifecycle.** `GET /transactions/reconciliation/suggestions` lists open suggestions with both transactions, their slots, the model's confidence and reason, and `suggestedSurvivorId`. `POST …/suggestions/:id/dismiss` dismisses one for good (a merged or stale one answers `409`). A suggestion turns `stale` when one side is removed or deleted (`markSuggestionsStale`), and `merged` when the pair is merged. `transactionId` and `candidateId` are nullable foreign keys with `ON DELETE SET NULL`, and a sweep in the cleanup cron and the scan job closes suggestions that lost a side through a path without the hook (a sync removal, an import rollback). A `merged` or `stale` suggestion is deleted after 90 days; a `dismissed` one is kept.

### Short-balance correction

Some multi-currency cards debit the whole amount from another currency's balance when the one used is short, and the notification doesn't say which one. After a payment is logged on a per-currency account whose balance before the payment was lower than the amount, `suggestShortBalanceCorrection` collects the card's other accounts whose balance covers the amount converted at the payment day's rate, orders them with the card's default first and then the fullest balance, and lets the `duplicateMatching` connection reorder them and write a one-line reason. The model may only name accounts it was shown; anything it leaves out follows in the deterministic order. The suggestion is stored as `externalData.ingest.correction` (suggested account, `estimatedAmount` flagged `estimate: true`, candidates, reason, `composedBy`) and shown on the confirm card. `POST /user/settings/card-payments/corrections/:transactionId/approve` moves the transaction to the chosen account (balances follow, the paid amount stays as `originalAmount`) and `…/dismiss` drops the suggestion. A payment is never moved without approval.

### Conversion pair

When money leaves one of the user's accounts and arrives in another within an hour (`conversionPairWindowMs`) at an amount within 3% of the day's rate (`conversionRateTolerance`), `suggestConversionPair` stores `externalData.ingestTransferSuggestion` on the legs and the inbox posts a card. Approve is `PUT /transactions/link` with the expense and income ids, dismiss is `POST /transactions/transfer-recommendations/dismiss`. A status text with no amount ("you initiated a transfer for conversion") never reaches this: it is dropped by the amount gate.

### Automation inbox

The inbox is a MoneyMatter-owned chat thread (`ChatThreads.kind = automationInbox`) with no AI.

- **One live thread.** A partial unique index on `(userId) WHERE inboxState = 'live'` and an advisory lock `chat-inbox:<userId>` around find-or-create and rollover.
- **States.** `live`, `open` (reached 200 cards while some wait: no new items, still pinned) and `closed`. A live thread with nothing waiting closes after 7 days or at 200 cards; an `open` one closes when its last card resolves. `live` and `open` are pinned: `DELETE` and `PATCH { pinned: false }` answer `409`.
- **Housekeeping.** `POST /chat/threads/:id/clear-resolved` deletes the messages whose cards are not pending and answers `{ deletedMessages }`. `POST /chat/threads/:id/archive` closes a live thread and answers `409` while a card waits.
- **No AI.** `startChatRun` refuses any inbox thread with `409`, which covers `sendMessage` and `commentOnProposal`.
- **Cards.** Run-free `createSystemProposal` posts every item, with `storeProposal` shared with `createProposal`. They expire after 30 days (`inboxConfig.cardTtlDays`); expiry resolves nothing, and re-evaluates the thread (`reevaluateInboxThreads`).

| Item                                          | Tool                            | Approve | Edit                             | Reject              |
| --------------------------------------------- | ------------------------------- | ------- | -------------------------------- | ------------------- |
| Payment logged                                | `confirm_ingest_payment`        | confirm | account, amount, payee, category | delete the payment  |
| Unknown account, own transfer, low confidence | `log_ingest_request`            | log     | account, direction               | dismiss the request |
| Pending source                                | `set_notification_source`       | approve | default account                  | mute                |
| Duplicate suggestion                          | `merge_duplicate_transactions`  | merge   | survivor                         | dismiss             |
| Conversion pair                               | the existing link-transfer tool | link    |                                  | dismiss             |

**Two-way sync.** Records hold a nullable `proposalId` (`DuplicateSuggestions`, `IngestRequests`, `NotificationSources`). Rejecting a card calls `onInboxCardRejected` in its transaction. Settling the record elsewhere rejects the card with `statusReason: "resolvedElsewhere"`. A daily backstop in the ingest cleanup cron (`sweepOrphanedInboxCards`) closes cards whose record vanished through a path without a hook.

### Assistant pushes

New inbox items and parks without a card send pushes in the `assistant` group through `createSystemProposal` and `INGEST_REQUEST_PARKED`: `automationInbox` (collapsed, one per 10 minutes with a count) and `ingestAttention` (`aiUnavailable`, `aiCapReached`, `aiLimitReached`, `rateUnavailable`, `processingFailed`, and the tap path's `unknownCard`; one per reason per day). Pushes carry counts and the thread title only.

## Examples

```bash
# Check the connection and a card link.
curl -sS https://money.example.com/api/v1/ingest/card-payment \
  -H "Authorization: Bearer $MM_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true, "card": "TBC Visa"}'

# Log a payment.
curl -sS https://money.example.com/api/v1/ingest/card-payment \
  -H "Authorization: Bearer $MM_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotencyKey": "3f1c2d9e-7a54-4b18-9c0e-5d2a8b6f4e11",
    "card": "TBC Visa",
    "merchant": "Cafe Heart of Batumi",
    "amount": "47.00 GEL",
    "time": "2026-10-17T14:05:00+04:00"
  }'
```
