import type { IngestRequestReason, RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import { DOMAIN_EVENTS, eventBus, type IngestRequestParkedPayload } from '@services/common/event-bus';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';

import { buildLoggedSummary } from '../card-payment/build-logged-summary';
import type { StoredParse } from './stored-parse';

/**
 * The writes that settle a notification request. Each locks the row and acts only while it is still
 * `received`, so of two jobs that raced for one request the second finds the first one's outcome and
 * changes nothing.
 */

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
};

/**
 * Closes a request whose payment is written: it is `logged` with the line the shortcut shows. The
 * request stays `received` until now so the banner can carry the category the AI picked.
 */
export const finishLoggedNotification = withTransaction(finishLoggedNotificationImpl);
