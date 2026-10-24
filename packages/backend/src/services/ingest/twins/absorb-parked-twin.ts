import type { RecordId } from '@bt/shared/types';
import ChatProposals from '@models/chat-proposals.model';
import IngestRequests from '@models/ingest-requests.model';
import { resolveCardsElsewhere } from '@services/chat/inbox/inbox-resolution';

import { readUserLocale } from '../card-payment/read-user-locale';
import { releaseConversionLeg } from '../conversion/release-conversion-leg';
import { readStoredParse } from '../event/stored-parse';

/**
 * Settles a parked request as the twin of another (or as the other side of its exchange, `conversionLeg`): it is dismissed, linked to the
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
  reason = 'parkedTwin',
  parkReason,
}: {
  twin: IngestRequests;
  intoRequestId: RecordId;
  holdsRowLock?: boolean;
  /** Why the request is settled: the same payment (`parkedTwin`), or one side of an exchange (`conversionLeg`). */
  reason?: 'parkedTwin' | 'conversionLeg';
  /** The reason the request is parked with, when it is not parked yet (a request being parked as it joins). */
  parkReason?: string;
}): Promise<boolean> => {
  let row: IngestRequests | null = twin;
  if (!holdsRowLock) {
    if (twin.proposalId) {
      await ChatProposals.findOne({ where: { id: twin.proposalId }, attributes: ['id'], lock: true });
    }
    row = await IngestRequests.findOne({ where: { id: twin.id, status: 'parked' }, lock: true });
  }
  if (!row) return false;

  // The other side of an exchange keeps the gate it parked under, for the day it waits on a card of its own again.
  const stored = readStoredParse({ value: row.parsed });
  await row.update({
    status: 'dismissed',
    reason,
    duplicateOfId: intoRequestId,
    textEnc: null,
    summary: null,
    ...(reason === 'conversionLeg' &&
      stored && {
        parsed: { ...stored, conversionParkReason: parkReason ?? row.reason } as unknown as Record<string, unknown>,
      }),
  });
  // A request that joined this one as the other side of an exchange waits again: this one is no longer logged for it.
  if (reason === 'parkedTwin') {
    await releaseConversionLeg({ request: row, locale: await readUserLocale({ userId: row.userId }) });
  }
  await resolveCardsElsewhere({ proposalIds: [row.proposalId] });

  return true;
};
