import type { CardPaymentResponse } from '@bt/shared/types';
import { ConflictError, ValidationError } from '@js/errors';
import type { ingestCardPayment } from '@services/ingest';

/**
 * Turns the outcome of the card-payment pipeline into the HTTP answer: a rejection is a 422 and a
 * reused key a 409, both with their reason in `details`; a parked payment is a 202; the rest is a 200.
 */
export const toCardPaymentReply = ({
  result,
}: {
  result: Awaited<ReturnType<typeof ingestCardPayment>>;
}): { data: CardPaymentResponse; statusCode?: number } => {
  switch (result.outcome) {
    case 'rejected':
      throw new ValidationError({ message: result.message, details: { reason: result.reason } });

    case 'conflict':
      throw new ConflictError({ message: result.message, details: { reason: result.reason } });

    case 'parked':
      return { data: result satisfies CardPaymentResponse, statusCode: 202 };

    case 'logged': {
      // `suppressed` only steers the event endpoint's `notify`; it is not part of the answer.
      const { suppressed: _suppressed, ...logged } = result;

      return { data: { ...logged, duplicate: result.duplicate ? true : undefined } };
    }

    case 'dryRun':
      return { data: result satisfies CardPaymentResponse };
  }
};
