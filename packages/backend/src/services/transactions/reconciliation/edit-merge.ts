import { isIngestTransaction, PAYMENT_TYPES } from '@bt/shared/types';
import {
  type EditMergeSide,
  type EditMergeSkipReason,
  planEditMerge,
} from '@services/bank-data-providers/enablebanking/utils/plan-edit-merge';
import { syncGeneratedNote } from '@services/bank-data-providers/enablebanking/utils/transaction-metadata';

type EditMergeValuesToMove = Extract<ReturnType<typeof planEditMerge>, { action: 'merge' }>['valuesToMove'];

/** A reconcilable row as far as the edit-merge policy reads it. */
export interface EditMergeRow extends EditMergeSide {
  externalData: Record<string, unknown> | null;
}

type ReconciliationEditMergePlan =
  | { action: 'merge'; valuesToMove: EditMergeValuesToMove }
  | { action: 'skip'; reason: EditMergeSkipReason };

interface MachineBaseline {
  /** The note the pipeline that wrote the row put there, so an unchanged note is not an edit. */
  note: string | null;
  paymentType: PAYMENT_TYPES;
  /** The unstamped category the pipeline picked, when the row is one a pipeline wrote. */
  categoryId?: string;
}

/**
 * What the pipeline that wrote a row put in its user-editable fields. An ingest row (tap, Wallet or
 * bank notification) wrote `ingest.systemNote`, the `mobilePayment` type and, when no rule or AI
 * stamped it, a category recorded as `ingest.systemCategoryId`. A row logged before those fields
 * existed carries only the `cardPayment` marker: its note was the merchant, and an unstamped
 * category was the pipeline's own pick. Any other row is read as a bank row: its sync note comes
 * from the raw payload (none for a manual or imported row) and the payment type is `bankTransfer`.
 */
const machineBaselineOf = ({ row }: { row: EditMergeRow }): MachineBaseline => {
  if (!isIngestTransaction({ externalData: row.externalData })) {
    return { note: syncGeneratedNote({ tx: row }), paymentType: PAYMENT_TYPES.bankTransfer };
  }

  const ingest = row.externalData?.ingest as { systemNote?: unknown; systemCategoryId?: unknown } | undefined;
  const cardPayment = row.externalData?.cardPayment as { merchant?: unknown } | undefined;
  const systemNote = typeof ingest?.systemNote === 'string' ? ingest.systemNote : null;
  const merchant = typeof cardPayment?.merchant === 'string' ? cardPayment.merchant : null;
  const systemCategoryId = typeof ingest?.systemCategoryId === 'string' ? ingest.systemCategoryId : undefined;

  return {
    note: systemNote ?? merchant,
    paymentType: PAYMENT_TYPES.mobilePayment,
    categoryId: systemCategoryId ?? (row.categorizationMeta ? undefined : row.categoryId),
  };
};

/**
 * Decides which of the removed row's edits move onto the survivor of a reconciliation merge. It
 * wraps `planEditMerge` with each side's machine baseline, so only a real user edit can conflict:
 * two ingest rows with different spellings, history categories or machine notes merge, and the
 * survivor keeps its own values.
 */
export const planReconciliationEditMerge = ({
  removed,
  survivor,
  defaultCategoryId,
  now,
}: {
  removed: EditMergeRow;
  survivor: EditMergeRow;
  defaultCategoryId: string;
  now: Date;
}): ReconciliationEditMergePlan => {
  const orphanBaseline = machineBaselineOf({ row: removed });
  const canonicalBaseline = machineBaselineOf({ row: survivor });

  return planEditMerge({
    orphan: removed,
    canonical: survivor,
    orphanSyncNote: orphanBaseline.note,
    canonicalSyncNote: canonicalBaseline.note,
    orphanMachinePaymentType: orphanBaseline.paymentType,
    canonicalMachinePaymentType: canonicalBaseline.paymentType,
    orphanMachineCategoryId: orphanBaseline.categoryId,
    canonicalMachineCategoryId: canonicalBaseline.categoryId,
    defaultCategoryId,
    now,
  });
};
