import type { CardPaymentRetryResponse, RecordId } from '@bt/shared/types';
import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import { t } from '@i18n/index';
import IngestRequests from '@models/ingest-requests.model';

import { enqueueNotificationProcessing } from '../event/notification-queue';
import { prepareNotificationRetry } from '../event/prepare-notification-retry';
import { waitForOutcome } from '../event/wait-for-outcome';
import { buildLoggedSummary } from './build-logged-summary';
import type { ProcessIngestResult } from './process-ingest-request';
import { readUserLocale } from './read-user-locale';
import { runIngestPass } from './run-ingest-pass';

/** What a retry answers: a tap's outcome, or a notification's. */
type RetryIngestResult = ProcessIngestResult | CardPaymentRetryResponse;

const retryNotificationRequest = async ({
  userId,
  requestId,
  force,
  locale,
}: {
  userId: number;
  requestId: RecordId;
  force: boolean;
  locale: string;
}): Promise<RetryIngestResult> => {
  const prepared = await prepareNotificationRetry({ requestId, force, locale });
  if (prepared.kind === 'conflict') return prepared.result;

  await enqueueNotificationProcessing({ requestId });
  const answer = await waitForOutcome({ requestId, locale });

  if (answer.outcome === 'logged') {
    const row = await IngestRequests.findOne({ where: { id: requestId }, attributes: ['transactionId'] });
    const logged = row?.transactionId
      ? await buildLoggedSummary({
          userId,
          transactionId: row.transactionId,
          duplicate: false,
          categoryPending: false,
          locale,
        })
      : null;

    return {
      outcome: 'logged',
      summary: answer.summary ?? '',
      transactionId: row?.transactionId ?? null,
      planned: logged?.planned ?? false,
      categoryPending: false,
    };
  }

  if (answer.outcome === 'parked') {
    return {
      outcome: 'parked',
      reason: (answer.reason ?? 'processingFailed') as Extract<
        CardPaymentRetryResponse,
        { outcome: 'parked' }
      >['reason'],
      summary: answer.summary ?? '',
      requestId,
    };
  }

  if (answer.outcome === 'ignored') {
    return {
      outcome: 'ignored',
      requestId,
      ...(answer.reason && { reason: answer.reason as 'declined' | 'security' | 'promo' | 'info' | 'other' }),
    };
  }

  return { outcome: 'queued', summary: answer.summary ?? '', requestId };
};

/**
 * Processes a waiting request again: parked on an unlinked card, a missing rate, a source or account
 * that needed the owner, or a failure, or received long enough ago that its first pass must have been
 * lost.
 *
 * The payment is the stored payload under the request's own user, never a body the client sends,
 * and it keeps the time it was received. The pass checks the request is still waiting under the
 * row lock, so of two concurrent retries one logs the payment and the other gets a conflict.
 *
 * A notification payment parked for the owner's approval (`ownTransfer`, `lowConfidence`) is logged
 * only with `force`; without it the retry is a conflict that names the park reason.
 */
export const retryIngestRequest = async ({
  userId,
  requestId,
  force = false,
}: {
  userId: number;
  requestId: RecordId;
  force?: boolean;
}): Promise<RetryIngestResult> => {
  const request = await findOrThrowNotFound({
    query: IngestRequests.findOne({ where: { id: requestId, userId }, attributes: ['id', 'pipeline'] }),
    message: t({ key: 'ingest.requestNotFound' }),
  });

  const locale = await readUserLocale({ userId });

  if (request.pipeline === 'notification') return retryNotificationRequest({ userId, requestId, force, locale });

  return runIngestPass({ userId, requestId, retry: true, locale });
};
