import { sleep } from '@common/helpers';
import { ingestFollowUpQueue } from '@services/ingest/follow-up-queue';

const POLL_MS = 25;

const busy = async (): Promise<boolean> => {
  const counts = await ingestFollowUpQueue.getJobCounts('waiting', 'active', 'delayed');

  return Object.values(counts).some((count) => count > 0);
};

/**
 * Resolves once no post-payment follow-up (short-balance correction, conversion pair, AI duplicate
 * judge) waits or runs, so a test reads what a request led to instead of racing the worker. A request
 * that was answered as logged has queued its follow-ups before the answer, so waiting here after the
 * answer is enough. Gives up quietly after `timeoutMs`: the assertions that follow then fail on the
 * missing result.
 */
export async function waitForIngestIdle({ timeoutMs = 12_000 }: { timeoutMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  // Two idle reads in a row: a job that was just finished may have queued the next one.
  let idleReads = 0;
  while (Date.now() < deadline && idleReads < 2) {
    idleReads = (await busy()) ? 0 : idleReads + 1;
    if (idleReads < 2) await sleep({ ms: POLL_MS });
  }
}
