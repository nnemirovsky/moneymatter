import {
  CARD_PAYMENT_REQUEST_VIEWS,
  type CardPaymentRequestDto,
  type CardPaymentRetryResponse,
  type UnconfirmedCardPaymentDto,
  type UnlinkedCardDto,
} from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { Money } from '@common/types/money';
import { createController } from '@controllers/helpers/controller-factory';
import { ConflictError, ValidationError } from '@js/errors';
import {
  approveCorrection,
  dismissCorrection,
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

/**
 * Answers like the ingest endpoint: 200 logged or ignored, 202 still waiting or still being processed,
 * 422 rejected, 409 not retryable. `force` logs a notification payment parked for the owner's approval.
 */
export const retryCardPaymentRequestController = createController(
  z.object({
    params: z.object({ id: recordId() }),
    body: z.object({ force: z.boolean().optional() }).optional(),
  }),
  async ({ user, params, body }) => {
    const result = await retryIngestRequest({ userId: user.id, requestId: params.id, force: body?.force === true });

    switch (result.outcome) {
      case 'rejected':
        throw new ValidationError({ message: result.message, details: { reason: result.reason } });

      case 'conflict':
        throw new ConflictError({ message: result.message, details: { reason: result.reason } });

      case 'parked':
      case 'queued': {
        const data: CardPaymentRetryResponse = result;

        return { data, statusCode: 202 };
      }

      case 'ignored': {
        const data: CardPaymentRetryResponse = result;

        return { data };
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

/**
 * Approves the short-balance correction stored on a logged payment: the payment moves to the suggested
 * account (or another one the suggestion offers) and takes the amount in that account's currency, the
 * estimate unless `amount` is given. Balances follow.
 */
export const approveIngestCorrectionController = createController(
  z.object({
    params: z.object({ transactionId: recordId() }),
    body: z.object({ accountId: recordId().optional(), amount: z.number().positive().optional() }).optional(),
  }),
  async ({ user, params, body }) => {
    const data = await approveCorrection({
      userId: user.id,
      transactionId: params.transactionId,
      accountId: body?.accountId,
      amount: body?.amount === undefined ? undefined : Money.fromDecimal(body.amount),
    });

    return { data };
  },
);

/** Leaves the payment on the account it was logged to and closes the correction. */
export const dismissIngestCorrectionController = createController(
  z.object({ params: z.object({ transactionId: recordId() }) }),
  async ({ user, params }) => {
    const data = await dismissCorrection({ userId: user.id, transactionId: params.transactionId });

    return { data };
  },
);
