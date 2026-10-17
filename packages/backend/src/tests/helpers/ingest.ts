import type { CreateIngestTokenPayload, CreateIngestTokenResponse, IngestTokenDto } from '@bt/shared/types';

import { makeRequest } from './common';

export async function listIngestTokens<R extends boolean | undefined = false>({ raw }: { raw?: R } = {}) {
  return makeRequest<IngestTokenDto[], R>({
    method: 'get',
    url: '/user/settings/ingest-tokens',
    raw,
  });
}

export async function createIngestToken<R extends boolean | undefined = false>({
  payload,
  raw,
}: {
  payload: Partial<CreateIngestTokenPayload> | Record<string, unknown>;
  raw?: R;
}) {
  return makeRequest<CreateIngestTokenResponse, R>({
    method: 'post',
    url: '/user/settings/ingest-tokens',
    payload,
    raw,
  });
}

export async function revokeIngestToken<R extends boolean | undefined = false>({ id, raw }: { id: string; raw?: R }) {
  return makeRequest<{ success: boolean }, R>({
    method: 'delete',
    url: `/user/settings/ingest-tokens/${id}`,
    raw,
  });
}
