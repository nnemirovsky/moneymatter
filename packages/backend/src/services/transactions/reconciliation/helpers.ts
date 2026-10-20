import { isIngestPlan, isLinkedTransfer, ACCOUNT_TYPES, RecordId, SUBSCRIPTION_LINK_STATUS } from '@bt/shared/types';
import { t } from '@i18n/index';
import { NotFoundError, ValidationError } from '@js/errors';
import Balances from '@models/balances.model';
import SubscriptionPeriods from '@models/subscription-periods.model';
import SubscriptionTransactions from '@models/subscription-transactions.model';
import TrackerTransactions from '@models/tracker-transactions.model';
import TransactionGroupItems from '@models/transaction-group-items.model';
import { dissolveUndersizedGroups } from '@models/transaction-groups.model';
import { findTransactions, updateTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import { updateAccountBalanceForChangedTx } from '@services/accounts/update-balance-for-changed-tx';
import { literal, Op } from 'sequelize';

export const rejectIfAny = ({ rows, key }: { rows: Transactions[]; key: string }) => {
  if (rows.length === 0) return;
  throw new ValidationError({ message: t({ key }), details: { transactionIds: rows.map((row) => row.id) } });
};

export const loadReconcilableRows = async ({
  userId,
  transactionIds,
}: {
  userId: number;
  transactionIds: RecordId[];
}): Promise<Transactions[]> => {
  // Row lock serializes concurrent merges of the same rows; the loser re-reads them as deleted and 404s.
  const rows = await findTransactions({
    where: { id: { [Op.in]: transactionIds } },
    planned: 'include',
    access: { creator: userId },
    balanceAdjustments: 'include',
    completeness: 'all',
    lock: true,
  });

  if (rows.length !== transactionIds.length) {
    throw new NotFoundError({ message: t({ key: 'transactions.notFound' }) });
  }

  // A plan an ingest pipeline wrote is a copy of a payment the bank has yet to report; only the
  // owner's own plans are real intent that reconciliation must not touch.
  rejectIfAny({
    rows: rows.filter((row) => row.isPlanned && !isIngestPlan({ tx: row })),
    key: 'transactions.reconciliation.plannedNotAllowed',
  });
  rejectIfAny({
    rows: rows.filter((tx) => isLinkedTransfer({ tx })),
    key: 'transactions.reconciliation.transferNotAllowed',
  });
  rejectIfAny({ rows: rows.filter((row) => row.refundLinked), key: 'transactions.reconciliation.refundNotAllowed' });

  return rows;
};

export const detachLinks = async ({ transactionIds }: { transactionIds: RecordId[] }) => {
  const where = { transactionId: { [Op.in]: transactionIds } };

  const groupItems = await TransactionGroupItems.findAll({ where, attributes: ['groupId'] });

  await Promise.all([
    TrackerTransactions.destroy({ where }),
    TransactionGroupItems.destroy({ where }),
    // `unlinked` markers stay so a restored row is not auto-matched back to a subscription the user unlinked.
    SubscriptionTransactions.destroy({ where: { ...where, status: SUBSCRIPTION_LINK_STATUS.active } }),
    SubscriptionPeriods.update({ transactionId: null, transactionAutoCreated: false }, { where }),
  ]);

  await dissolveUndersizedGroups({ groupIds: [...new Set(groupItems.map((item) => item.groupId))] });
};

const isManualAccountRow = ({ row }: { row: Transactions }) =>
  row.accountType === ACCOUNT_TYPES.system && !row.isPlanned;

/**
 * Marks a hidden row whose amount left a manual balance. The account type of a row follows its
 * account (an unlink retypes hidden rows too), so on restore only this marker says whether the
 * amount was ever withdrawn: a row hidden on a bank account was not, and its amount is still in
 * whatever balance the account holds.
 */
const BALANCE_WITHDRAWN_PATH = '{reconciliation,balanceWithdrawn}';

/**
 * Hides rows from the books (soft delete) with the Transaction hooks off.
 *
 * - A bank row moves no balance: provider balances are bank-authoritative, so the bank's figure
 *   already stands whichever copy is hidden.
 * - A row of a manual (system) account is the ledger: its balance is the sum of its rows. Hiding one
 *   withdraws its amount exactly as `@BeforeDestroy` does (account balance and `Balances`) and marks
 *   the row, and `reapplyBalances` puts the amount back.
 * - A planned row (an ingest plan on a bank account) never moved a balance, so there is nothing to
 *   take back.
 */
export const softDeleteTransactions = async ({
  userId,
  rows,
  mergedIntoId,
}: {
  userId: number;
  rows: Transactions[];
  mergedIntoId: RecordId | null;
}) => {
  await updateTransactions({
    values: { deletedAt: new Date(), mergedIntoId },
    where: { id: { [Op.in]: rows.map((row) => row.id) } },
    planned: 'include',
    access: { creator: userId },
    balanceAdjustments: 'include',
  });

  const withdrawn = rows.filter((candidate) => isManualAccountRow({ row: candidate }));
  if (!withdrawn.length) return;

  await updateTransactions({
    values: {
      externalData: literal(
        `COALESCE("externalData", '{}'::jsonb) || jsonb_build_object('reconciliation', COALESCE("externalData"->'reconciliation', '{}'::jsonb) || '{"balanceWithdrawn": true}'::jsonb)`,
      ),
    },
    where: { id: { [Op.in]: withdrawn.map((row) => row.id) } },
    paranoid: false,
    planned: 'include',
    access: { creator: userId },
    balanceAdjustments: 'include',
  });

  for (const row of withdrawn) {
    await updateAccountBalanceForChangedTx({
      accountId: row.accountId,
      prevAmount: row.amount,
      transactionType: row.transactionType,
      removedTransactionId: row.id,
    });
    await Balances.handleTransactionChange({ data: row, isDelete: true });
  }
};

/**
 * Puts back the amounts `softDeleteTransactions` withdrew, as `@AfterCreate` does, for the restored
 * rows that carry the marker and still sit on a manual account. A row whose account was linked to a
 * bank in the meantime stays out of the balance, which is now the bank's figure.
 */
export const reapplyBalances = async ({ userId, rows }: { userId: number; rows: Transactions[] }) => {
  const marked = rows.filter((row) =>
    Boolean(
      (row.externalData as { reconciliation?: { balanceWithdrawn?: unknown } } | null)?.reconciliation
        ?.balanceWithdrawn,
    ),
  );
  if (!marked.length) return;

  await updateTransactions({
    values: { externalData: literal(`"externalData" #- '${BALANCE_WITHDRAWN_PATH}'`) },
    where: { id: { [Op.in]: marked.map((row) => row.id) } },
    planned: 'include',
    access: { creator: userId },
    balanceAdjustments: 'include',
  });

  for (const row of marked.filter((candidate) => isManualAccountRow({ row: candidate }))) {
    await updateAccountBalanceForChangedTx({
      accountId: row.accountId,
      amount: row.amount,
      transactionType: row.transactionType,
    });
    await Balances.handleTransactionChange({ data: row });
  }
};
