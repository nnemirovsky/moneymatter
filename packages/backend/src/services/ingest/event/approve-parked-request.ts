import type { RecordId } from '@bt/shared/types';
import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import { t } from '@i18n/index';
import { ConflictError, ValidationError } from '@js/errors';
import { logger } from '@js/utils/logger';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';

import { isWaitingRequest } from '../card-payment/process-ingest-request';
import { readUserLocale } from '../card-payment/read-user-locale';
import { assertUsableAccount } from '../usable-account';
import { learnAccountChoice, type AccountLesson } from './learn-account-choice';
import { enqueueNotificationProcessing } from './notification-queue';
import { prepareNotificationRetry } from './prepare-notification-retry';
import { readStoredParse } from './stored-parse';
import { rerunWaitingSiblings, siblingMatchOf } from './waiting-siblings';

/** The park reasons whose payment the owner can log from the inbox card. */
const APPROVABLE_REASONS = ['unknownAccount', 'ownTransfer', 'lowConfidence', 'unverifiedParse'];

/**
 * The owner's yes on a parked payment: the account (and direction) they chose are stored with the
 * reading, the request goes back to `received`, and the processing job is handed the request once
 * this transaction commits. The job logs the payment on the chosen account; nothing is guessed.
 *
 * An approval on an account also teaches the server (`learnAccountChoice`): a card link for the card
 * the payment names, else the source's default account.
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
    note,
  }: {
    userId: number;
    requestId: RecordId;
    accountId?: RecordId;
    direction?: 'debit' | 'credit';
    /** The note the owner wrote on the card; `''` logs the payment without one. */
    note?: string;
  }): Promise<{ requestId: RecordId; queued: true; learned: AccountLesson; alsoQueued: number }> => {
    const row = await findOrThrowNotFound({
      query: IngestRequests.findOne({ where: { id: requestId, userId, pipeline: 'notification' }, lock: true }),
      message: t({ key: 'ingest.requestNotFound' }),
    });

    if (!isWaitingRequest({ row }) || row.status !== 'parked' || !APPROVABLE_REASONS.includes(row.reason ?? '')) {
      throw new ConflictError({ message: t({ key: 'ingest.requestNotWaiting' }) });
    }

    const stored = readStoredParse({ value: row.parsed });
    if (!stored?.payment) throw new ConflictError({ message: t({ key: 'ingest.requestNotWaiting' }) });

    if (row.reason === 'unknownAccount' && !accountId) {
      throw new ValidationError({ message: t({ key: 'ingest.accountRequired' }) });
    }
    if (accountId) {
      await assertUsableAccount({
        userId,
        accountId,
        message: t({ key: 'accounts.accountNotFoundForTransaction' }),
      });
    }

    // The owner's yes on an account is remembered, so the next payment of this card or source needs no question.
    const source = row.sourceId ? await NotificationSources.findOne({ where: { id: row.sourceId, userId } }) : null;
    const learned =
      row.reason === 'unknownAccount' && accountId
        ? await learnAccountChoice({ userId, accountId, payment: stored.payment, source, payload: row.payload })
        : null;

    // Every other waiting payment the same card or source resolves goes through the pipeline now, each with
    // its own confirm card; nothing is confirmed on the owner's behalf.
    const match = learned ? siblingMatchOf({ payment: stored.payment, sourceId: row.sourceId }) : null;
    const alsoQueued = match ? await rerunWaitingSiblings({ userId, match, excludeRequestId: requestId }) : 0;

    await row.update({
      parsed: {
        ...stored,
        ...(accountId && { accountOverrideId: accountId }),
        ...(direction && { directionOverride: direction }),
        ...(note !== undefined && { noteOverride: note }),
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

    return { requestId, queued: true, learned, alsoQueued };
  },
);
