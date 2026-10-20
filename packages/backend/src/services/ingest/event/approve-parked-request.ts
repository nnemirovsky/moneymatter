import { ACCOUNT_STATUSES, isDedicatedFlowAccountCategory, type RecordId } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ConflictError, NotFoundError, ValidationError } from '@js/errors';
import { logger } from '@js/utils/logger';
import Accounts from '@models/accounts.model';
import IngestRequests from '@models/ingest-requests.model';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';

import { isWaitingRequest } from '../card-payment/process-ingest-request';
import { readUserLocale } from '../card-payment/read-user-locale';
import { enqueueNotificationProcessing } from './notification-queue';
import { prepareNotificationRetry } from './prepare-notification-retry';
import { readStoredParse } from './stored-parse';

/** The park reasons whose payment the owner can log from the inbox card. */
const APPROVABLE_REASONS = ['unknownAccount', 'ownTransfer', 'lowConfidence'];

const assertUsableAccount = async ({ userId, accountId }: { userId: number; accountId: RecordId }): Promise<void> => {
  const account = await Accounts.findOne({
    where: { id: accountId, userId },
    attributes: ['id', 'status', 'accountCategory'],
  });

  if (
    !account ||
    account.status === ACCOUNT_STATUSES.archived ||
    isDedicatedFlowAccountCategory(account.accountCategory)
  ) {
    throw new NotFoundError({ message: t({ key: 'accounts.accountNotFoundForTransaction' }) });
  }
};

/**
 * The owner's yes on a parked payment: the account (and direction) they chose are stored with the
 * reading, the request goes back to `received`, and the processing job is handed the request once
 * this transaction commits. The job logs the payment on the chosen account; nothing is guessed.
 *
 * It does not wait for the job: it runs inside the card's approval transaction, where the job could
 * not see the change yet. A payment that parks again (no rate, say) gets a new card.
 */
export const approveParkedRequest = withTransaction(
  async ({
    userId,
    requestId,
    accountId,
    direction,
  }: {
    userId: number;
    requestId: RecordId;
    accountId?: RecordId;
    direction?: 'debit' | 'credit';
  }): Promise<{ requestId: RecordId; queued: true }> => {
    const row = await IngestRequests.findOne({
      where: { id: requestId, userId, pipeline: 'notification' },
      lock: true,
    });
    if (!row) throw new NotFoundError({ message: t({ key: 'ingest.requestNotFound' }) });

    if (!isWaitingRequest({ row }) || row.status !== 'parked' || !APPROVABLE_REASONS.includes(row.reason ?? '')) {
      throw new ConflictError({ message: t({ key: 'ingest.requestNotWaiting' }) });
    }

    const stored = readStoredParse({ value: row.parsed });
    if (!stored?.payment) throw new ConflictError({ message: t({ key: 'ingest.requestNotWaiting' }) });

    if (row.reason === 'unknownAccount' && !accountId) {
      throw new ValidationError({ message: t({ key: 'ingest.accountRequired' }) });
    }
    if (accountId) await assertUsableAccount({ userId, accountId });

    await row.update({
      parsed: {
        ...stored,
        ...(accountId && { accountOverrideId: accountId }),
        ...(direction && { directionOverride: direction }),
      } as unknown as Record<string, unknown>,
    });

    const prepared = await prepareNotificationRetry({
      requestId,
      force: true,
      locale: await readUserLocale({ userId }),
    });
    if (prepared.kind === 'conflict') throw new ConflictError({ message: prepared.result.message });

    await runAfterCommit({
      fn: async () => {
        try {
          await enqueueNotificationProcessing({ requestId });
        } catch (error) {
          logger.error({ message: `Failed to queue the approved request ${requestId}`, error: error as Error });
        }
      },
    });

    return { requestId, queued: true };
  },
);
