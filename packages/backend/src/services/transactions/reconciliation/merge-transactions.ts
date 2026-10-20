import { type ReconciliationActionResponse, RecordId, SUBSCRIPTION_LINK_STATUS } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';
import SubscriptionPeriods from '@models/subscription-periods.model';
import SubscriptionTransactions from '@models/subscription-transactions.model';
import TrackerTransactions from '@models/tracker-transactions.model';
import TransactionGroupItems from '@models/transaction-group-items.model';
import { updateTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import { getUserDefaultCategory } from '@models/users.model';
import type { EditMergeSkipReason } from '@services/bank-data-providers/enablebanking/utils/plan-edit-merge';
import {
  hasSettledStatus,
  isPreBookingRow,
} from '@services/bank-data-providers/enablebanking/utils/transaction-metadata';
import { settleTransactionCards } from '@services/chat/inbox/inbox-resolution';
import { withTransaction } from '@services/common/with-transaction';
import { Op } from 'sequelize';

import { markSuggestionMerged, markSuggestionsStale } from './duplicate-suggestions';
import { type EditMergeRow, planReconciliationEditMerge } from './edit-merge';
import { detachLinks, loadReconcilableRows, softDeleteTransactions } from './helpers';

const EDIT_CONFLICT_KEYS: Record<EditMergeSkipReason, string> = {
  note_conflict: 'note',
  category_conflict: 'category',
  legacy_category_conflict: 'legacyCategory',
  payment_type_conflict: 'paymentType',
  payee_conflict: 'payee',
};

const toEditMergeRow = ({ row }: { row: Transactions }): EditMergeRow => ({
  note: row.note ?? null,
  categoryId: row.categoryId,
  paymentType: row.paymentType,
  payeeId: row.payeeId,
  payeeLocked: row.payeeLocked,
  categorizationMeta: row.categorizationMeta,
  externalData: row.externalData as Record<string, unknown> | null,
});

/**
 * The edits of the removed rows that move onto the survivor, folded in order so a second row sees
 * what the first one already moved. A real edit on both sides that disagrees rejects the merge with
 * its reason: there is no winner to pick, and the removed row's value would be lost.
 */
const planSurvivorEdits = async ({
  userId,
  removed,
  survivor,
}: {
  userId: number;
  removed: Transactions[];
  survivor: Transactions;
}) => {
  const defaultCategoryId = await getUserDefaultCategory({ id: userId });
  const now = new Date();
  let survivorRow = toEditMergeRow({ row: survivor });
  const valuesToMove: Partial<EditMergeRow> = {};

  for (const row of removed) {
    const plan = planReconciliationEditMerge({
      removed: toEditMergeRow({ row }),
      survivor: survivorRow,
      defaultCategoryId,
      now,
    });
    if (plan.action === 'skip') {
      throw new ValidationError({
        message: t({ key: `transactions.reconciliation.editConflict.${EDIT_CONFLICT_KEYS[plan.reason]}` }),
        details: { transactionIds: [row.id, survivor.id], reason: plan.reason },
      });
    }
    Object.assign(valuesToMove, plan.valuesToMove);
    survivorRow = { ...survivorRow, ...plan.valuesToMove };
  }

  return valuesToMove;
};

/**
 * Targets the removed rows' links move onto the survivor. Rejects with `key` when the survivor
 * already links elsewhere, or a single-valued link would receive several targets.
 */
const planOrReject = ({
  links,
  survivorId,
  single,
  key,
}: {
  links: { transactionId: RecordId; target: RecordId }[];
  survivorId: RecordId;
  single: boolean;
  key: string;
}): RecordId[] => {
  const survivorTargets = new Set(links.filter((l) => l.transactionId === survivorId).map((l) => l.target));
  const toMove = [...new Set(links.filter((l) => l.transactionId !== survivorId).map((l) => l.target))].filter(
    (target) => !survivorTargets.has(target),
  );

  if (toMove.length === 0) return [];
  if (survivorTargets.size > 0 || (single && toMove.length > 1)) {
    throw new ValidationError({ message: t({ key }) });
  }
  return toMove;
};

export const mergeTransactions = withTransaction(
  async ({
    userId,
    transactionIds,
    survivorId,
  }: {
    userId: number;
    transactionIds: RecordId[];
    survivorId: RecordId;
  }): Promise<ReconciliationActionResponse> => {
    if (!transactionIds.includes(survivorId)) {
      throw new ValidationError({ message: t({ key: 'transactions.reconciliation.survivorNotSelected' }) });
    }

    const rows = await loadReconcilableRows({ userId, transactionIds });

    if (new Set(rows.map((row) => row.accountId)).size > 1) {
      throw new ValidationError({ message: t({ key: 'transactions.reconciliation.differentAccounts' }) });
    }

    // Sync never upgrades a pending survivor while its soft-deleted booked twin holds the bank entry.
    const survivor = rows.find((row) => row.id === survivorId)!;
    if (
      isPreBookingRow({ tx: survivor }) &&
      rows.some((row) => row.id !== survivorId && hasSettledStatus({ tx: row }))
    ) {
      throw new ValidationError({ message: t({ key: 'transactions.reconciliation.survivorPending' }) });
    }

    // A plan only describes a payment the booked row already records, so it cannot be the one kept.
    if (survivor.isPlanned && rows.some((row) => row.id !== survivorId && !row.isPlanned)) {
      throw new ValidationError({ message: t({ key: 'transactions.reconciliation.plannedSurvivor' }) });
    }

    const removedRows = rows.filter((row) => row.id !== survivorId);
    const survivorEdits = await planSurvivorEdits({ userId, removed: removedRows, survivor });

    const where = { transactionId: { [Op.in]: transactionIds } };
    const [trackerLinks, groupLinks, subscriptionLinks, periodLinks] = await Promise.all([
      TrackerTransactions.findAll({ where }),
      TransactionGroupItems.findAll({ where }),
      SubscriptionTransactions.findAll({ where: { ...where, status: SUBSCRIPTION_LINK_STATUS.active } }),
      SubscriptionPeriods.findAll({ where, attributes: ['id', 'transactionId'] }),
    ]);

    const trackersToMove = planOrReject({
      links: trackerLinks.map((l) => ({ transactionId: l.transactionId, target: l.trackerId })),
      survivorId,
      single: false,
      key: 'transactions.reconciliation.budgetConflict',
    });
    const groupsToMove = planOrReject({
      links: groupLinks.map((l) => ({ transactionId: l.transactionId, target: l.groupId })),
      survivorId,
      single: true,
      key: 'transactions.reconciliation.groupConflict',
    });
    const subscriptionsToMove = planOrReject({
      links: subscriptionLinks.map((l) => ({ transactionId: l.transactionId, target: l.subscriptionId })),
      survivorId,
      single: true,
      key: 'transactions.reconciliation.subscriptionConflict',
    });
    const periodsToMove = planOrReject({
      links: periodLinks.map((l) => ({ transactionId: l.transactionId!, target: l.id })),
      survivorId,
      single: true,
      key: 'transactions.reconciliation.subscriptionConflict',
    });

    if (trackersToMove.length) {
      await TrackerTransactions.bulkCreate(
        trackersToMove.map((trackerId) => ({
          trackerId,
          transactionId: survivorId,
          metadata: trackerLinks.find((l) => l.trackerId === trackerId)!.metadata,
        })),
      );
    }
    if (groupsToMove.length) {
      await TransactionGroupItems.create({ groupId: groupsToMove[0]!, transactionId: survivorId });
    }
    if (subscriptionsToMove.length) {
      const subscriptionId = subscriptionsToMove[0]!;
      const link = subscriptionLinks.find((l) => l.subscriptionId === subscriptionId)!;
      // The survivor may hold an `unlinked` row for this subscription; the composite PK allows only one.
      await SubscriptionTransactions.destroy({ where: { subscriptionId, transactionId: survivorId } });
      await SubscriptionTransactions.create({
        subscriptionId,
        transactionId: survivorId,
        matchSource: link.matchSource,
        matchedAt: link.matchedAt,
      });
    }
    if (periodsToMove.length) {
      // The survivor was not generated for this period, so revert must not delete it.
      await SubscriptionPeriods.update(
        { transactionId: survivorId, transactionAutoCreated: false },
        { where: { id: periodsToMove[0]! } },
      );
    }

    const removedIds = transactionIds.filter((id) => id !== survivorId);
    // Hooks stay off like the rest of the merge: none of the moved fields is balance-relevant.
    if (Object.keys(survivorEdits).length > 0) {
      await updateTransactions({
        values: survivorEdits,
        where: { id: survivorId },
        planned: 'include',
        access: { creator: userId },
        balanceAdjustments: 'include',
      });
    }
    await detachLinks({ transactionIds: removedIds });
    await softDeleteTransactions({ userId, rows: removedRows, mergedIntoId: survivorId });

    // The pair the owner just merged is done; a suggestion that pairs a removed row with some other
    // row has lost its row and goes stale. The survivor's other suggestions stay open.
    await markSuggestionMerged({ userId, transactionIds });
    await markSuggestionsStale({ transactionIds: removedIds });

    // The owner merged these payments: a confirm card about any of them is answered, and the survivor
    // stops being unconfirmed. A removed row's card must not outlive the row.
    await settleTransactionCards({ transactionIds, markConfirmed: true });

    return { removedIds };
  },
);
