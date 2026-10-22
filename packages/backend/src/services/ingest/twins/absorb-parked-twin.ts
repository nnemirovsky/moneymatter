import type { RecordId } from '@bt/shared/types';
import ChatProposals from '@models/chat-proposals.model';
import IngestRequests from '@models/ingest-requests.model';
import { resolveCardsElsewhere } from '@services/chat/inbox/inbox-resolution';

/**
 * Settles a parked request as the twin of another: it is dismissed as `parkedTwin`, linked to the
 * request it repeats (`duplicateOfId`), loses its text and its card closes. Its reading stays, so the
 * request it joined can still learn the card the twin named.
 *
 * Another waiting request is locked in the order an approval locks it (its card, then the request) and
 * read again under the lock: an approval that got there first has moved the request on, and it is left
 * alone (`false`); a short holder of the card (a refresh, a reject) is waited for, so a twin is never
 * missed because of one. Two approvals of twins that never joined can still wait on each other's cards
 * (each holds its own and asks for the other's): Postgres aborts one, which the owner sees as a transient
 * error on that tap, and the survivor leaves the right state. The
 * twin of a request that is being parked is the request itself, already locked by the caller
 * (`holdsRowLock`). Returns whether the twin was absorbed.
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
  let row: IngestRequests | null = twin;
  if (!holdsRowLock) {
    if (twin.proposalId) {
      await ChatProposals.findOne({ where: { id: twin.proposalId }, attributes: ['id'], lock: true });
    }
    row = await IngestRequests.findOne({ where: { id: twin.id, status: 'parked' }, lock: true });
  }
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
