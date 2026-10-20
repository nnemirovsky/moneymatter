import type { CreateIngestTokenResponse, IngestScope } from '@bt/shared/types';
import IngestTokens from '@models/ingest-tokens.model';
import { app } from '@root/app';
import { API_PREFIX } from '@root/config';
import request from 'supertest';

import { createIngestToken } from './ingest';

/**
 * Mints an ingest token for the suite's default user through `POST /user/settings/ingest-tokens`,
 * the way a user does, and returns its secret.
 *
 * The API refuses an already expired token and a token without scopes, so those two cases are the
 * only ones the stored row is rewritten for, to test how the ingest middleware treats them.
 */
export async function createTestIngestToken({
  name = 'Test token',
  scopes,
  expiresAt,
}: {
  name?: string;
  /** Overwrites the stored scopes, so a test can seed a token that may do nothing. */
  scopes?: IngestScope[];
  /** Overwrites the stored expiry, so a test can seed an already expired token. */
  expiresAt?: Date;
} = {}): Promise<CreateIngestTokenResponse> {
  const created = await createIngestToken({ payload: { name }, raw: true });

  if (scopes || expiresAt) {
    await IngestTokens.update(
      { ...(scopes && { scopes }), ...(expiresAt && { expiresAt }) },
      { where: { id: created.token.id } },
    );
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

/** What a machine client does: `POST /ingest/card-payment` with a bearer token and no session cookie. */
export const postCardPayment = ({
  secret,
  body,
  headers = {},
}: {
  secret: string;
  body: object;
  headers?: Record<string, string>;
}) =>
  requestWithoutSession({
    method: 'post',
    url: '/ingest/card-payment',
    headers: { ...bearer({ secret }), ...headers },
    body,
  });

/** `POST /ingest/event` the way the iOS 27 shortcut sends it: a bearer token and no session cookie. */
export const postIngestEvent = ({
  secret,
  body,
  headers = {},
}: {
  secret: string;
  body: object;
  headers?: Record<string, string>;
}) =>
  requestWithoutSession({
    method: 'post',
    url: '/ingest/event',
    headers: { ...bearer({ secret }), ...headers },
    body,
  });
