import { describe, expect, it } from '@jest/globals';

import { hashToken } from './hash-token';

describe('hashToken', () => {
  // Stored MCP access tokens were hashed with this exact output; a change here would stop them verifying.
  it('returns the SHA-256 digest as unpadded base64url for a fixed input', () => {
    expect(hashToken({ token: 'abc' })).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
    expect(hashToken({ token: 'mm_ingest_example-token' })).toBe('UtWathwl2cJR1FZXuy8LAeBo40CKgcMnil-PV0kpe2I');
  });

  it('is deterministic and distinguishes inputs', () => {
    expect(hashToken({ token: 'one' })).toBe(hashToken({ token: 'one' }));
    expect(hashToken({ token: 'one' })).not.toBe(hashToken({ token: 'two' }));
  });

  it('never contains base64 padding or characters outside the url-safe alphabet', () => {
    expect(hashToken({ token: 'anything' })).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
