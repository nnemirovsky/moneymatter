import {
  CARD_PAYMENT_REQUEST_VIEWS,
  type CardPaymentRequestDto,
  type CardPaymentRetryResponse,
  type UnconfirmedCardPaymentDto,
  type UnlinkedCardDto,
} from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { ConflictError, ValidationError } from '@js/errors';
import {
  dismissIngestRequest,
  listCardPaymentRequests,
  listUnconfirmedCardPayments,
  listUnlinkedCards,
  retryIngestRequest,
} from '@services/ingest';
import { z } from 'zod';

export const listCardPaymentRequestsController = createController(
  z.object({ query: z.object({ status: z.enum(CARD_PAYMENT_REQUEST_VIEWS).default('parked') }) }),
  async ({ user, query }) => {
    const data: CardPaymentRequestDto[] = await listCardPaymentRequests({ userId: user.id, view: query.status });

    return { data };
  },
);

/** Answers like the ingest endpoint: 200 logged, 202 still waiting, 422 rejected, 409 not retryable. */
export const retryCardPaymentRequestController = createController(
  z.object({ params: z.object({ id: recordId() }) }),
  async ({ user, params }) => {
    const result = await retryIngestRequest({ userId: user.id, requestId: params.id });

    switch (result.outcome) {
      case 'rejected':
        throw new ValidationError({ message: result.message, details: { reason: result.reason } });

      case 'conflict':
        throw new ConflictError({ message: result.message, details: { reason: result.reason } });

      case 'parked': {
        const data: CardPaymentRetryResponse = result;

        return { data, statusCode: 202 };
      }

      case 'logged': {
        const data: CardPaymentRetryResponse = { ...result, duplicate: result.duplicate ? true : undefined };

        return { data };
      }
    }
  },
);

export const dismissCardPaymentRequestController = createController(
  z.object({ params: z.object({ id: recordId() }) }),
  async ({ user, params }) => {
    await dismissIngestRequest({ userId: user.id, requestId: params.id });

    return { data: { success: true } };
  },
);

export const listUnlinkedCardsController = createController(z.object({}), async ({ user }) => {
  const data: UnlinkedCardDto[] = await listUnlinkedCards({ userId: user.id });

  return { data };
});

export const listUnconfirmedCardPaymentsController = createController(z.object({}), async ({ user }) => {
  const data: UnconfirmedCardPaymentDto[] = await listUnconfirmedCardPayments({ userId: user.id });

  return { data };
});
