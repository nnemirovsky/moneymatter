import type { RecordId } from '../record-id';
import type { GateStrictness } from './amount-gate';

export * from './amount-gate';
export * from './card-payment-setup-code';
export * from './ingest-event';
export * from './normalize-card-label';
export * from './notification-sources';

/** Scopes an ingest token can carry. A scope names the one thing the token may do. */
export const INGEST_SCOPES = {
  transactions: 'ingest:transactions',
} as const;

export type IngestScope = (typeof INGEST_SCOPES)[keyof typeof INGEST_SCOPES];

/** `card-payment-setup` marks the token a generated setup code carries; `general` is one the user named. */
export const INGEST_TOKEN_PURPOSES = ['general', 'card-payment-setup'] as const;

export type IngestTokenPurpose = (typeof INGEST_TOKEN_PURPOSES)[number];

/** An ingest token as the API lists it. The secret is never part of it. */
export interface IngestTokenDto {
  id: RecordId;
  name: string;
  /** The first characters of the secret, enough for the owner to tell tokens apart. */
  start: string;
  scopes: IngestScope[];
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/** Request body of `POST /user/settings/ingest-tokens`. */
export interface CreateIngestTokenPayload {
  name: string;
  /** Days until the token stops working; omitted for a token that does not expire. */
  expiresInDays?: number;
}

/** The only response that carries the secret. It is shown once and cannot be read again. */
export interface CreateIngestTokenResponse {
  token: IngestTokenDto;
  secret: string;
}

/**
 * Lifecycle of a logged ingest request. `ignored` is a notification that was read and is not a payment
 * (declined, a code, a promo, information); its text is wiped.
 */
export const INGEST_REQUEST_STATUSES = ['received', 'logged', 'parked', 'rejected', 'dismissed', 'ignored'] as const;

export type IngestRequestStatus = (typeof INGEST_REQUEST_STATUSES)[number];

/**
 * Which pipeline owns a request. It is set by the server, never by the client: `source` stays the
 * client's own label and nothing branches on it.
 */
export const INGEST_PIPELINES = ['cardPayment', 'notification'] as const;

export type IngestPipeline = (typeof INGEST_PIPELINES)[number];

/**
 * A link between a card and an account. One card (a Wallet card name, optionally with its last
 * digits) holds one row per currency plus at most one default row: the row of the payment's
 * currency wins, else the default row. A row of one card shares `cardLabel` and `lastDigits` with
 * the others.
 */
export interface CardMappingDto {
  id: RecordId;
  /** The label as the user typed it. */
  cardLabel: string;
  /** The card's last digits, for a notification that names no Wallet card; `null` when not set. */
  lastDigits: string | null;
  /** The currency this row serves, or `null` for the card's default row. */
  currencyCode: string | null;
  accountId: RecordId;
  createdAt: string;
}

/** A card's last digits as a notification states them. */
export const CARD_LAST_DIGITS_PATTERN = /^\d{4,8}$/;

/** Request body of `POST /user/settings/card-mappings`. */
export interface CreateCardMappingPayload {
  cardLabel: string;
  accountId: RecordId;
  /** The currency the row serves; omitted or `null` makes the card's default row. */
  currencyCode?: string | null;
  lastDigits?: string | null;
}

/**
 * Request body of `PATCH /user/settings/card-mappings/:id`; at least one field. A new `cardLabel`
 * or `lastDigits` applies to every row of the card. The currency of a row cannot change.
 */
export interface UpdateCardMappingPayload {
  cardLabel?: string;
  accountId?: RecordId;
  lastDigits?: string | null;
}

/**
 * Whether Cloudflare Access service-token headers are stored for the setup code. The secret
 * is write-only and the client id is reduced to a hint.
 */
export interface AccessHeadersStatusDto {
  configured: boolean;
  /** The last characters of the client id with a leading ellipsis, or `null` when not configured. */
  clientIdHint: string | null;
}

/** Request body of `PUT /user/settings/card-payments/access-headers`: both values, or both `null` to clear. */
export interface SetAccessHeadersPayload {
  clientId: string | null;
  clientSecret: string | null;
}

/**
 * Why a card-payment request was refused as unusable. It is stored as the reason of a `rejected`
 * request, so the owner sees what the shortcut sent.
 */
export const CARD_PAYMENT_REJECTION_REASONS = [
  'invalidBody',
  'invalidIdempotencyKey',
  'invalidSource',
  'invalidAmount',
  'zeroAmount',
  'negativeAmount',
  'invalidCurrency',
  'currencyConflict',
  'blankMerchant',
  'merchantTooLong',
  'blankCard',
  'cardTooLong',
  'nameTooLong',
  'invalidTime',
  'timeInFuture',
  'timeTooOld',
] as const;

export type CardPaymentRejectionReason = (typeof CARD_PAYMENT_REJECTION_REASONS)[number];

/** Why a payment that arrived was held back instead of being logged. */
export const CARD_PAYMENT_PARK_REASONS = ['unknownCard', 'rateUnavailable', 'processingFailed'] as const;

export type CardPaymentParkReason = (typeof CARD_PAYMENT_PARK_REASONS)[number];

/**
 * The keys of a card-payment request body, as `parsePayload` reads them. Clients (the bundled
 * Shortcut among them) build their JSON from these names.
 */
export const CARD_PAYMENT_REQUEST_KEYS = [
  'amount',
  'currency',
  'merchant',
  'card',
  'name',
  'time',
  'timeSource',
  'idempotencyKey',
  'source',
  'dryRun',
] as const;

/**
 * What a request's `time` is: `run` is the moment the shortcut ran (what the Transaction input forces,
 * since it has no date of its own), `transaction` is a time that belongs to the payment itself. A
 * request without `timeSource` counts as `run`.
 */
export const CARD_PAYMENT_TIME_SOURCES = ['run', 'transaction'] as const;

export type CardPaymentTimeSource = (typeof CARD_PAYMENT_TIME_SOURCES)[number];

export type CardPaymentRequestKey = (typeof CARD_PAYMENT_REQUEST_KEYS)[number];

/** The payment was logged as a transaction (or is the replay of one that was). */
export interface CardPaymentLoggedResponse {
  outcome: 'logged';
  /** The one line the shortcut shows as a notification. */
  summary: string;
  /** `null` when the transaction has since been deleted. */
  transactionId: RecordId | null;
  /** A planned row on a bank-connected account, to be confirmed by the bank sync. */
  planned: boolean;
  /** The categorization answer is still on its way. */
  categoryPending: boolean;
  /** Present and `true` on a replay of the same request or a repeat inside the repeat window. */
  duplicate?: boolean;
}

/** The payment is stored and waits for the user (an unlinked card, a missing rate, an account to choose). */
export interface CardPaymentParkedResponse {
  outcome: 'parked';
  reason: CardPaymentParkReason | NotificationParkReason;
  summary: string;
  requestId: RecordId;
}

/** A dry run only checked the connection and the card link; nothing was written. */
export interface CardPaymentDryRunResponse {
  outcome: 'dryRun';
  summary: string;
}

export type CardPaymentResponse = CardPaymentLoggedResponse | CardPaymentParkedResponse | CardPaymentDryRunResponse;

/** Which requests `GET /user/settings/card-payments/requests` returns. */
export const CARD_PAYMENT_REQUEST_VIEWS = ['parked', 'recent'] as const;

export type CardPaymentRequestView = (typeof CARD_PAYMENT_REQUEST_VIEWS)[number];

/** How many requests the `recent` view returns. */
export const CARD_PAYMENT_RECENT_REQUESTS_LIMIT = 50;

/** Days a `logged`, `rejected` or `dismissed` request is kept before the daily cleanup deletes it. */
export const INGEST_REQUEST_RETENTION_DAYS = 90;

/** Why a notification was held back instead of being logged. */
export const NOTIFICATION_PARK_REASONS = [
  'unknownAccount',
  'sourceNotApproved',
  'aiUnavailable',
  'aiCapReached',
  'aiLimitReached',
  'ownTransfer',
  'lowConfidence',
] as const;

export type NotificationParkReason = (typeof NOTIFICATION_PARK_REASONS)[number];

/** Why a notification that was read is not a payment. It is stored as the reason of an `ignored` request. */
export const NOTIFICATION_IGNORE_REASONS = ['declined', 'security', 'promo', 'info', 'other'] as const;

export type NotificationIgnoreReason = (typeof NOTIFICATION_IGNORE_REASONS)[number];

/**
 * Why a request is in the state it is in: a park, ignore or rejection reason, or `interrupted` for a
 * request whose processing died before it recorded an outcome.
 */
export type IngestRequestReason =
  | CardPaymentParkReason
  | CardPaymentRejectionReason
  | NotificationParkReason
  | NotificationIgnoreReason
  | 'interrupted';

/** One request a client sent to the card-payment endpoint, as Settings lists it. */
export interface CardPaymentRequestDto {
  id: RecordId;
  status: IngestRequestStatus;
  reason: IngestRequestReason | null;
  /** The line the shortcut showed (or would have shown) for this request. */
  summary: string | null;
  cardLabel: string | null;
  merchant: string | null;
  /** The amount exactly as the client sent it, e.g. `"47,00 GEL"`. */
  amountText: string | null;
  /** The payment time the client sent, else the time the server received the request. */
  time: string;
  transactionId: RecordId | null;
  createdAt: string;
}

/** A retried notification that is still being processed when the answer was due; it finishes in the background. */
export interface CardPaymentQueuedResponse {
  outcome: 'queued';
  summary: string;
  requestId: RecordId;
}

/** A retried notification that was read again and is not a payment; its text is wiped. */
export interface CardPaymentIgnoredResponse {
  outcome: 'ignored';
  /** Never set: a notification that is not a payment shows no line. */
  summary?: undefined;
  requestId: RecordId;
  reason?: NotificationIgnoreReason;
}

/** The answer of `POST /user/settings/card-payments/requests/:id/retry`. */
export type CardPaymentRetryResponse =
  | CardPaymentLoggedResponse
  | CardPaymentParkedResponse
  | CardPaymentQueuedResponse
  | CardPaymentIgnoredResponse;

/** Request body of `POST /user/settings/card-payments/requests/:id/retry`. */
export interface RetryCardPaymentRequestPayload {
  /**
   * Log a notification payment the owner has to approve (`ownTransfer`, `lowConfidence`). Without it,
   * retrying such a request answers 409 with the park reason.
   */
  force?: boolean;
}

/** A card label payments are waiting on, with how many. */
export interface UnlinkedCardDto {
  cardLabel: string;
  count: number;
}

/** An amount in a currency, as a correction shows it. */
export interface IngestCorrectionAmount {
  amount: number;
  currencyCode: string;
}

/** One account the correction thinks may have paid, in the order of likelihood. */
export interface IngestCorrectionCandidate {
  accountId: RecordId;
  currencyCode: string;
  /** What the account holds now. */
  balance: number;
  /** The payment's amount in this account's currency at the day's rate. An estimate, never the bank's figure. */
  estimatedAmount: number;
  /** The card's default account: the one a bank converts from first. */
  isDefault: boolean;
}

/**
 * A suggestion stored on a payment that was logged to a per-currency account holding less than the
 * payment: the bank most likely took the whole amount from another balance of the same card. It is
 * never applied silently: the owner approves "Move it to <account>?" (the transaction moves, balances
 * follow, and the charged amount stays as the original amount) or dismisses it.
 *
 * `composedBy` says whether the AI picked the account and wrote `reason`, or the deterministic rule
 * did (default account first, no reason).
 */
export interface IngestShortBalanceCorrection {
  kind: 'shortBalance';
  status: 'open' | 'applied' | 'dismissed';
  /** What the account the payment was logged to held before it, in its own currency. */
  balanceBefore: IngestCorrectionAmount;
  suggestedAccountId: RecordId;
  /** The amount on the suggested account, converted at the day's rate. Always an estimate. */
  estimatedAmount: IngestCorrectionAmount & { estimate: true };
  candidates: IngestCorrectionCandidate[];
  /** One line from the AI; `null` for the deterministic fallback. */
  reason: string | null;
  composedBy: 'ai' | 'rules';
  createdAt: string;
}

/**
 * A suggestion stored on both legs of what looks like a currency conversion between two of the
 * user's own accounts: money out of one, the converted money into another, within about an hour and
 * at a plausible rate. It is a suggestion to link the two as a transfer; nothing is linked until the
 * owner approves it (`PUT /transactions/link`), and a dismissal (`POST /transactions/transfer-recommendations/dismiss`)
 * keeps the pair from being suggested again.
 */
export interface IngestTransferSuggestion {
  kind: 'currencyConversion';
  expenseTransactionId: RecordId;
  incomeTransactionId: RecordId;
  /** Incoming amount per unit of the outgoing amount. */
  impliedRate: number;
  /** The day's rate between the two currencies. */
  marketRate: number;
  /** How far the implied rate is from the day's, as a share. */
  deviation: number;
  createdAt: string;
}

/**
 * A row the ingest pipeline logged that the owner or the bank has not confirmed yet. Every automated
 * payment, a tap or a notification, is written at once and waits for the owner's confirmation
 * (`awaitingConfirmation`); a card-payment plan the bank did not settle within the match window is
 * listed too (`bankUnconfirmed`). One row can be both.
 */
export interface UnconfirmedCardPaymentDto {
  transactionId: RecordId;
  accountId: RecordId;
  amount: number;
  currencyCode: string;
  merchant: string | null;
  card: string | null;
  time: string;
  /** The row was logged by the ingest and the owner has not confirmed it. */
  awaitingConfirmation: boolean;
  /** A plan the bank has not settled within the match window. */
  bankUnconfirmed: boolean;
  /** Set when the payment hit a short per-currency balance: which account most likely paid. */
  correction: IngestShortBalanceCorrection | null;
  /** Set when the payment looks like one leg of a currency conversion between the user's accounts. */
  transferSuggestion: IngestTransferSuggestion | null;
}

/** Request body of `POST /user/settings/card-payments/setup-code`. */
export interface CreateCardPaymentSetupCodePayload {
  /** Absolute URL of `POST /api/v1/ingest/card-payment` on the instance the shortcut talks to. */
  ingestUrl: string;
  /** Name of the token the code carries; the server picks one when omitted. */
  tokenName?: string;
  /** Revoke the earlier setup-code tokens in the same step. Defaults to `true`. */
  revokePrevious?: boolean;
}

/**
 * The only response that carries a setup code. The code embeds the new token's secret (and the
 * stored Cloudflare Access pair), so it is shown once and cannot be read again; `token` is the
 * new token's listing entry and never holds the secret.
 */
export interface CreateCardPaymentSetupCodeResponse {
  token: IngestTokenDto;
  setupCode: string;
}

/** Lifecycle of a duplicate suggestion: `stale` when one of its transactions is gone. */
export const DUPLICATE_SUGGESTION_STATUSES = ['open', 'merged', 'dismissed', 'stale'] as const;

export type DuplicateSuggestionStatus = (typeof DUPLICATE_SUGGESTION_STATUSES)[number];

/** What produced a suggestion: the judge that runs after an ingested payment, or the scan after a sync or import. */
export const DUPLICATE_SUGGESTION_TRIGGERS = ['ingest', 'scan'] as const;

export type DuplicateSuggestionTrigger = (typeof DUPLICATE_SUGGESTION_TRIGGERS)[number];

/** The lowest AI confidence that becomes a suggestion. */
export const DUPLICATE_SUGGESTION_MIN_CONFIDENCE = 0.6;

/** The answers of `GET`/`PUT /user/settings/card-payments/gate-strictness`. */
export interface GateStrictnessDto {
  strictness: GateStrictness;
}
