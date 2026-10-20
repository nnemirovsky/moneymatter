import type { IngestEventResponse } from '@bt/shared/types';
import { createController } from '@controllers/helpers/controller-factory';
import { ingestEvent } from '@services/ingest';
import { z } from 'zod';

import { toCardPaymentReply } from './card-payment-reply';

/**
 * `kind` picks the pipeline. A wallet payment is answered exactly as `POST /ingest/card-payment`
 * answers it, plus `notify: true` (its banner always shows). A notification's answer carries its own
 * `notify`; a parked or still-queued one is a 202, the rest a 200.
 *
 * The body is validated by the ingest pipeline itself, as for a card payment.
 */
export const eventController = createController(z.object({ body: z.unknown() }), async ({ req, user, body }) => {
  const answer = await ingestEvent({ userId: user.id, tokenId: req.ingestToken?.id ?? null, body });

  if (answer.kind === 'walletTransaction') {
    const { data, statusCode } = toCardPaymentReply({ result: answer.result });

    return { data: { ...data, notify: true } satisfies IngestEventResponse, statusCode };
  }

  const { response } = answer;
  const isPending = response.outcome === 'parked' || response.outcome === 'queued';

  return { data: response satisfies IngestEventResponse, statusCode: isPending ? 202 : 200 };
});
