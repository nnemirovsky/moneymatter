import type { AccessHeadersStatusDto } from '@bt/shared/types';
import { createController } from '@controllers/helpers/controller-factory';
import { clearAccessHeaders, getAccessHeadersStatus, setAccessHeaders } from '@services/ingest';
import { z } from 'zod';

const ACCESS_HEADER_MAX_LENGTH = 255;

const headerValueSchema = z.string().trim().min(1).max(ACCESS_HEADER_MAX_LENGTH);

export const getAccessHeadersController = createController(z.object({}), async ({ user }) => {
  const data: AccessHeadersStatusDto = await getAccessHeadersStatus({ userId: user.id });

  return { data };
});

// Both values are stored, or both are `null` and the stored pair is cleared. The response is the
// same status object the GET returns: the secret is write-only.
export const setAccessHeadersController = createController(
  z.object({
    body: z
      .object({
        clientId: headerValueSchema.nullable(),
        clientSecret: headerValueSchema.nullable(),
      })
      .refine((body) => (body.clientId === null) === (body.clientSecret === null)),
  }),
  async ({ user, body }) => {
    const { clientId, clientSecret } = body;

    const data: AccessHeadersStatusDto =
      clientId === null || clientSecret === null
        ? await clearAccessHeaders({ userId: user.id })
        : await setAccessHeaders({ userId: user.id, clientId, clientSecret });

    return { data };
  },
);
