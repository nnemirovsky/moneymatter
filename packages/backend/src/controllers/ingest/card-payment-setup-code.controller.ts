import { isHttpUrl } from '@bt/shared/lib/card-payment-setup-code';
import type { CreateCardPaymentSetupCodeResponse } from '@bt/shared/types';
import { createController } from '@controllers/helpers/controller-factory';
import { createCardPaymentSetupCode } from '@services/ingest';
import { INGEST_TOKEN_NAME_MAX_LENGTH } from '@services/ingest-tokens';
import { z } from 'zod';

const INGEST_URL_MAX_LENGTH = 500;

export const createCardPaymentSetupCodeController = createController(
  z.object({
    body: z.object({
      ingestUrl: z
        .string()
        .trim()
        .max(INGEST_URL_MAX_LENGTH)
        .refine((value) => isHttpUrl({ value })),
      tokenName: z.string().trim().min(1).max(INGEST_TOKEN_NAME_MAX_LENGTH).optional(),
      revokePrevious: z.boolean().optional(),
    }),
  }),
  async ({ user, body, res }) => {
    // The response carries a live credential: no cache, proxy or browser history may keep it.
    res.setHeader('Cache-Control', 'no-store');

    const data: CreateCardPaymentSetupCodeResponse = await createCardPaymentSetupCode({
      userId: user.id,
      ingestUrl: body.ingestUrl,
      tokenName: body.tokenName,
      revokePrevious: body.revokePrevious,
    });

    return { data, statusCode: 201 };
  },
);
