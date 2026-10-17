import type { RecordId } from '@bt/shared/types';
import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import { t } from '@i18n/index';
import IngestRequests from '@models/ingest-requests.model';

import type { ProcessIngestResult } from './process-ingest-request';
import { readUserLocale } from './read-user-locale';
import { runIngestPass } from './run-ingest-pass';

/**
 * Processes a waiting request again: parked on an unlinked card, a missing rate or a failure, or
 * received long enough ago that its first pass must have been lost.
 *
 * The payment is the stored payload under the request's own user, never a body the client sends,
 * and it keeps the time it was received. The pass checks the request is still waiting under the
 * row lock, so of two concurrent retries one logs the payment and the other gets a conflict.
 */
export const retryIngestRequest = async ({
  userId,
  requestId,
}: {
  userId: number;
  requestId: RecordId;
}): Promise<ProcessIngestResult> => {
  await findOrThrowNotFound({
    query: IngestRequests.findOne({ where: { id: requestId, userId }, attributes: ['id'] }),
    message: t({ key: 'ingest.requestNotFound' }),
  });

  const locale = await readUserLocale({ userId });

  return runIngestPass({ userId, requestId, retry: true, locale });
};
