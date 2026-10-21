import type { RecordId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { findTransactions } from '@models/transactions-query';
import {
  DOMAIN_EVENTS,
  eventBus,
  type IngestPaymentLoggedPayload,
  type IngestPaymentUpdatedPayload,
  type IngestRequestParkedPayload,
  type TransactionsAiCategorizedPayload,
} from '@services/common/event-bus';
import { Op, literal } from 'sequelize';

import { postRequestCard, refreshDropBothCards, safely, syncConfirmCard, syncTransferCard } from './inbox-items';

const handlePaymentLogged = async ({
  userId,
  transactionId,
}: IngestPaymentLoggedPayload | IngestPaymentUpdatedPayload): Promise<void> => {
  await safely({
    what: 'post or update the confirm card',
    fn: () => syncConfirmCard({ userId, transactionId: transactionId as RecordId }),
  });
  await safely({
    what: 'post the transfer card',
    fn: () => syncTransferCard({ userId, transactionId: transactionId as RecordId }),
  });
  await safely({
    what: 'refresh the drop-both card of the payment',
    fn: () => refreshDropBothCards({ userId, transactionId: transactionId as RecordId }),
  });
};

/**
 * An AI categorization that lands after a payment's confirm card was posted: the card of each payment
 * still waiting for the owner is brought up to date, so it never shows the category the row had before.
 * A category the owner already chose on the card stays theirs (`refreshSystemProposal`).
 */
const handleAiCategorized = async ({ transactionIds }: TransactionsAiCategorizedPayload): Promise<void> => {
  let waiting: { id: string; userId: number | null }[] = [];
  try {
    waiting = await findTransactions({
      planned: 'include',
      // The ids come from the run, which already scoped them to the user's accounts.
      access: 'unscoped-internal',
      balanceAdjustments: 'exclude',
      completeness: 'all',
      where: {
        id: { [Op.in]: transactionIds },
        [Op.and]: literal(`("Transactions"."externalData" #>> '{ingest,unconfirmed}') = 'true'`),
      },
      attributes: ['id', 'userId'],
    });
  } catch (error) {
    logger.error({
      message: 'Failed to find the AI-categorized payments that wait for the owner',
      error: error as Error,
    });
    return;
  }

  for (const row of waiting) {
    if (row.userId === null) continue;
    await safely({
      what: 'refresh the confirm card after the AI categorized the payment',
      fn: () => syncConfirmCard({ userId: row.userId!, transactionId: row.id as RecordId }),
    });
    await safely({
      what: 'refresh the drop-both card after the AI categorized the payment',
      fn: () => refreshDropBothCards({ userId: row.userId!, transactionId: row.id as RecordId }),
    });
  }
};

const handleRequestParked = async ({ userId, requestId }: IngestRequestParkedPayload): Promise<void> => {
  await safely({
    what: 'post the request card',
    fn: () => postRequestCard({ userId, requestId: requestId as RecordId }),
  });
};

/**
 * Subscribes the inbox to the ingest pipeline: a logged payment gets its one confirm card (or has it
 * updated, as it does when its suggestions change), a parked notification gets the card its reason calls for. A failure is logged and never
 * reaches the pipeline, which has already answered the shortcut.
 */
export function registerInboxListeners(): void {
  eventBus.on(DOMAIN_EVENTS.INGEST_PAYMENT_LOGGED, (payload: IngestPaymentLoggedPayload) => {
    void handlePaymentLogged(payload);
  });
  eventBus.on(DOMAIN_EVENTS.INGEST_PAYMENT_UPDATED, (payload: IngestPaymentUpdatedPayload) => {
    void handlePaymentLogged(payload);
  });
  eventBus.on(DOMAIN_EVENTS.TRANSACTIONS_AI_CATEGORIZED, (payload: TransactionsAiCategorizedPayload) => {
    void handleAiCategorized(payload);
  });
  eventBus.on(DOMAIN_EVENTS.INGEST_REQUEST_PARKED, (payload: IngestRequestParkedPayload) => {
    void handleRequestParked(payload);
  });
  logger.info('Automation inbox event listeners registered');
}
