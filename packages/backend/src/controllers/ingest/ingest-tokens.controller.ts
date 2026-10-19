import type { CreateIngestTokenResponse, IngestTokenDto } from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import {
  createIngestToken,
  INGEST_TOKEN_NAME_MAX_LENGTH,
  listIngestTokens,
  revokeIngestToken,
} from '@services/ingest-tokens';
import { z } from 'zod';

const MAX_EXPIRES_IN_DAYS = 3650;

export const listIngestTokensController = createController(z.object({}), async ({ user }) => {
  const data: IngestTokenDto[] = await listIngestTokens({ userId: user.id });

  return { data };
});

export const createIngestTokenController = createController(
  z.object({
    body: z.object({
      name: z.string().trim().min(1).max(INGEST_TOKEN_NAME_MAX_LENGTH),
      expiresInDays: z.number().int().min(1).max(MAX_EXPIRES_IN_DAYS).optional(),
    }),
  }),
  async ({ user, body, res }) => {
    // The secret leaves the server in this response only: the store keeps its hash. No cache,
    // proxy or browser history may keep it either.
    res.setHeader('Cache-Control', 'no-store');

    const data: CreateIngestTokenResponse = await createIngestToken({
      userId: user.id,
      name: body.name,
      expiresInDays: body.expiresInDays,
    });

    return { data, statusCode: 201 };
  },
);

export const revokeIngestTokenController = createController(
  z.object({
    params: z.object({ id: recordId() }),
  }),
  async ({ user, params }) => {
    await revokeIngestToken({ userId: user.id, id: params.id });

    return { data: { success: true } };
  },
);
