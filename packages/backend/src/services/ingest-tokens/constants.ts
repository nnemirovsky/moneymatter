import { INGEST_SCOPES, type IngestScope } from '@bt/shared/types';

/** Every ingest token secret starts with this, so a leaked one is recognisable and a malformed header is cheap to reject. */
export const INGEST_TOKEN_PREFIX = 'mm_ingest_';

/** Random bytes behind the prefix (base64url-encoded, 43 characters). */
export const INGEST_TOKEN_SECRET_BYTES = 32;

/** Characters of the secret kept in clear for display: the prefix and four characters of the random part. */
export const INGEST_TOKEN_START_LENGTH = INGEST_TOKEN_PREFIX.length + 4;

export const INGEST_TOKEN_NAME_MAX_LENGTH = 100;

/** Scopes a token gets when its creator names none. */
export const DEFAULT_INGEST_SCOPES: readonly IngestScope[] = [INGEST_SCOPES.transactions];

/** `lastUsedAt` is written at most once per this many seconds, so a busy client does not write a row per request. */
export const INGEST_TOKEN_LAST_USED_THROTTLE_SECONDS = 60;

/** Failed authentications one IP may make within the window before even a valid token is refused. */
export const INGEST_AUTH_FAILURE_MAX_ATTEMPTS = 20;
export const INGEST_AUTH_FAILURE_WINDOW_SECONDS = 15 * 60;
