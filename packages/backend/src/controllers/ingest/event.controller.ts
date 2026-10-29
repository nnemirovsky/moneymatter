import type { IngestEventResponse } from '@bt/shared/types';
import { createController } from '@controllers/helpers/controller-factory';
import { ingestEvent } from '@services/ingest';
import { z } from 'zod';

import { toCardPaymentReply } from './card-payment-reply';

/**
 * `kind` picks the pipeline. A wallet payment is answered exactly as `POST /ingest/card-payment`
 * answers it, plus `notify` (its banner shows unless the payment is a repeat the owner was already told about). A notification's answer carries its own
 * `notify`; a parked or still-queued one is a 202, the rest a 200.
 *
 * The body is validated by the ingest pipeline itself, as for a card payment.
 */
export const eventController = createController(z.object({ body: z.unknown() }), async ({ req, user, body }) => {
  const answer = await ingestEvent({ userId: user.id, tokenId: req.ingestToken?.id ?? null, body });

  if (answer.kind === 'walletTransaction') {
    const { data, statusCode } = toCardPaymentReply({ result: answer.result });

    // A payment the owner was already told about (a repeat run, another source's payment) shows no second banner.
    const suppressed = answer.result.outcome === 'logged' && answer.result.suppressed === true;

    // The shortcut shows `summary` when it has one, so a suppressed answer carries none.
    const answerData = suppressed && data.outcome === 'logged' ? { ...data, summary: '' } : data;

    return { data: { ...answerData, notify: !suppressed } satisfies IngestEventResponse, statusCode };
  }

  const { response } = answer;
  const isPending = response.outcome === 'parked' || response.outcome === 'queued';

  return { data: response satisfies IngestEventResponse, statusCode: isPending ? 202 : 200 };
});
