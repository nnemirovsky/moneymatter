import { TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { findOneTransaction } from '@models/transactions-query';
import { insertDuplicateSuggestions } from '@services/transactions/reconciliation/duplicate-suggestions';

import { readUserLocale } from '../card-payment/read-user-locale';
import { findJudgeCandidates } from './find-judge-candidates';
import { judgeDuplicates } from './judge-duplicates';
import { selectSuggestions } from './judge-prompt';

/**
 * Tier 2 of the dedup: asks the AI judge whether a payment that was just logged records the same
 * payment as a row already on its account, and stores every match at 0.6 or more as an open
 * suggestion. It never merges, attaches or deletes anything: the owner decides in Reconciliation.
 *
 * It runs after the logging transaction committed and outside the dedup lock, like AI
 * categorization, so a slow or failing judge cannot hold up or undo the payment. Any failure is
 * logged and leaves the row as it was logged. Returns the number of suggestions created.
 */
export const judgeAfterCommit = async ({
  userId,
  transactionId,
}: {
  userId: number;
  transactionId: RecordId;
}): Promise<number> => {
  try {
    const transaction = await findOneTransaction({
      where: { id: transactionId },
      planned: 'include',
      access: { accountOwner: userId },
      balanceAdjustments: 'exclude',
    });
    if (
      !transaction ||
      (transaction.transactionType !== TRANSACTION_TYPES.expense &&
        transaction.transactionType !== TRANSACTION_TYPES.income)
    ) {
      return 0;
    }

    const found = await findJudgeCandidates({ userId, transaction });
    if (!found) return 0;

    const matches = await judgeDuplicates({
      userId,
      payment: found.payment,
      candidates: found.candidates,
      locale: await readUserLocale({ userId }),
    });

    const created = await insertDuplicateSuggestions({
      userId,
      accountId: transaction.accountId,
      trigger: 'ingest',
      suggestions: selectSuggestions({ matches }).map((match) => ({
        transactionId,
        candidateId: match.candidateId,
        confidence: match.confidence,
        reason: match.reason,
      })),
    });

    return created.length;
  } catch (error) {
    logger.error({
      message: 'Failed to judge a logged payment for duplicates; the payment stays as logged',
      error: error as Error,
    });

    return 0;
  }
};
