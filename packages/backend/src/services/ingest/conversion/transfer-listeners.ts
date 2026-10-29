import { TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { namespace } from '@models/connection';
import { findTransactions } from '@models/transactions-query';
import { DOMAIN_EVENTS, eventBus, type TransferLoggedPayload } from '@services/common/event-bus';
import { Op } from 'sequelize';

import { withdrawCoveredCorrections } from '../corrections/top-up-covers';
import { settleParkedForTransfer } from './resolve-parked-by-transfer';

/**
 * A transfer logged or linked anywhere (chat, the app, an import) settles what the ingest was waiting on:
 * - the notification that waits for the owner and tells of the same transfer;
 * - the short-balance suggestion of a payment on the account the transfer topped up, if the transfer covers it.
 * Failures are logged; the transfer is already committed.
 */
export const onTransferLogged = async ({
  userId,
  transactionIds,
}: {
  userId: number;
  transactionIds: readonly RecordId[];
}): Promise<void> => {
  await settleParkedForTransfer({ userId, transactionIds });

  try {
    const legs = await findTransactions({
      planned: 'include',
      access: { accountOwner: userId },
      balanceAdjustments: 'exclude',
      completeness: 'all',
      where: { id: { [Op.in]: [...transactionIds] } },
    });
    const income = legs.find((leg) => leg.transactionType === TRANSACTION_TYPES.income);
    if (income) await withdrawCoveredCorrections({ userId, topUp: income });
  } catch (error) {
    logger.error({ message: 'Failed to look at the short-balance suggestions of a transfer', error: error as Error });
  }
};

/**
 * The event is emitted while the transfer's own transaction is committing, and a handler started there would inherit it
 * through the async context: its queries would join a transaction that is ending. The handler runs in a context of its
 * own, with no transaction.
 */
const runWithoutTransaction = <T>({ fn }: { fn: () => Promise<T> }): Promise<T> =>
  namespace.runAndReturn(() => {
    namespace.set('transaction', undefined);

    return fn();
  });

export function registerIngestTransferListeners(): void {
  eventBus.on(DOMAIN_EVENTS.TRANSFER_LOGGED, ({ userId, transactionIds }: TransferLoggedPayload) => {
    void runWithoutTransaction({
      fn: () => onTransferLogged({ userId, transactionIds: transactionIds as RecordId[] }),
    });
  });
  logger.info('Ingest transfer listeners registered');
}
