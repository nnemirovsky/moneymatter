import type { RecordId } from '@bt/shared/types';

import { afterPaymentLogged } from '../after-payment-logged';
import { categorizeAfterCommit } from './categorize-after-commit';
import { parkFailedRequest } from './park-failed-request';
import { processIngestRequest, type ProcessIngestResult } from './process-ingest-request';

/**
 * One processing pass over a recorded request, shared by the ingest endpoint and the retry from
 * Settings. The phases run outside any transaction, so each opens and commits its own:
 *
 * 1. `processIngestRequest` (tx 2) answers with a returned outcome;
 * 2. if it threw, `parkFailedRequest` (tx 3) records the request as waiting;
 * 3. a payment this pass logged goes to AI categorization, outside any transaction, and waits a
 *    short while for the answer when its row has no category yet;
 * 4. the follow-ups of a new row run (a short-balance correction, a currency-conversion pair).
 */
export const runIngestPass = async ({
  userId,
  requestId,
  fingerprint,
  retry,
  locale,
}: {
  userId: number;
  requestId: RecordId;
  fingerprint?: string;
  retry?: boolean;
  locale: string;
}): Promise<ProcessIngestResult> => {
  let result: ProcessIngestResult;
  try {
    result = await processIngestRequest({ requestId, fingerprint, retry, locale });
  } catch (error) {
    return parkFailedRequest({ requestId, error, locale });
  }

  if (result.outcome !== 'logged' || result.duplicate || result.transactionId === null) return result;

  const categorized = await categorizeAfterCommit({ userId, requestId, transactionId: result.transactionId, locale });
  await afterPaymentLogged({ userId, transactionId: result.transactionId });

  return categorized ? { ...result, ...categorized } : result;
};
