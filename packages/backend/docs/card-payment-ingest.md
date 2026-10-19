# Card-payment ingest API

`POST /api/v1/ingest/card-payment` logs one card payment from a machine client. The Apple Pay shortcut is the first client; a script, a bank webhook relay or any other automation can use the same endpoint.

The endpoint maps the card to an account, finds or creates the payee, picks a category, converts the currency when it differs from the account's, stores the transaction and answers with one line the client can show as a notification.

## Authentication

Send a personal ingest token as a Bearer token:

```
Authorization: Bearer mm_ingest_…
```

Create a token in the app under Settings → Integrations → Ingest tokens. The secret is shown once. A token carries the scope `ingest:transactions` and nothing else: it cannot read data, and it cannot call any other route. Tokens are stored hashed, can expire, and are revoked by a password reset.

If the instance sits behind a gateway that asks for its own credentials (Cloudflare Access, for example), the client sends those headers on the same request (`CF-Access-Client-Id` and `CF-Access-Client-Secret`). They are not MoneyMatter's concern and are not read by it.

| Status | Meaning                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| 401    | The token is missing, malformed, unknown, revoked or expired.                                              |
| 403    | The token lacks the `ingest:transactions` scope. (A 403 that is not JSON comes from the gateway in front.) |
| 402    | The user's plan is read-only. Write requests are refused.                                                  |
| 429    | Rate limit: 30 requests per minute per token, and 20 failed authentications per 15 minutes per IP.         |

## Request

`Content-Type: application/json`. Unknown keys are ignored, so a newer client keeps working against an older server.

| Field            | Type             | Required | Notes                                                                                                                                 |
| ---------------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotencyKey` | string           | yes      | 8 to 128 printable ASCII characters, no spaces. See [Idempotency](#idempotency).                                                      |
| `amount`         | string or number | yes      | A positive expense amount. Text may carry a currency code or symbol and locale separators: `47.00`, `47,00 GEL`, `₾47`, `1.234,56 €`. |
| `merchant`       | string           | yes      | Up to 200 characters. A blank merchant is refused.                                                                                    |
| `card`           | string           | yes      | The card's name as the client knows it, up to 100 characters. Case and a trailing masked number (`•••• 1234`) are ignored.            |
| `currency`       | string           | no       | A 3-letter code. Wins over the amount text. See [Currency](#currency).                                                                |
| `time`           | string           | no       | ISO 8601 date and time **with an offset**: `2026-10-17T14:05:00+04:00`. Defaults to the time the request was received.                |
| `name`           | string           | no       | The payment's own name, up to 200 characters. Kept with the transaction's data.                                                       |
| `source`         | string           | no       | Which client sent it, 1 to 32 characters of `a-z`, `0-9` and `-`. Defaults to `card-payment`.                                         |
| `dryRun`         | boolean          | no       | `true` only checks the connection and a card link. Nothing is validated beyond `card` or written.                                     |

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
    "transactionId": 1234,
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
    "summary": "Not logged yet: link the card \"TBC Visa\" in MoneyMatter → Settings → Integrations → Apple Pay",
    "requestId": 88
  }
}
```

The payment was stored but not logged, and waits for the user. Nothing is lost.

| `reason`           | Cause                                                     | How it resolves                                                    |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------ |
| `unknownCard`      | No card link matches the `card` name.                     | The user links the card in Settings and logs the waiting payments. |
| `rateUnavailable`  | The payment's currency has no exchange rate for its date. | Retry from Settings later, or resend the same `idempotencyKey`.    |
| `processingFailed` | An unexpected error while processing.                     | Retry from Settings, or resend the same `idempotencyKey`.          |

A parked request is re-evaluated when the same `idempotencyKey` arrives again, so a client that retries on any non-200 answer is safe.

### Refused (422)

The payload is unusable. The request is recorded as `rejected` so the owner can see what the client sent, and a replay of the same key gets the same answer. `details.reason` is one of:

`invalidBody`, `invalidIdempotencyKey`, `invalidSource`, `invalidAmount`, `zeroAmount`, `negativeAmount`, `invalidCurrency`, `currencyConflict`, `blankMerchant`, `merchantTooLong`, `blankCard`, `cardTooLong`, `nameTooLong`, `invalidTime`, `timeInFuture`, `timeTooOld`.

A body that is not a JSON object, or has no usable `idempotencyKey`, has nothing to key a record on and is refused without one.

Only expenses are logged: a zero or negative amount is refused, and so is a blank merchant. iOS sometimes runs the automation with an empty amount and merchant; the payment then shows in the app's list of refused payments so the user can enter it by hand.

### Conflict (409)

`details.reason`:

- `keyReused`: the key was already used for a different payment (another card, amount, currency or merchant).
- `dismissed`: the user dismissed this payment in Settings.

## Idempotency

`idempotencyKey` identifies one payment attempt. Sending the same key with the same payment again returns the stored outcome (`duplicate: true`) and writes nothing, so a client may retry freely after a timeout.

A key cannot be fully stable when the client has no transaction time of its own (Apple's Wallet trigger has none). The Apple Pay shortcut sends the SHA-256 hex of `<card>|<merchant>|<amount text>|<time to the minute>`. Other clients may send a UUID or any string that matches the key rule.

### Repeat window

The server also compares each request to the payments it already logged. A request is a **repeat** when a logged payment of the same user has the same fingerprint and was received within 120 seconds of it. The fingerprint covers the normalized card, the amount text, the explicit currency and the merchant, and not `time` or `name`. This catches an automation that fires twice, a manual re-run and two automations on one card, which would otherwise get different keys when the minute changes.

A repeat answers like a replay (`duplicate: true`, "Already logged …") and logs nothing. The consequence: a genuine second identical payment on the same card at the same merchant within two minutes reads as a repeat, and the user has to add it by hand.

A stored key is kept as `externalReference` on the transaction, as `<source>:<idempotencyKey>`.

## Processing

### Account

The `card` name is looked up among the user's card links (Settings → Integrations → Apple Pay → Card links). Matching ignores case, extra spaces and a trailing masked number. Links point at accounts the user owns. No link means [parked](#parked-202).

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

A plan that is not settled within 7 days is listed in Settings as **Not confirmed by the bank**, where the user deletes it (the bank's own row already exists) or keeps it.

On a manual account there is no bank to settle against: the row is final and counts in the balance at once.

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
