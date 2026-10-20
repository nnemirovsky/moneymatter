import { describe, expect, it } from 'vitest';

import {
  INGEST_TOKEN_EXPIRY_OPTIONS,
  buildCreateTokenPayload,
  formatTokenStart,
  getIngestScopeLabelKey,
} from './ingest-tokens';

describe('formatTokenStart', () => {
  it('marks the start as a prefix of a longer secret', () => {
    expect(formatTokenStart({ start: 'mm_ingest_aB3' })).toBe('mm_ingest_aB3…');
  });
});

describe('getIngestScopeLabelKey', () => {
  it('maps the card-payment scope to its label', () => {
    expect(getIngestScopeLabelKey({ scope: 'ingest:transactions' })).toBe(
      'settings.integrations.ingestTokens.scopes.transactions',
    );
  });

  it('returns null for a scope this client does not know, so the raw scope is shown', () => {
    expect(getIngestScopeLabelKey({ scope: 'ingest:something-new' })).toBeNull();
  });
});

describe('INGEST_TOKEN_EXPIRY_OPTIONS', () => {
  it('offers no expiry first, then 30 days, 90 days and a year', () => {
    expect(INGEST_TOKEN_EXPIRY_OPTIONS.map(({ id, days }) => [id, days])).toEqual([
      ['never', undefined],
      ['days30', 30],
      ['days90', 90],
      ['year1', 365],
    ]);
  });

  it('points every option at an existing i18n label', () => {
    expect(INGEST_TOKEN_EXPIRY_OPTIONS.map(({ labelKey }) => labelKey)).toEqual([
      'settings.integrations.ingestTokens.create.expiry.never',
      'settings.integrations.ingestTokens.create.expiry.days30',
      'settings.integrations.ingestTokens.create.expiry.days90',
      'settings.integrations.ingestTokens.create.expiry.year1',
    ]);
  });
});

describe('buildCreateTokenPayload', () => {
  it('trims the name and omits expiresInDays for a token that does not expire', () => {
    expect(buildCreateTokenPayload({ name: '  iPhone shortcut  ', expiresInDays: undefined })).toEqual({
      name: 'iPhone shortcut',
    });
  });

  it('sends expiresInDays when the token expires', () => {
    expect(buildCreateTokenPayload({ name: 'Script', expiresInDays: 90 })).toEqual({
      name: 'Script',
      expiresInDays: 90,
    });
  });
});
