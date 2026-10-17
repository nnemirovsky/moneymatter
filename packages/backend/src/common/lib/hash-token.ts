import { createHash } from 'node:crypto';

/**
 * Hash a token the way better-auth stores its opaque tokens: SHA-256, base64url, no padding.
 * The MCP OAuth lookup and the ingest-token store both key on this value, so a change here
 * invalidates every stored token.
 */
export function hashToken({ token }: { token: string }): string {
  return createHash('sha256').update(token).digest().toString('base64url');
}
