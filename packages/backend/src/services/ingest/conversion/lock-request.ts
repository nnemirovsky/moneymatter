import ChatProposals from '@models/chat-proposals.model';
import IngestRequests from '@models/ingest-requests.model';
import { resolveCardsElsewhere } from '@services/chat/inbox/inbox-resolution';

/**
 * Settles a waiting request because its payment was logged somewhere else: it is dismissed as `resolvedElsewhere`,
 * loses its text, and its card closes. The card is locked first and the request second, the order an approval takes,
 * and the request is read again under the lock: one an approval got to first is left alone (`false`).
 */
export const absorbLockedRequest = async ({ request }: { request: IngestRequests }): Promise<boolean> => {
  if (request.proposalId) {
    await ChatProposals.findOne({ where: { id: request.proposalId }, attributes: ['id'], lock: true });
  }
  const row = await IngestRequests.findOne({ where: { id: request.id, status: 'parked' }, lock: true });
  if (!row) return false;

  await row.update({ status: 'dismissed', reason: 'resolvedElsewhere', textEnc: null, summary: null });
  await resolveCardsElsewhere({ proposalIds: [row.proposalId] });

  return true;
};
