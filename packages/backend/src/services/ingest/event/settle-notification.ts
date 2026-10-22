import type { IngestRequestReason, RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import { resolveCardsElsewhere } from '@services/chat/inbox/inbox-resolution';
import { refreshProposal } from '@services/chat/proposals/refresh';
import { DOMAIN_EVENTS, eventBus, type IngestRequestParkedPayload } from '@services/common/event-bus';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';

import { buildLoggedSummary } from '../card-payment/build-logged-summary';
import { absorbParkedTwin } from '../twins/absorb-parked-twin';
import { findJoinedTwins, findParkedTwins, joinedSlots, probeOf, TWIN_PARK_REASONS } from '../twins/find-parked-twins';
import { lockTwins } from '../twins/lock-twins';
import type { StoredParse } from './stored-parse';

/**
 * The writes that settle a notification request. Each locks the row and acts only while it is still
 * `received`, so of two jobs that raced for one request the second finds the first one's outcome and
 * changes nothing.
 */

/** The card of the request a twin joined shows the twin: bring it up to date. A card that is gone has nothing to refresh. */
const refreshTwinCard = async ({ userId, proposalId }: { userId: number; proposalId: RecordId | null }) => {
  if (!proposalId) return;

  try {
    await refreshProposal({ userId, proposalId });
  } catch {
    // A card that is settled or gone has nothing to refresh.
  }
};

const parkNotificationImpl = async ({
  requestId,
  reason,
  summary,
  parsed,
  cardLabel,
}: {
  requestId: RecordId;
  reason: IngestRequestReason;
  summary: string;
  parsed?: StoredParse | null;
  cardLabel?: string | null;
}): Promise<boolean> => {
  const row = await IngestRequests.findOne({ where: { id: requestId }, lock: true });
  if (!row || row.status !== 'received') return false;

  // The same payment told by two sources (Wallet's notification and the bank's push) waits as one card:
  // this request joins the one already waiting instead of asking the owner twice.
  if (parsed?.payment && TWIN_PARK_REASONS.includes(reason)) {
    await lockTwins({ userId: row.userId });
    const probe = await probeOf({ request: row, payment: parsed.payment });
    const [found] = probe
      ? await findParkedTwins({
          userId: row.userId,
          requestId: row.id,
          probe,
          takenSlots: await joinedSlots({ twins: await findJoinedTwins({ userId: row.userId, requestId: row.id }) }),
        })
      : [];
    const twin = found?.request;
    if (twin) {
      await row.update({
        parsed: parsed as unknown as Record<string, unknown>,
        ...(cardLabel !== undefined && { cardLabel }),
      });
      await absorbParkedTwin({ twin: row, intoRequestId: twin.id, holdsRowLock: true });
      await runAfterCommit({ fn: () => refreshTwinCard({ userId: row.userId, proposalId: twin.proposalId }) });

      return true;
    }
  }

  await row.update({
    status: 'parked',
    reason,
    summary,
    ...(parsed !== undefined && { parsed: parsed as unknown as Record<string, unknown> | null }),
    ...(cardLabel !== undefined && { cardLabel }),
  });

  const payload: IngestRequestParkedPayload = {
    userId: row.userId,
    requestId: row.id,
    reason,
    sourceId: row.sourceId,
  };
  await runAfterCommit({ fn: () => eventBus.emit(DOMAIN_EVENTS.INGEST_REQUEST_PARKED, payload) });

  return true;
};

/**
 * Records a notification as waiting for the owner. The text stays (encrypted) so the request can be
 * processed again; `parsed` keeps the payment that was read, if one was. `INGEST_REQUEST_PARKED` is
 * emitted after the commit.
 */
export const parkNotification = withTransaction(parkNotificationImpl);

const ignoreNotificationImpl = async ({
  requestId,
  reason,
  parsed,
}: {
  requestId: RecordId;
  reason: IngestRequestReason;
  parsed: Pick<StoredParse, 'parser' | 'kind' | 'confidence'>;
}): Promise<boolean> => {
  const row = await IngestRequests.findOne({ where: { id: requestId }, lock: true });
  if (!row || row.status !== 'received') return false;

  // Not a payment: the text and the summary go, and only the reduced reading stays, so no merchant,
  // card digits or balance remain in plain JSON.
  await row.update({
    status: 'ignored',
    reason,
    textEnc: null,
    summary: null,
    cardLabel: null,
    parsed: { parser: parsed.parser, kind: parsed.kind, confidence: parsed.confidence },
  });
  await resolveCardsElsewhere({ proposalIds: [row.proposalId] });

  return true;
};

/** Records a notification that was read and is not a payment, and wipes its text. */
export const ignoreNotification = withTransaction(ignoreNotificationImpl);

const finishLoggedNotificationImpl = async ({
  requestId,
  summary,
  duplicate = false,
  locale,
}: {
  requestId: RecordId;
  /** The categorization answer, when the AI replied in time; otherwise the stored row is described. */
  summary?: string;
  /** The payment joined a row that was already logged: the line says "Already logged". */
  duplicate?: boolean;
  locale: string;
}): Promise<void> => {
  const row = await IngestRequests.findOne({ where: { id: requestId }, lock: true });
  if (!row || row.status !== 'received' || !row.transactionId) return;

  const described =
    summary ??
    (
      await buildLoggedSummary({
        userId: row.userId,
        transactionId: row.transactionId,
        duplicate,
        categoryPending: false,
        locale,
      })
    )?.summary ??
    '';

  await row.update({ status: 'logged', reason: null, summary: described });
  // A card that asked about this request (an account, a transfer) has its answer now.
  await resolveCardsElsewhere({ proposalIds: [row.proposalId] });
};

/**
 * Closes a request whose payment is written: it is `logged` with the line the shortcut shows. The
 * request stays `received` until now so the banner can carry the category the AI picked.
 */
export const finishLoggedNotification = withTransaction(finishLoggedNotificationImpl);
