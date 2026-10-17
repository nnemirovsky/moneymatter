import { INGEST_SCOPES, type IngestScope, type IngestTokenDto, type IngestTokenPurpose } from '@bt/shared/types';
import IngestTokens from '@models/ingest-tokens.model';
import { app } from '@root/app';
import { API_PREFIX } from '@root/config';
import { createIngestToken } from '@services/ingest-tokens';
import request from 'supertest';

import { getUserInfo } from './user';

/**
 * Seeds an ingest token for the suite's default user (or for `userId`) and returns its secret.
 * Seeding goes straight to the token store: the settings endpoints that mint tokens over HTTP
 * are tested on their own.
 */
export async function createTestIngestToken({
  userId,
  name = 'Test token',
  scopes = [INGEST_SCOPES.transactions],
  purpose,
  expiresAt,
}: {
  userId?: number;
  name?: string;
  scopes?: IngestScope[];
  purpose?: IngestTokenPurpose;
  /** Overwrites the stored expiry, so a test can seed an already expired token. */
  expiresAt?: Date;
} = {}): Promise<{ token: IngestTokenDto; secret: string }> {
  const ownerId = userId ?? (await getUserInfo({ raw: true })).id;
  const created = await createIngestToken({ userId: ownerId, name, scopes, purpose });

  if (expiresAt) {
    await IngestTokens.update({ expiresAt }, { where: { id: created.token.id } });
  }

  return created;
}

/** A request carrying no session cookie, only the given headers: what a machine client sends. */
export function requestWithoutSession({
  method,
  url,
  headers,
  body,
}: {
  method: 'get' | 'post';
  url: string;
  headers: Record<string, string>;
  body?: object;
}) {
  const req = request(app)[method](`${API_PREFIX}${url}`).set(headers);
  return body ? req.send(body) : req;
}

export const bearer = ({ secret }: { secret: string }) => ({ Authorization: `Bearer ${secret}` });
