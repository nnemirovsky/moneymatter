import type { CardPaymentResponse } from '@bt/shared/types';
import { createController } from '@controllers/helpers/controller-factory';
import { ConflictError, ValidationError } from '@js/errors';
import { ingestCardPayment } from '@services/ingest';
import { z } from 'zod';

/**
 * The body is validated by the ingest pipeline itself, because a rejection is a recorded outcome
 * with its own reason code and message, not a generic schema error.
 */
export const cardPaymentController = createController(z.object({ body: z.unknown() }), async ({ req, user, body }) => {
  const result = await ingestCardPayment({ userId: user.id, tokenId: req.ingestToken?.id ?? null, body });

  switch (result.outcome) {
    case 'rejected':
      throw new ValidationError({ message: result.message, details: { reason: result.reason } });

    case 'conflict':
      throw new ConflictError({ message: result.message, details: { reason: result.reason } });

    case 'parked': {
      const data: CardPaymentResponse = result;

      return { data, statusCode: 202 };
    }

    case 'logged': {
      const data: CardPaymentResponse = {
        ...result,
        duplicate: result.duplicate ? true : undefined,
      };

      return { data };
    }

    case 'dryRun':
      return { data: result satisfies CardPaymentResponse };
  }
});
