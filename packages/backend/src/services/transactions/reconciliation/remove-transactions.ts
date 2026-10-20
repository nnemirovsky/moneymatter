import type { ReconciliationActionResponse, RecordId } from '@bt/shared/types';
import { settleTransactionCards } from '@services/chat/inbox/inbox-resolution';
import { withTransaction } from '@services/common/with-transaction';

import { markSuggestionsStale } from './duplicate-suggestions';
import { detachLinks, loadReconcilableRows, softDeleteTransactions } from './helpers';

export const removeTransactions = withTransaction(
  async ({
    userId,
    transactionIds,
  }: {
    userId: number;
    transactionIds: RecordId[];
  }): Promise<ReconciliationActionResponse> => {
    const rows = await loadReconcilableRows({ userId, transactionIds });
    const removedIds = rows.map((row) => row.id);

    await detachLinks({ transactionIds: removedIds });
    await softDeleteTransactions({ userId, rows, mergedIntoId: null });
    await markSuggestionsStale({ transactionIds: removedIds });
    await settleTransactionCards({ transactionIds: removedIds, markConfirmed: true });

    return { removedIds };
  },
);
