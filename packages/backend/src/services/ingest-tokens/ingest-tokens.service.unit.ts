import { INGEST_SCOPES, type RecordId } from '@bt/shared/types';
import { hashToken } from '@common/lib/hash-token';
import { describe, expect, it } from '@jest/globals';

import { INGEST_TOKEN_PREFIX, INGEST_TOKEN_START_LENGTH } from './constants';
import { generateIngestTokenSecret, hasIngestTokenFormat, toIngestTokenDto } from './ingest-tokens.service';

describe('generateIngestTokenSecret', () => {
  it('is the prefix followed by 32 random bytes in base64url', () => {
    const secret = generateIngestTokenSecret();

    expect(secret.startsWith(INGEST_TOKEN_PREFIX)).toBe(true);
    expect(secret.slice(INGEST_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('does not repeat', () => {
    expect(generateIngestTokenSecret()).not.toBe(generateIngestTokenSecret());
  });

  it('hashes to a value that is not the secret and fits the tokenHash column', () => {
    const secret = generateIngestTokenSecret();
    const hash = hashToken({ token: secret });

    expect(hash).not.toContain(secret);
    expect(hash).toHaveLength(43);
  });

  it('keeps the display start within its column', () => {
    expect(INGEST_TOKEN_START_LENGTH).toBe(14);
    expect(generateIngestTokenSecret().slice(0, INGEST_TOKEN_START_LENGTH)).toHaveLength(14);
  });
});

describe('hasIngestTokenFormat', () => {
  it('accepts a generated secret', () => {
    expect(hasIngestTokenFormat({ secret: generateIngestTokenSecret() })).toBe(true);
  });

  it.each(['', 'mm_ingest_', 'abc', 'MM_INGEST_abc', 'ba_oauth_abc'])('rejects %p', (secret) => {
    expect(hasIngestTokenFormat({ secret })).toBe(false);
  });
});

describe('toIngestTokenDto', () => {
  const base = {
    id: '0199aaaa-0000-7000-8000-000000000001' as RecordId,
    name: 'Phone',
    start: 'mm_ingest_AbCd',
    scopes: [INGEST_SCOPES.transactions],
    createdAt: new Date('2026-10-17T10:00:00.000Z'),
  };

  it('serialises dates as ISO strings and keeps the fields the API lists', () => {
    expect(
      toIngestTokenDto({
        token: {
          ...base,
          lastUsedAt: new Date('2026-10-17T11:30:00.000Z'),
          expiresAt: new Date('2026-11-17T10:00:00.000Z'),
        },
      }),
    ).toEqual({
      id: base.id,
      name: 'Phone',
      start: 'mm_ingest_AbCd',
      scopes: ['ingest:transactions'],
      lastUsedAt: '2026-10-17T11:30:00.000Z',
      createdAt: '2026-10-17T10:00:00.000Z',
      expiresAt: '2026-11-17T10:00:00.000Z',
    });
  });

  it('maps a never-used, non-expiring token to nulls', () => {
    const dto = toIngestTokenDto({ token: { ...base, lastUsedAt: null, expiresAt: null } });

    expect(dto.lastUsedAt).toBeNull();
    expect(dto.expiresAt).toBeNull();
  });

  it('never carries the hash or the user id', () => {
    const dto = toIngestTokenDto({
      token: { ...base, lastUsedAt: null, expiresAt: null, tokenHash: 'x', userId: 1 } as never,
    });

    expect(Object.keys(dto).toSorted()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'lastUsedAt',
      'name',
      'scopes',
      'start',
    ]);
  });
});
