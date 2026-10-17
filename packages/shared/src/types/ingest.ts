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
