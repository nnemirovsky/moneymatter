import type { IngestRequestReason, RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import { resolveCardsElsewhere } from '@services/chat/inbox/inbox-resolution';
import { refreshProposal } from '@services/chat/proposals/refresh';
import { DOMAIN_EVENTS, eventBus, type IngestRequestParkedPayload } from '@services/common/event-bus';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';

import { buildLoggedSummary } from '../card-payment/build-logged-summary';
import { findConversionPartner } from '../conversion/find-conversion-partner';
import { absorbParkedTwin } from '../twins/absorb-parked-twin';
import { findJoinedTwins, findParkedTwins, joinedSlots, probeOf, TWIN_PARK_REASONS } from '../twins/find-parked-twins';
import { lockTwins } from '../twins/lock-twins';
import { readAiRetry, type AiRetryState } from './ai-transient';
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

  // The two notices of one currency exchange (money out in one currency, money in another) wait as one card too.
  if (parsed?.payment && TWIN_PARK_REASONS.includes(reason)) {
    await lockTwins({ userId: row.userId });
    const found = await findConversionPartner({ request: row, payment: parsed.payment });
    // Read again under its lock: an approval of the partner that got there first has moved it on, and it is not paired.
    const partner =
      found && !found.joined
        ? await IngestRequests.findOne({ where: { id: found.request.id, status: 'parked' }, lock: true })
        : null;
    if (partner) {
      await row.update({
        parsed: parsed as unknown as Record<string, unknown>,
        ...(cardLabel !== undefined && { cardLabel }),
      });
      await absorbParkedTwin({
        twin: row,
        intoRequestId: partner.id,
        holdsRowLock: true,
        reason: 'conversionLeg',
        parkReason: reason,
      });
      await runAfterCommit({
        fn: () => refreshTwinCard({ userId: row.userId, proposalId: partner.proposalId }),
      });

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

const parkForAiQuotaImpl = async ({
  requestId,
  summary,
  retry,
}: {
  requestId: RecordId;
  summary: string;
  retry: AiRetryState;
}): Promise<boolean> => {
  const row = await IngestRequests.findOne({ where: { id: requestId }, lock: true });
  if (!row || !(row.status === 'received' || (row.status === 'parked' && row.reason === 'aiQuotaWait'))) return false;

  // Only the first park tells the owner; the automatic tries that follow keep the retry state in the payload.
  const first = !readAiRetry({ payload: row.payload });
  await row.update({
    status: 'parked',
    reason: 'aiQuotaWait',
    summary,
    payload: { ...row.payload, aiRetry: retry },
  });

  // The owner is told once; the later tries only bring the line up to date.
  if (first) {
    const payload: IngestRequestParkedPayload = {
      userId: row.userId,
      requestId: row.id,
      reason: 'aiQuotaWait',
      sourceId: row.sourceId,
    };
    await runAfterCommit({ fn: () => eventBus.emit(DOMAIN_EVENTS.INGEST_REQUEST_PARKED, payload) });
  }

  return true;
};

/**
 * Records a notification as waiting for the AI model to come back (a used-up quota, a rate limit, an overload):
 * it is `parked` as `aiQuotaWait` with the line that says why and when the next try is, and the job tries again by
 * itself. The retry state stays in the payload so the next pass knows how many times it was tried.
 */
export const parkForAiQuota = withTransaction(parkForAiQuotaImpl);

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
