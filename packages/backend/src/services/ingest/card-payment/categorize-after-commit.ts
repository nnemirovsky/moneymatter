import { AI_FEATURE, CATEGORIZATION_TRIGGER, type RecordId } from '@bt/shared/types';
import { sleep } from '@common/helpers';
import { logger } from '@js/utils/logger';
import IngestRequests from '@models/ingest-requests.model';
import { findOneTransaction } from '@models/transactions-query';
import { getUserDefaultCategory } from '@models/users.model';
import { resolveAIConfiguration } from '@services/ai';
import { CATEGORIZATION_SCOPE, queueCategorizationJob } from '@services/ai-categorization';

import { buildLoggedSummary } from './build-logged-summary';
import { cardPaymentTimings } from './constants';

interface CategorizedAnswer {
  summary: string;
  categoryPending: boolean;
}

const readCategorization = ({ userId, transactionId }: { userId: number; transactionId: RecordId }) =>
  findOneTransaction({
    where: { id: transactionId },
    planned: 'include',
    access: { creator: userId },
    balanceAdjustments: 'include',
    attributes: ['id', 'categoryId', 'categorizationMeta', 'isPlanned'],
  });

/**
 * Hands a freshly logged payment to the AI categorization queue, after its transaction committed,
 * and waits for the answer only when there is something to wait for.
 *
 * - A job is queued for every row the AI may still decide: not planned (AI skips plans), no
 *   `categorizationMeta` (an `enforce` payee or a rule already decided), and an AI client that
 *   resolves for the owner. A `hint` or history category stays on the row until the AI overrides
 *   it, exactly as for bank rows.
 * - Only a row still in the user's default category waits: the request polls it until the AI has
 *   stamped it or the budget is spent. A row with a category already answers at once with that
 *   category.
 *
 * Returns the answer to use instead of the one tx 2 built, or `null` when that answer stands. The
 * AI is an extra: any failure here is logged and leaves the payment's answer untouched.
 */
export const categorizeAfterCommit = async ({
  userId,
  requestId,
  transactionId,
  locale,
  waitBudgetMs = cardPaymentTimings.aiWaitBudgetMs,
}: {
  userId: number;
  requestId: RecordId;
  transactionId: RecordId;
  locale: string;
  /** How long to wait for the AI's answer; the tap's budget unless the caller shares its wait with other work. */
  waitBudgetMs?: number;
}): Promise<CategorizedAnswer | null> => {
  try {
    const transaction = await readCategorization({ userId, transactionId });
    if (!transaction || transaction.isPlanned || transaction.categorizationMeta) return null;

    const aiConfiguration = await resolveAIConfiguration({ userId, feature: AI_FEATURE.categorization });
    if (!aiConfiguration) return null;

    await queueCategorizationJob({
      userId,
      transactionIds: [transactionId],
      scope: CATEGORIZATION_SCOPE.anyCategory,
      trigger: CATEGORIZATION_TRIGGER.sync,
    });

    if (transaction.categoryId !== (await getUserDefaultCategory({ id: userId }))) return null;

    const deadline = Date.now() + waitBudgetMs;
    while (Date.now() < deadline) {
      await sleep({ ms: Math.min(cardPaymentTimings.aiPollIntervalMs, Math.max(deadline - Date.now(), 0)) });

      const current = await readCategorization({ userId, transactionId });
      if (!current?.categorizationMeta) continue;

      const answered = await buildLoggedSummary({
        userId,
        transactionId,
        duplicate: false,
        categoryPending: false,
        locale,
      });
      if (!answered) return null;

      await IngestRequests.update({ summary: answered.summary }, { where: { id: requestId } });

      return { summary: answered.summary, categoryPending: false };
    }

    const pending = await buildLoggedSummary({
      userId,
      transactionId,
      duplicate: false,
      categoryPending: true,
      locale,
    });

    return pending ? { summary: pending.summary, categoryPending: true } : null;
  } catch (error) {
    logger.error({
      message: 'Failed to hand a card payment to AI categorization; the payment stays as logged',
      error: error as Error,
    });

    return null;
  }
};
