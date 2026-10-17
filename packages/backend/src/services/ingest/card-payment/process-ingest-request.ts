import type {
  CardPaymentParkReason,
  CardPaymentRejectionReason,
  IngestRequestStatus,
  RecordId,
} from '@bt/shared/types';
import { t } from '@i18n/index';
import CardAccountMappings from '@models/card-account-mappings.model';
import { connection } from '@models/connection';
import IngestRequests from '@models/ingest-requests.model';
import { withTransaction } from '@services/common/with-transaction';
import { Op } from 'sequelize';

import { normalizeCardLabel } from '../normalize-card-label';
import { buildLoggedSummary } from './build-logged-summary';
import { cardPaymentTimings } from './constants';
import { formatSummary } from './format-summary';
import { parsePayload } from './parse-payload';
import { processCardPayment } from './process-card-payment';

interface LoggedResult {
  outcome: 'logged';
  summary: string;
  transactionId: RecordId | null;
  planned: boolean;
  categoryPending: boolean;
  duplicate: boolean;
}

export type ProcessIngestResult =
  | LoggedResult
  | { outcome: 'parked'; reason: CardPaymentParkReason; summary: string; requestId: RecordId }
  | { outcome: 'rejected'; reason: CardPaymentRejectionReason; message: string }
  | { outcome: 'conflict'; reason: 'keyReused' | 'dismissed'; message: string };

/** Statuses a pass may start from: the payment has no final outcome yet. */
export const OPEN_REQUEST_STATUSES: readonly IngestRequestStatus[] = ['received', 'parked', 'rejected'];

const keyReusedResult = ({ locale }: { locale: string }): ProcessIngestResult => ({
  outcome: 'conflict',
  reason: 'keyReused',
  message: t({ key: 'ingest.idempotencyConflict', locale }),
});

const dismissedResult = ({ locale }: { locale: string }): ProcessIngestResult => ({
  outcome: 'conflict',
  reason: 'dismissed',
  message: t({ key: 'ingest.requestDismissed', locale }),
});

/** The answer for a request that is already logged, from the stored transaction. */
export const replayLoggedRequest = async ({
  row,
  locale,
}: {
  row: Pick<IngestRequests, 'userId' | 'transactionId' | 'summary'>;
  locale: string;
}): Promise<LoggedResult> => {
  const logged = row.transactionId
    ? await buildLoggedSummary({
        userId: row.userId,
        transactionId: row.transactionId,
        duplicate: true,
        categoryPending: false,
        locale,
      })
    : null;

  return {
    outcome: 'logged',
    summary: logged?.summary ?? row.summary ?? '',
    transactionId: logged ? row.transactionId : null,
    planned: logged?.planned ?? false,
    categoryPending: false,
    duplicate: true,
  };
};

const markRejected = async ({
  row,
  reason,
  locale,
}: {
  row: IngestRequests;
  reason: CardPaymentRejectionReason;
  locale: string;
}): Promise<ProcessIngestResult> => {
  const message = t({ key: `ingest.rejection.${reason}`, locale });

  await row.update({ status: 'rejected', reason, summary: message });

  return { outcome: 'rejected', reason, message };
};

/** Records the request as waiting for the user and answers with the parked summary. */
export const markParked = async ({
  row,
  reason,
  summary,
}: {
  row: IngestRequests;
  reason: CardPaymentParkReason;
  summary: string;
}): Promise<ProcessIngestResult> => {
  await row.update({ status: 'parked', reason, summary });

  return { outcome: 'parked', reason, summary, requestId: row.id };
};

/**
 * Serializes the requests of one user that carry one fingerprint, so two concurrent runs of the
 * same payment under different keys cannot both pass the repeat-window check.
 */
const lockFingerprint = async ({ userId, fingerprint }: { userId: number; fingerprint: string }) => {
  await connection.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {
    replacements: { key: `ingest:${userId}:${fingerprint}` },
  });
};

/**
 * An original logged request with this fingerprint received within the repeat window of `row`.
 * Only originals count (`duplicateOfId IS NULL`): a suppressed duplicate never anchors a window,
 * so repeats cannot stretch it past the first payment.
 */
const findOriginalInWindow = ({ row }: { row: IngestRequests }) => {
  const windowMs = cardPaymentTimings.repeatWindowMs;

  return IngestRequests.findOne({
    where: {
      userId: row.userId,
      fingerprint: row.fingerprint,
      status: 'logged',
      duplicateOfId: null,
      id: { [Op.ne]: row.id },
      createdAt: {
        [Op.gte]: new Date(row.createdAt.getTime() - windowMs),
        [Op.lte]: new Date(row.createdAt.getTime() + windowMs),
      },
    },
    order: [['createdAt', 'ASC']],
  });
};

const processIngestRequestImpl = async ({
  requestId,
  fingerprint,
  locale,
}: {
  requestId: RecordId;
  /** The fingerprint of the body that arrived now. Omitted when the stored payload is retried. */
  fingerprint?: string;
  locale: string;
}): Promise<ProcessIngestResult> => {
  const row = await IngestRequests.findOne({ where: { id: requestId }, lock: true });
  if (!row) throw new Error(`Ingest request ${requestId} does not exist.`);

  if (row.status === 'dismissed') return dismissedResult({ locale });
  if (fingerprint !== undefined && row.fingerprint !== fingerprint) return keyReusedResult({ locale });
  if (row.status === 'logged') return replayLoggedRequest({ row, locale });

  await lockFingerprint({ userId: row.userId, fingerprint: row.fingerprint });
  const original = await findOriginalInWindow({ row });
  if (original) {
    const replay = await replayLoggedRequest({ row: original, locale });
    await row.update({
      status: 'logged',
      reason: null,
      transactionId: original.transactionId,
      duplicateOfId: original.id,
      summary: replay.summary,
    });

    return replay;
  }

  const parsed = parsePayload({ body: row.payload, receivedAt: row.createdAt });
  if (!parsed.ok) return markRejected({ row, reason: parsed.reason, locale });
  if (parsed.kind !== 'payment') return markRejected({ row, reason: 'invalidBody', locale });

  const mapping = await CardAccountMappings.findOne({
    where: { userId: row.userId, normalizedLabel: normalizeCardLabel({ label: parsed.card }) },
  });
  const unknownCard = () =>
    markParked({
      row,
      reason: 'unknownCard',
      summary: formatSummary({ summary: { type: 'parked', reason: 'unknownCard', card: parsed.card }, locale }),
    });
  if (!mapping) return unknownCard();

  const processed = await processCardPayment({ requestId: row.id, userId: row.userId, payment: parsed, mapping });
  if (processed.kind === 'rejected') return markRejected({ row, reason: processed.reason, locale });
  if (processed.kind === 'unlinked') return unknownCard();
  if (processed.kind === 'parked') {
    return markParked({
      row,
      reason: processed.reason,
      summary: formatSummary({ summary: { type: 'parked', reason: processed.reason }, locale }),
    });
  }

  const logged = await buildLoggedSummary({
    userId: row.userId,
    transactionId: processed.transactionId,
    duplicate: false,
    categoryPending: false,
    locale,
  });
  const summary = logged?.summary ?? '';

  await row.update({ status: 'logged', reason: null, transactionId: processed.transactionId, summary });

  return {
    outcome: 'logged',
    summary,
    transactionId: processed.transactionId,
    planned: logged?.planned ?? false,
    categoryPending: false,
    duplicate: false,
  };
};

/**
 * Tx 2 of the ingest pipeline. Locks the request row, then in this order: refuses a dismissed
 * request or a reused key, replays a logged one, folds a repeat inside the window into the
 * original, parses the stored payload, looks up the card and logs the payment. A rejection or a
 * parked payment is a returned outcome recorded on the row, never a throw; only an unexpected
 * failure throws, and `parkFailedRequest` then records it.
 */
export const processIngestRequest = withTransaction(processIngestRequestImpl);
