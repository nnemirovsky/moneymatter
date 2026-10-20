import { createController } from '@controllers/helpers/controller-factory';
import { ingestCardPayment } from '@services/ingest';
import { z } from 'zod';

import { toCardPaymentReply } from './card-payment-reply';

/**
 * The body is validated by the ingest pipeline itself, because a rejection is a recorded outcome
 * with its own reason code and message, not a generic schema error.
 */
export const cardPaymentController = createController(z.object({ body: z.unknown() }), async ({ req, user, body }) =>
  toCardPaymentReply({
    result: await ingestCardPayment({ userId: user.id, tokenId: req.ingestToken?.id ?? null, body }),
  }),
);
