import type { RecordId } from '@bt/shared/types';

import { enqueueAfterPaymentLogged } from '../follow-up-queue';
import { categorizeAfterCommit } from './categorize-after-commit';
import { parkFailedRequest } from './park-failed-request';
import { pickAmbiguousPayee } from './pick-ambiguous-payee';
import { processIngestRequest, type ProcessIngestResult } from './process-ingest-request';

/**
 * One processing pass over a recorded request, shared by the ingest endpoint and the retry from
 * Settings. The phases run outside any transaction, so each opens and commits its own:
 *
 * 1. a merchant that is as close to several payees has the AI choose among them, before any lock;
 * 2. `processIngestRequest` (tx 2) answers with a returned outcome;
 * 3. if it threw, `parkFailedRequest` (tx 3) records the request as waiting;
 * 4. a payment this pass logged goes to AI categorization, outside any transaction, and waits a
 *    short while for the answer when its row has no category yet;
 * 5. the follow-ups of a new row are queued (a short-balance correction, a currency-conversion pair,
 *    the AI duplicate judge); they run on a worker, so the answer never waits for a model.
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
  const pickedPayeeId = await pickAmbiguousPayee({ userId, requestId });

  let result: ProcessIngestResult;
  try {
    result = await processIngestRequest({ requestId, fingerprint, retry, locale, pickedPayeeId });
  } catch (error) {
    return parkFailedRequest({ requestId, error, locale });
  }

  if (result.outcome !== 'logged' || result.duplicate || result.transactionId === null) return result;

  const categorized = await categorizeAfterCommit({ userId, requestId, transactionId: result.transactionId, locale });
  await enqueueAfterPaymentLogged({ userId, transactionId: result.transactionId });

  return categorized ? { ...result, ...categorized } : result;
};
