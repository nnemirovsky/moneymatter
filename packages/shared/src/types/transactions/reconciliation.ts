import type { DuplicateSuggestionTrigger } from '../ingest';
import { RecordId } from '../record-id';
import type { TransactionModel } from './transactions';

export const RECONCILIATION_MERGE_MIN = 2;
export const RECONCILIATION_MERGE_MAX = 4;
export const RECONCILIATION_REMOVE_MAX = 500;

export interface ReconciliationRemoveBody {
  transactionIds: RecordId[];
}

export interface ReconciliationMergeBody {
  transactionIds: RecordId[];
  survivorId: RecordId;
}

export interface ReconciliationActionResponse {
  removedIds: RecordId[];
}

export interface ReconciliationRestoreBody {
  transactionIds: RecordId[];
}

export interface ReconciliationRestoreResponse {
  restoredIds: RecordId[];
}

export type ReconciliationHistoryEvent = {
  removedAt: string;
  transactions: TransactionModel[];
} & ({ type: 'merge'; survivor: TransactionModel } | { type: 'remove'; survivor: null });

export interface StuckPendingItem {
  transaction: TransactionModel;
  candidate: TransactionModel | null;
  canCheckWithBank: boolean;
  pendingDays: number;
}

export interface CheckStuckPendingBody {
  accountId: RecordId;
}

export interface CheckStuckPendingResponse {
  bookedCount: number;
  pendingCount: number;
}

export interface KeepAsBookedBody {
  transactionIds: RecordId[];
}

export interface KeepAsBookedResponse {
  updatedIds: RecordId[];
}

/**
 * An open duplicate suggestion: two transactions the AI judge thinks record one payment. Nothing is
 * merged; the user merges the pair through Reconciliation or dismisses it. `transactionSlots` and
 * `candidateSlots` are the ingest sources each side holds (`tap`, `wallet-notification`,
 * `bank:<sourceKey>:<stage>`), empty for a row entered by hand or synced.
 */
export interface DuplicateSuggestionItem {
  id: RecordId;
  accountId: RecordId;
  /** The judge's confidence, 0.6 to 1. */
  confidence: number;
  reason: string | null;
  trigger: DuplicateSuggestionTrigger;
  createdAt: string;
  transaction: TransactionModel;
  candidate: TransactionModel;
  transactionSlots: string[];
  candidateSlots: string[];
}
