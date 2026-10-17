import type {
  AccessHeadersStatusDto,
  CardMappingDto,
  CreateCardMappingPayload,
  CreateIngestTokenPayload,
  CreateIngestTokenResponse,
  IngestTokenDto,
  SetAccessHeadersPayload,
  UpdateCardMappingPayload,
} from '@bt/shared/types';

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

export async function listCardMappings<R extends boolean | undefined = false>({ raw }: { raw?: R } = {}) {
  return makeRequest<CardMappingDto[], R>({
    method: 'get',
    url: '/user/settings/card-mappings',
    raw,
  });
}

export async function createCardMapping<R extends boolean | undefined = false>({
  payload,
  raw,
}: {
  payload: Partial<CreateCardMappingPayload> | Record<string, unknown>;
  raw?: R;
}) {
  return makeRequest<CardMappingDto, R>({
    method: 'post',
    url: '/user/settings/card-mappings',
    payload,
    raw,
  });
}

export async function updateCardMapping<R extends boolean | undefined = false>({
  id,
  payload,
  raw,
}: {
  id: string;
  payload: UpdateCardMappingPayload | Record<string, unknown>;
  raw?: R;
}) {
  return makeRequest<CardMappingDto, R>({
    method: 'patch',
    url: `/user/settings/card-mappings/${id}`,
    payload,
    raw,
  });
}

export async function deleteCardMapping<R extends boolean | undefined = false>({ id, raw }: { id: string; raw?: R }) {
  return makeRequest<{ success: boolean }, R>({
    method: 'delete',
    url: `/user/settings/card-mappings/${id}`,
    raw,
  });
}

export async function getAccessHeaders<R extends boolean | undefined = false>({ raw }: { raw?: R } = {}) {
  return makeRequest<AccessHeadersStatusDto, R>({
    method: 'get',
    url: '/user/settings/card-payments/access-headers',
    raw,
  });
}

export async function setAccessHeaders<R extends boolean | undefined = false>({
  payload,
  raw,
}: {
  payload: SetAccessHeadersPayload | Record<string, unknown>;
  raw?: R;
}) {
  return makeRequest<AccessHeadersStatusDto, R>({
    method: 'put',
    url: '/user/settings/card-payments/access-headers',
    payload,
    raw,
  });
}
