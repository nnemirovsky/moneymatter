import type { RecordId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import {
  DOMAIN_EVENTS,
  eventBus,
  type IngestPaymentLoggedPayload,
  type IngestRequestParkedPayload,
} from '@services/common/event-bus';

import { postRequestCard, safely, syncConfirmCard, syncTransferCard } from './inbox-items';

const handlePaymentLogged = async ({ userId, transactionId }: IngestPaymentLoggedPayload): Promise<void> => {
  await safely({
    what: 'post or update the confirm card',
    fn: () => syncConfirmCard({ userId, transactionId: transactionId as RecordId }),
  });
  await safely({
    what: 'post the transfer card',
    fn: () => syncTransferCard({ userId, transactionId: transactionId as RecordId }),
  });
};

const handleRequestParked = async ({ userId, requestId }: IngestRequestParkedPayload): Promise<void> => {
  await safely({
    what: 'post the request card',
    fn: () => postRequestCard({ userId, requestId: requestId as RecordId }),
  });
};

/**
 * Subscribes the inbox to the ingest pipeline: a logged payment gets its one confirm card (or has it
 * updated), a parked notification gets the card its reason calls for. A failure is logged and never
 * reaches the pipeline, which has already answered the shortcut.
 */
export function registerInboxListeners(): void {
  eventBus.on(DOMAIN_EVENTS.INGEST_PAYMENT_LOGGED, (payload: IngestPaymentLoggedPayload) => {
    void handlePaymentLogged(payload);
  });
  eventBus.on(DOMAIN_EVENTS.INGEST_REQUEST_PARKED, (payload: IngestRequestParkedPayload) => {
    void handleRequestParked(payload);
  });
  logger.info('Automation inbox event listeners registered');
}
