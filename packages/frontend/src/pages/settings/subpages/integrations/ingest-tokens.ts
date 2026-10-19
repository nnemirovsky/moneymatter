import { INGEST_SCOPES, type CreateIngestTokenPayload } from '@bt/shared/types';

const LABEL_ROOT = 'settings.integrations.ingestTokens';
const DAYS_IN_YEAR = 365;

export interface IngestTokenExpiryOption {
  id: 'never' | 'days30' | 'days90' | 'year1';
  /** `undefined` for a token that does not expire. */
  days: number | undefined;
  labelKey: string;
}

export const INGEST_TOKEN_EXPIRY_OPTIONS: IngestTokenExpiryOption[] = [
  { id: 'never', days: undefined, labelKey: `${LABEL_ROOT}.create.expiry.never` },
  { id: 'days30', days: 30, labelKey: `${LABEL_ROOT}.create.expiry.days30` },
  { id: 'days90', days: 90, labelKey: `${LABEL_ROOT}.create.expiry.days90` },
  { id: 'year1', days: DAYS_IN_YEAR, labelKey: `${LABEL_ROOT}.create.expiry.year1` },
];

const SCOPE_LABEL_KEYS: Record<string, string> = {
  [INGEST_SCOPES.transactions]: `${LABEL_ROOT}.scopes.transactions`,
};

/** The listing carries only the first characters of the secret; the ellipsis shows there is more. */
export const formatTokenStart = ({ start }: { start: string }): string => `${start}…`;

/** `null` for a scope a newer server added, so the caller falls back to the raw scope. */
export const getIngestScopeLabelKey = ({ scope }: { scope: string }): string | null => SCOPE_LABEL_KEYS[scope] ?? null;

export const buildCreateTokenPayload = ({
  name,
  expiresInDays,
}: {
  name: string;
  expiresInDays: number | undefined;
}): CreateIngestTokenPayload => ({
  name: name.trim(),
  ...(expiresInDays === undefined ? {} : { expiresInDays }),
});
