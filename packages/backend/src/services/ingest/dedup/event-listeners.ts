import { logger } from '@js/utils/logger';
import { DOMAIN_EVENTS, type TransactionsSyncedPayload, eventBus } from '@services/common/event-bus';

import { enqueueDuplicateScan } from './duplicate-scan-queue';

const handleTransactionsSynced = ({ userId, transactionIds }: TransactionsSyncedPayload): void => {
  enqueueDuplicateScan({ userId, transactionIds }).catch((error: unknown) => {
    logger.error({
      message: 'Failed to queue the duplicate scan of synced transactions',
      error: error instanceof Error ? error : new Error(String(error)),
    });
  });
};

/**
 * Queues the duplicate scan after every bank sync: a synced row next to an ingest plan the bank has
 * not settled may record the same payment.
 */
export function registerDuplicateScanListeners(): void {
  eventBus.on(DOMAIN_EVENTS.TRANSACTIONS_SYNCED, handleTransactionsSynced);
  logger.info('Duplicate scan event listeners registered');
}
