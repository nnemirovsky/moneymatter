import type { RecordId } from './record-id';

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
