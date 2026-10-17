import { api } from '@/api/_api';
import type { CreateIngestTokenPayload, CreateIngestTokenResponse, IngestTokenDto } from '@bt/shared/types';

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
