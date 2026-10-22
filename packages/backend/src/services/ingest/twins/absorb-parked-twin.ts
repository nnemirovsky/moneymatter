import type { RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import { resolveCardsElsewhere } from '@services/chat/inbox/inbox-resolution';

/**
 * Settles a parked request as the twin of another: it is dismissed as `parkedTwin`, linked to the
 * request it repeats (`duplicateOfId`), loses its text and its card closes. Its reading stays, so the
 * request it joined can still learn the card the twin named.
 */
export const absorbParkedTwin = async ({
  twin,
  intoRequestId,
}: {
  twin: IngestRequests;
  intoRequestId: RecordId;
}): Promise<void> => {
  const proposalId = twin.proposalId;

  await twin.update({
    status: 'dismissed',
    reason: 'parkedTwin',
    duplicateOfId: intoRequestId,
    textEnc: null,
    summary: null,
  });
  await resolveCardsElsewhere({ proposalIds: [proposalId] });
};

/** The requests that joined this one as its twin, oldest first. */
export const findJoinedTwins = ({ userId, requestId }: { userId: number; requestId: RecordId }) =>
  IngestRequests.findAll({
    where: { userId, pipeline: 'notification', status: 'dismissed', reason: 'parkedTwin', duplicateOfId: requestId },
    order: [['createdAt', 'ASC']],
  });
