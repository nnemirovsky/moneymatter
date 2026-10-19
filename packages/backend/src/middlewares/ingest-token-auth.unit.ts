import { describe, expect, it } from '@jest/globals';

import { parseBearerToken } from './ingest-token-auth';

describe('parseBearerToken', () => {
  it('returns the secret of a well-formed header', () => {
    expect(parseBearerToken({ header: 'Bearer mm_ingest_abc123' })).toBe('mm_ingest_abc123');
  });

  it('accepts a lower-case scheme and surrounding extra spaces', () => {
    expect(parseBearerToken({ header: 'bearer   mm_ingest_abc123  ' })).toBe('mm_ingest_abc123');
  });

  it.each([
    { label: 'a missing header', header: undefined },
    { label: 'an empty header', header: '' },
    { label: 'a scheme without a token', header: 'Bearer' },
    { label: 'a scheme with only spaces after it', header: 'Bearer    ' },
    { label: 'another scheme', header: 'Basic mm_ingest_abc123' },
    { label: 'a bare token', header: 'mm_ingest_abc123' },
    { label: 'a token with an inner space', header: 'Bearer mm_ingest_abc 123' },
    { label: 'a scheme glued to the token', header: 'Bearermm_ingest_abc123' },
  ])('returns null for $label', ({ header }) => {
    expect(parseBearerToken({ header })).toBeNull();
  });
});
