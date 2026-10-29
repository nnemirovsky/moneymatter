import {
  type CardPaymentParkReason,
  type CardPaymentRejectionReason,
  type IngestRequestStatus,
  type NotificationParkReason,
  type RecordId,
} from '@bt/shared/types';
import { t } from '@i18n/index';
import { connection } from '@models/connection';
import IngestRequests from '@models/ingest-requests.model';
import UsersCurrencies from '@models/users-currencies.model';
import { emitIngestAttention } from '@services/assistant-push/emit-assistant-push';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';
import { Op } from 'sequelize';

import { notificationTimings } from '../event/constants';
import { resolveCardAccount } from '../resolve-card-account';
import { buildLoggedSummary } from './build-logged-summary';
import { cardPaymentTimings } from './constants';
import { formatSummary } from './format-summary';
import { parsePayload } from './parse-payload';
import { processCardPayment } from './process-card-payment';
import { isRepeatOf } from './repeat-window';
import { resolveStatedCurrency } from './resolve-currency';

interface LoggedResult {
  outcome: 'logged';
  summary: string;
  transactionId: RecordId | null;
  planned: boolean;
  categoryPending: boolean;
  duplicate: boolean;
  /**
   * The payment was already shown to the owner by another run or source (a repeat inside the window, a payment another
   * source logged), so this answer shows no banner. A replay of the same request is not suppressed: its first answer
   * may never have arrived.
   */
  suppressed?: boolean;
}

export type ProcessIngestResult =
  | LoggedResult
  | { outcome: 'parked'; reason: CardPaymentParkReason; summary: string; requestId: RecordId }
  | { outcome: 'rejected'; reason: CardPaymentRejectionReason; message: string }
  | {
      outcome: 'conflict';
      /** `keyReused`, `dismissed` and `notWaiting` refuse the request; a park reason says it needs approval (`force`). */
      reason: 'keyReused' | 'dismissed' | 'notWaiting' | NotificationParkReason;
      message: string;
    };

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

const notWaitingResult = ({ locale }: { locale: string }): ProcessIngestResult => ({
  outcome: 'conflict',
  reason: 'notWaiting',
  message: t({ key: 'ingest.requestNotWaiting', locale }),
});

/**
 * Whether the user may retry the request: it is parked, or it was received long enough ago that
 * its processing must have been lost. A tap is measured from its arrival; a notification is measured
 * from its last change, because a retry puts a parked one back to `received` and starts it over.
 */
export const isWaitingRequest = ({
  row,
  now = new Date(),
}: {
  row: Pick<IngestRequests, 'status' | 'createdAt' | 'updatedAt' | 'pipeline'>;
  now?: Date;
}) => {
  if (row.status === 'parked') return true;
  if (row.status !== 'received') return false;

  return row.pipeline === 'notification'
    ? now.getTime() - row.updatedAt.getTime() > notificationTimings.interruptedAfterMs
    : now.getTime() - row.createdAt.getTime() > cardPaymentTimings.interruptedAfterMs;
};

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

/**
 * Records the request as waiting for the user and answers with the parked summary. A park here has no
 * inbox card, so it raises the `ingestAttention` push (one per reason per day).
 */
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
  await runAfterCommit({ fn: () => emitIngestAttention({ userId: row.userId, reason }) });

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

/** How far back the repeat lookup reads: far enough to cover a request that waited in a phone's offline queue. */
const REPEAT_LOOKUP_MS = 60 * 60_000;

/**
 * An original logged request with this fingerprint that `row` repeats (see `isRepeatOf`). Only
 * originals count (`duplicateOfId IS NULL`): a suppressed duplicate never anchors a window, so
 * repeats cannot stretch it past the first payment. The earliest original wins.
 */
const findOriginalInWindow = async ({ row }: { row: IngestRequests }) => {
  const candidates = await IngestRequests.findAll({
    where: {
      userId: row.userId,
      fingerprint: row.fingerprint,
      pipeline: 'cardPayment',
      status: 'logged',
      duplicateOfId: null,
      id: { [Op.ne]: row.id },
      createdAt: {
        [Op.gte]: new Date(row.createdAt.getTime() - REPEAT_LOOKUP_MS),
        [Op.lte]: new Date(row.createdAt.getTime() + REPEAT_LOOKUP_MS),
      },
    },
    order: [['createdAt', 'ASC']],
  });

  return candidates.find((original) => isRepeatOf({ row, original })) ?? null;
};

const processIngestRequestImpl = async ({
  requestId,
  fingerprint,
  retry = false,
  locale,
  pickedPayeeId = null,
}: {
  requestId: RecordId;
  /** The fingerprint of the body that arrived now. Omitted when the stored payload is retried. */
  fingerprint?: string;
  /**
   * The user asked to retry the stored payment from Settings. Checked under the row lock, so of two
   * concurrent retries the second finds the first one's outcome and is refused.
   */
  retry?: boolean;
  locale: string;
  /** The payee the AI chose among those the merchant is as close to, before this transaction. */
  pickedPayeeId?: string | null;
}): Promise<ProcessIngestResult> => {
  const row = await IngestRequests.findOne({ where: { id: requestId }, lock: true });
  if (!row) throw new Error(`Ingest request ${requestId} does not exist.`);

  if (row.status === 'dismissed') return dismissedResult({ locale });
  if (retry && !isWaitingRequest({ row })) return notWaitingResult({ locale });
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

    return { ...replay, suppressed: true };
  }

  const parsed = parsePayload({ body: row.payload, receivedAt: row.createdAt });
  if (!parsed.ok) return markRejected({ row, reason: parsed.reason, locale });
  if (parsed.kind !== 'payment') return markRejected({ row, reason: 'invalidBody', locale });

  const heldCurrencies = await UsersCurrencies.findAll({
    where: { userId: row.userId },
    attributes: ['currencyCode'],
    raw: true,
  });
  const userCurrencyCodes = heldCurrencies.map((held) => held.currencyCode);

  // The card's account depends on the payment's currency, so the currency the payment states is
  // read first. One that is invalid or contradicts itself picks no currency row here (the default
  // row is used) and is rejected by `processCardPayment` once the account is known.
  const stated = resolveStatedCurrency({
    explicitCurrency: parsed.explicitCurrency,
    textCode: parsed.amountCurrencyCode,
    textSymbol: parsed.amountSymbol,
    userCurrencyCodes,
  });
  const resolvedCard = await resolveCardAccount({
    userId: row.userId,
    cardLabel: parsed.card,
    currencyCode: stated.ok ? stated.currencyCode : null,
  });
  const mapping = resolvedCard?.mapping;
  const unknownCard = () =>
    markParked({
      row,
      reason: 'unknownCard',
      summary: formatSummary({ summary: { type: 'parked', reason: 'unknownCard', card: parsed.card }, locale }),
    });
  if (!mapping) return unknownCard();

  const processed = await processCardPayment({
    requestId: row.id,
    userId: row.userId,
    payment: parsed,
    mapping,
    userCurrencyCodes,
    pickedPayeeId,
  });
  if (processed.kind === 'rejected') return markRejected({ row, reason: processed.reason, locale });
  if (processed.kind === 'unlinked') return unknownCard();
  if (processed.kind === 'parked') {
    return markParked({
      row,
      reason: processed.reason,
      summary: formatSummary({
        summary: {
          type: 'parked',
          reason: processed.reason,
          fromCurrencyCode: processed.fromCurrencyCode,
          toCurrencyCode: processed.toCurrencyCode,
          date: processed.date,
        },
        locale,
      }),
    });
  }

  // A payment another source already logged is answered as a repeat: "Already logged …".
  const attached = processed.kind === 'attached';
  const logged = await buildLoggedSummary({
    userId: row.userId,
    transactionId: processed.transactionId,
    duplicate: attached,
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
    duplicate: attached,
    ...(attached && { suppressed: true }),
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
