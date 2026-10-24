import { TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import { findTransactions } from '@models/transactions-query';
import { Op } from 'sequelize';

/** How many past exchanges between the two accounts are read. */
const HISTORY_LIMIT = 10;
/** How many of the latest rates the usual rate is taken from. */
const USUAL_RATE_SAMPLE = 5;

/** The exchange rate may differ this much (as a share of the usual one) before the card says so. */
export const RATE_DEVIATION_LIMIT = 0.05;

/** A transfer the owner already has between the same two accounts, in the same direction. */
export interface PastConversion {
  /** Units received per unit sent. */
  rate: number;
  note: string | null;
  time: Date;
}

/**
 * The owner's latest transfers from `fromAccountId` to `toAccountId`, newest first: the newest incoming legs on the
 * destination account that were linked to an outgoing leg on the source account.
 */
export const findPastConversions = async ({
  userId,
  fromAccountId,
  toAccountId,
}: {
  userId: number;
  fromAccountId: RecordId;
  toAccountId: RecordId;
}): Promise<PastConversion[]> => {
  const incomes = await findTransactions({
    planned: 'exclude',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: { page: { offset: 0, limit: HISTORY_LIMIT * 5 } },
    order: [['time', 'DESC']],
    where: {
      accountId: toAccountId,
      transactionType: TRANSACTION_TYPES.income,
      transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer,
    },
  });
  const transferIds = incomes.flatMap((row) => (row.transferId ? [row.transferId] : []));
  if (!transferIds.length) return [];

  const expenses = await findTransactions({
    planned: 'exclude',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: 'all',
    where: {
      accountId: fromAccountId,
      transactionType: TRANSACTION_TYPES.expense,
      transferId: { [Op.in]: transferIds },
    },
  });
  const incomeOf = new Map(incomes.map((row) => [row.transferId, row]));

  return expenses
    .flatMap((expense) => {
      const income = incomeOf.get(expense.transferId);
      const sent = expense.amount.toNumber();
      if (!income || sent <= 0) return [];

      return [{ rate: income.amount.toNumber() / sent, note: expense.note?.trim() || null, time: expense.time }];
    })
    .toSorted((a, b) => b.time.getTime() - a.time.getTime())
    .slice(0, HISTORY_LIMIT);
};

/** The rate the owner usually got: the median of the latest few, or null with no history. */
export const usualRate = ({ history }: { history: readonly PastConversion[] }): number | null => {
  const rates = history
    .slice(0, USUAL_RATE_SAMPLE)
    .map((past) => past.rate)
    .toSorted((a, b) => a - b);
  if (!rates.length) return null;

  const middle = Math.floor(rates.length / 2);

  return rates.length % 2 ? rates[middle]! : (rates[middle - 1]! + rates[middle]!) / 2;
};

/** Whether `rate` is far from `usual` (a share of `usual`). */
export const isUnusualRate = ({ rate, usual }: { rate: number; usual: number }): boolean =>
  usual > 0 && Math.abs(rate - usual) / usual > RATE_DEVIATION_LIMIT;

/** The note the owner wrote on the latest exchange between the two accounts, to reuse on the next. */
export const usualNote = ({ history }: { history: readonly PastConversion[] }): string | null =>
  history.find((past) => past.note)?.note ?? null;
