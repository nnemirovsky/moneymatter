import { logger } from '@js/utils/logger';
import { parkHasInboxCard } from '@services/chat/inbox/inbox-items';
import { DOMAIN_EVENTS, eventBus, type IngestRequestParkedPayload } from '@services/common/event-bus';

import { emitIngestAttention } from './emit-assistant-push';

/**
 * Subscribes the assistant pushes to the ingest pipeline: a notification that parked for a reason with
 * no inbox card raises `ingestAttention`. A park with a card is covered by the inbox's own push
 * (`createSystemProposal`), so the owner is not told twice.
 */
export function registerAssistantPushListeners(): void {
  eventBus.on(DOMAIN_EVENTS.INGEST_REQUEST_PARKED, ({ userId, reason }: IngestRequestParkedPayload) => {
    if (parkHasInboxCard({ reason })) return;
    void emitIngestAttention({ userId, reason });
  });
  logger.info('Assistant push event listeners registered');
}
