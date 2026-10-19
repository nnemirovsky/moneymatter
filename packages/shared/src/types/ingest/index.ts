import type { RecordId } from '../record-id';

export * from './card-payment-setup-code';
export * from './normalize-card-label';

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

/** Lifecycle of a logged ingest request. */
export const INGEST_REQUEST_STATUSES = ['received', 'logged', 'parked', 'rejected', 'dismissed'] as const;

export type IngestRequestStatus = (typeof INGEST_REQUEST_STATUSES)[number];

/** A link between a Wallet card name and the account its payments are logged on. */
export interface CardMappingDto {
  id: RecordId;
  /** The label as the user typed it. */
  cardLabel: string;
  accountId: RecordId;
  createdAt: string;
}

/** Request body of `POST /user/settings/card-mappings`. */
export interface CreateCardMappingPayload {
  cardLabel: string;
  accountId: RecordId;
}

/** Request body of `PATCH /user/settings/card-mappings/:id`; at least one field. */
export interface UpdateCardMappingPayload {
  cardLabel?: string;
  accountId?: RecordId;
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
  'idempotencyKey',
  'source',
  'dryRun',
] as const;

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

/** The payment is stored and waits for the user (an unlinked card, a missing rate). */
export interface CardPaymentParkedResponse {
  outcome: 'parked';
  reason: CardPaymentParkReason;
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

/**
 * Why a request is in the state it is in: a park or rejection reason, or `interrupted` for a
 * request whose processing died before it recorded an outcome.
 */
export type IngestRequestReason = CardPaymentParkReason | CardPaymentRejectionReason | 'interrupted';

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

/** The answer of `POST /user/settings/card-payments/requests/:id/retry`. */
export type CardPaymentRetryResponse = CardPaymentLoggedResponse | CardPaymentParkedResponse;

/** A card label payments are waiting on, with how many. */
export interface UnlinkedCardDto {
  cardLabel: string;
  count: number;
}

/** A planned row the card-payment ingest wrote that the bank has not confirmed within the match window. */
export interface UnconfirmedCardPaymentDto {
  transactionId: RecordId;
  accountId: RecordId;
  amount: number;
  currencyCode: string;
  merchant: string | null;
  card: string | null;
  time: string;
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
