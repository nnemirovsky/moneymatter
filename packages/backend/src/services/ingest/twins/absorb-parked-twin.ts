import type { RecordId } from '@bt/shared/types';
import ChatProposals from '@models/chat-proposals.model';
import IngestRequests from '@models/ingest-requests.model';
import { resolveCardsElsewhere } from '@services/chat/inbox/inbox-resolution';

/**
 * Settles a parked request as the twin of another: it is dismissed as `parkedTwin`, linked to the
 * request it repeats (`duplicateOfId`), loses its text and its card closes. Its reading stays, so the
 * request it joined can still learn the card the twin named.
 *
 * Rows are locked in the order an approval locks them (the card, then the request) and a row another
 * transaction holds is skipped, never waited for: an owner approving the twin's card at that moment
 * keeps it, and nothing can wait on a cycle. Returns whether the twin was absorbed. The twin of a
 * request that is being parked is the request itself, already locked by the caller (`holdsRowLock`).
 */
export const absorbParkedTwin = async ({
  twin,
  intoRequestId,
  holdsRowLock = false,
}: {
  twin: IngestRequests;
  intoRequestId: RecordId;
  holdsRowLock?: boolean;
}): Promise<boolean> => {
  if (twin.proposalId) {
    const card = await ChatProposals.findOne({
      where: { id: twin.proposalId },
      attributes: ['id'],
      lock: true,
      skipLocked: true,
    });
    if (!card) return false;
  }

  const row = holdsRowLock
    ? twin
    : await IngestRequests.findOne({ where: { id: twin.id, status: 'parked' }, lock: true, skipLocked: true });
  if (!row) return false;

  await row.update({
    status: 'dismissed',
    reason: 'parkedTwin',
    duplicateOfId: intoRequestId,
    textEnc: null,
    summary: null,
  });
  await resolveCardsElsewhere({ proposalIds: [row.proposalId] });

  return true;
};
