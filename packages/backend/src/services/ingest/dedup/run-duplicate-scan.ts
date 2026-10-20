import { isIngestTransaction, isLinkedTransfer, TRANSACTION_TYPES } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { findTransactions } from '@models/transactions-query';
import { postDuplicateSuggestionCards, safely } from '@services/chat/inbox/inbox-items';
import {
  insertDuplicateSuggestions,
  sweepOrphanedSuggestions,
} from '@services/transactions/reconciliation/duplicate-suggestions';
import { Op } from 'sequelize';

import { readUserLocale } from '../card-payment/read-user-locale';
import { dedupConfig } from './constants';
import { findJudgeCandidates } from './find-judge-candidates';
import { judgeDuplicates } from './judge-duplicates';
import { selectSuggestions } from './judge-prompt';

/**
 * The duplicate scan that follows a bank sync or a statement import: puts the new rows to the same
 * AI judge as the live pipeline and stores every match at 0.6 or more as an open suggestion
 * (trigger `scan`). It never merges, attaches or deletes anything.
 *
 * - A synced or imported row is only paired with an ingest row (a plan the bank has not settled, or a
 *   booked payment the pipeline logged). Two hand-typed or two synced rows are not this feature's
 *   business, and asking the judge about them would spend the daily AI budget on nothing.
 * - The newest `dedupConfig.scanMaxRows` rows are judged. A pair that already has a suggestion in any
 *   state is not asked again, so a dismissed pair is never raised twice and a retried job repeats
 *   nothing.
 * - Suggestions whose transaction disappeared by a path that did not mark them are swept to `stale`
 *   first.
 * - A failed judge call throws, so the queue retries the job; what was stored stays.
 *
 * Returns the number of suggestions created.
 */
export const runDuplicateScan = async ({
  userId,
  transactionIds,
}: {
  userId: number;
  transactionIds: readonly string[];
}): Promise<number> => {
  await sweepOrphanedSuggestions({ userId });
  if (!transactionIds.length) return 0;

  const rows = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    transfers: 'exclude',
    completeness: { cap: { limit: dedupConfig.scanMaxRows, onTruncated: 'log', context: { userId } } },
    where: {
      id: { [Op.in]: [...transactionIds] },
      transactionType: { [Op.in]: [TRANSACTION_TYPES.expense, TRANSACTION_TYPES.income] },
    },
    order: [['time', 'DESC']],
  });
  const subjects = rows.filter((row) => !isLinkedTransfer({ tx: row }));
  if (!subjects.length) return 0;

  const locale = await readUserLocale({ userId });
  let created = 0;

  for (const transaction of subjects) {
    const found = await findJudgeCandidates({
      userId,
      transaction,
      poolFilter: isIngestTransaction({ externalData: transaction.externalData })
        ? undefined
        : (row) => isIngestTransaction({ externalData: row.externalData }),
    });
    if (!found) continue;

    const matches = await judgeDuplicates({ userId, payment: found.payment, candidates: found.candidates, locale });
    const inserted = await insertDuplicateSuggestions({
      userId,
      accountId: transaction.accountId,
      trigger: 'scan',
      suggestions: selectSuggestions({ matches }).map((match) => ({
        transactionId: transaction.id,
        candidateId: match.candidateId,
        confidence: match.confidence,
        reason: match.reason,
      })),
    });
    created += inserted.length;
    await safely({
      what: 'post the duplicate suggestion cards',
      fn: () => postDuplicateSuggestionCards({ userId, suggestions: inserted }),
    });
  }

  if (created > 0) logger.info(`[Duplicate scan] ${created} suggestion(s) raised for user ${userId}`);

  return created;
};
