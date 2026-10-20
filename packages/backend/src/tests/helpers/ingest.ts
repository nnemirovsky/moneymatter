import type {
  AccessHeadersStatusDto,
  CardMappingDto,
  CardPaymentRequestDto,
  CardPaymentRequestView,
  CardPaymentRetryResponse,
  RetryCardPaymentRequestPayload,
  CreateCardMappingPayload,
  CreateCardPaymentSetupCodePayload,
  CreateCardPaymentSetupCodeResponse,
  CreateIngestTokenPayload,
  CreateIngestTokenResponse,
  GateStrictnessDto,
  IngestTokenDto,
  NotificationSourceDto,
  SetAccessHeadersPayload,
  UnconfirmedCardPaymentDto,
  UnlinkedCardDto,
  UpdateCardMappingPayload,
  UpdateNotificationSourcePayload,
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

export async function listCardPaymentRequests<R extends boolean | undefined = false>({
  status,
  raw,
}: {
  status?: CardPaymentRequestView | string;
  raw?: R;
} = {}) {
  return makeRequest<CardPaymentRequestDto[], R>({
    method: 'get',
    url: '/user/settings/card-payments/requests',
    payload: status ? { status } : undefined,
    raw,
  });
}

export async function retryCardPaymentRequest<R extends boolean | undefined = false>({
  id,
  payload,
  raw,
}: {
  id: string;
  payload?: RetryCardPaymentRequestPayload;
  raw?: R;
}) {
  return makeRequest<CardPaymentRetryResponse, R>({
    method: 'post',
    url: `/user/settings/card-payments/requests/${id}/retry`,
    payload,
    raw,
  });
}

export async function dismissCardPaymentRequest<R extends boolean | undefined = false>({
  id,
  raw,
}: {
  id: string;
  raw?: R;
}) {
  return makeRequest<{ success: boolean }, R>({
    method: 'delete',
    url: `/user/settings/card-payments/requests/${id}`,
    raw,
  });
}

export async function listUnlinkedCards<R extends boolean | undefined = false>({ raw }: { raw?: R } = {}) {
  return makeRequest<UnlinkedCardDto[], R>({
    method: 'get',
    url: '/user/settings/card-mappings/unlinked',
    raw,
  });
}

export async function listUnconfirmedCardPayments<R extends boolean | undefined = false>({ raw }: { raw?: R } = {}) {
  return makeRequest<UnconfirmedCardPaymentDto[], R>({
    method: 'get',
    url: '/user/settings/card-payments/unconfirmed',
    raw,
  });
}

export async function createCardPaymentSetupCode<R extends boolean | undefined = false>({
  payload,
  raw,
}: {
  payload: Partial<CreateCardPaymentSetupCodePayload> | Record<string, unknown>;
  raw?: R;
}) {
  return makeRequest<CreateCardPaymentSetupCodeResponse, R>({
    method: 'post',
    url: '/user/settings/card-payments/setup-code',
    payload,
    raw,
  });
}

export async function listNotificationSources<R extends boolean | undefined = false>({ raw }: { raw?: R } = {}) {
  return makeRequest<NotificationSourceDto[], R>({
    method: 'get',
    url: '/user/settings/notification-sources',
    raw,
  });
}

export async function updateNotificationSource<R extends boolean | undefined = false>({
  id,
  payload,
  raw,
}: {
  id: string;
  payload: UpdateNotificationSourcePayload | Record<string, unknown>;
  raw?: R;
}) {
  return makeRequest<NotificationSourceDto, R>({
    method: 'patch',
    url: `/user/settings/notification-sources/${id}`,
    payload,
    raw,
  });
}

export async function deleteNotificationSource<R extends boolean | undefined = false>({
  id,
  raw,
}: {
  id: string;
  raw?: R;
}) {
  return makeRequest<{ success: boolean }, R>({
    method: 'delete',
    url: `/user/settings/notification-sources/${id}`,
    raw,
  });
}

export async function getGateStrictness<R extends boolean | undefined = false>({ raw }: { raw?: R } = {}) {
  return makeRequest<GateStrictnessDto, R>({
    method: 'get',
    url: '/user/settings/card-payments/gate-strictness',
    raw,
  });
}

export async function setGateStrictness<R extends boolean | undefined = false>({
  payload,
  raw,
}: {
  payload: Partial<GateStrictnessDto> | Record<string, unknown>;
  raw?: R;
}) {
  return makeRequest<GateStrictnessDto, R>({
    method: 'put',
    url: '/user/settings/card-payments/gate-strictness',
    payload,
    raw,
  });
}
