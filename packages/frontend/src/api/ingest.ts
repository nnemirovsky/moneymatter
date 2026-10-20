import { api } from '@/api/_api';
import type {
  AccessHeadersStatusDto,
  CardMappingDto,
  CardPaymentRequestDto,
  CardPaymentRequestView,
  CardPaymentRetryResponse,
  CreateCardMappingPayload,
  CreateCardPaymentSetupCodePayload,
  CreateCardPaymentSetupCodeResponse,
  CreateIngestTokenPayload,
  CreateIngestTokenResponse,
  GateStrictnessDto,
  IngestTokenDto,
  NotificationSourceDto,
  RetryCardPaymentRequestPayload,
  SetAccessHeadersPayload,
  UnconfirmedCardPaymentDto,
  UnlinkedCardDto,
  UpdateCardMappingPayload,
  UpdateNotificationSourcePayload,
} from '@bt/shared/types';

export const getIngestTokens = async (): Promise<IngestTokenDto[]> => {
  return api.get('/user/settings/ingest-tokens');
};

/** The response is the only place the secret ever appears. */
export const createIngestToken = async (payload: CreateIngestTokenPayload): Promise<CreateIngestTokenResponse> => {
  return api.post('/user/settings/ingest-tokens', payload);
};

export const revokeIngestToken = async ({ id }: { id: IngestTokenDto['id'] }): Promise<{ success: boolean }> => {
  return api.delete(`/user/settings/ingest-tokens/${id}`);
};

export const getCardMappings = async (): Promise<CardMappingDto[]> => {
  return api.get('/user/settings/card-mappings');
};

export const createCardMapping = async (payload: CreateCardMappingPayload): Promise<CardMappingDto> => {
  return api.post('/user/settings/card-mappings', payload);
};

export const updateCardMapping = async ({
  id,
  ...payload
}: UpdateCardMappingPayload & { id: CardMappingDto['id'] }): Promise<CardMappingDto> => {
  return api.patch(`/user/settings/card-mappings/${id}`, payload);
};

export const deleteCardMapping = async ({ id }: { id: CardMappingDto['id'] }): Promise<{ success: boolean }> => {
  return api.delete(`/user/settings/card-mappings/${id}`);
};

export const getUnlinkedCards = async (): Promise<UnlinkedCardDto[]> => {
  return api.get('/user/settings/card-mappings/unlinked');
};

export const getCardPaymentRequests = async ({
  status,
}: {
  status: CardPaymentRequestView;
}): Promise<CardPaymentRequestDto[]> => {
  return api.get('/user/settings/card-payments/requests', { status });
};

/** Answers 200 when the payment was logged and 202 when it is still waiting; the body says which. */
export const retryCardPaymentRequest = async ({
  id,
  force,
}: {
  id: CardPaymentRequestDto['id'];
  /** Logs a notification payment parked for the owner's approval (`ownTransfer`, `lowConfidence`). */
  force?: boolean;
}): Promise<CardPaymentRetryResponse> => {
  const payload: RetryCardPaymentRequestPayload | undefined = force ? { force } : undefined;

  return api.post(`/user/settings/card-payments/requests/${id}/retry`, payload);
};

export const dismissCardPaymentRequest = async ({
  id,
}: {
  id: CardPaymentRequestDto['id'];
}): Promise<{ success: boolean }> => {
  return api.delete(`/user/settings/card-payments/requests/${id}`);
};

export const getUnconfirmedCardPayments = async (): Promise<UnconfirmedCardPaymentDto[]> => {
  return api.get('/user/settings/card-payments/unconfirmed');
};

export const getAccessHeaders = async (): Promise<AccessHeadersStatusDto> => {
  return api.get('/user/settings/card-payments/access-headers');
};

export const setAccessHeaders = async (payload: SetAccessHeadersPayload): Promise<AccessHeadersStatusDto> => {
  return api.put('/user/settings/card-payments/access-headers', payload);
};

/** The response is the only place the setup code ever appears: it embeds a live token. */
export const createCardPaymentSetupCode = async (
  payload: CreateCardPaymentSetupCodePayload,
): Promise<CreateCardPaymentSetupCodeResponse> => {
  return api.post('/user/settings/card-payments/setup-code', payload);
};

export const getNotificationSources = async (): Promise<NotificationSourceDto[]> => {
  return api.get('/user/settings/notification-sources');
};

export const updateNotificationSource = async ({
  id,
  ...payload
}: UpdateNotificationSourcePayload & { id: NotificationSourceDto['id'] }): Promise<NotificationSourceDto> => {
  return api.patch(`/user/settings/notification-sources/${id}`, payload);
};

export const deleteNotificationSource = async ({
  id,
}: {
  id: NotificationSourceDto['id'];
}): Promise<{ success: boolean }> => {
  return api.delete(`/user/settings/notification-sources/${id}`);
};

export const getGateStrictness = async (): Promise<GateStrictnessDto> => {
  return api.get('/user/settings/card-payments/gate-strictness');
};

export const setGateStrictness = async (payload: GateStrictnessDto): Promise<GateStrictnessDto> => {
  return api.put('/user/settings/card-payments/gate-strictness', payload);
};
