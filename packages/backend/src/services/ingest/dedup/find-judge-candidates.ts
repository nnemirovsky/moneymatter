import { TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import type { Money } from '@common/types/money';
import DuplicateSuggestions from '@models/duplicate-suggestions.model';
import { findTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import { loadPlanNames } from '@services/transactions/planned-matching/find-planned-match';
import { Op } from 'sequelize';

import { dedupConfig } from './constants';
import type { JudgeCandidateRow } from './judge-duplicates';
import { readTakenSlots } from './source-slots';
import { figuresOfRow, sharesFigure, type Figure } from './twin-rule';

/** Rows read per lookup; an account holds a handful of rows inside the judge window. */
const POOL_LIMIT = 200;

/** A row of the account, reduced to what the candidate rule reads. */
export interface JudgePoolRow {
  id: RecordId;
  time: Date;
  figures: readonly Figure[];
  slots: readonly string[];
}

const largerOf = ({ a, b }: { a: Money; b: Money }) => (a.gte(b) ? a : b);

/** Whether two amounts in one currency are within `dedupConfig.judgeAmountTolerance` of each other. */
const isNearAmount = ({ left, right }: { left: Money; right: Money }): boolean =>
  left
    .subtract(right)
    .abs()
    .lte(largerOf({ a: left, b: right }).multiply(dedupConfig.judgeAmountTolerance));

const hasNearFigure = ({ left, right }: { left: readonly Figure[]; right: readonly Figure[] }): boolean =>
  left.some((a) =>
    right.some(
      (b) =>
        a.currencyCode === b.currencyCode &&
        a.amount.isPositive() &&
        b.amount.isPositive() &&
        isNearAmount({ left: a.amount, right: b.amount }),
    ),
  );

/**
 * The rows worth putting to the judge for a new row, best first and capped at
 * `dedupConfig.judgeMaxCandidates`. A row qualifies when:
 *
 * - it is within `judgeWindowMs` of the new row, either way;
 * - it states a near amount (within `judgeAmountTolerance`) or the same charged amount;
 * - it does not hold a source slot the new row also holds, because a row is one request per slot: two
 *   rows that both came from the tap (or both from Wallet) are two payments, like two coffees. The one
 *   exception is a double fire, rows closer than `judgeSameSlotWindowMs`;
 * - it is not in `excludeIds` (a pair the judge already ruled on).
 *
 * Exact amounts come before near ones, then the closest in time.
 */
export const pickJudgeCandidates = ({
  subject,
  pool,
  excludeIds = new Set<string>(),
}: {
  subject: { id: RecordId; time: Date; figures: readonly Figure[]; slots: readonly string[] };
  pool: readonly JudgePoolRow[];
  excludeIds?: ReadonlySet<string>;
}): RecordId[] =>
  pool
    .filter((row) => {
      if (row.id === subject.id || excludeIds.has(row.id)) return false;

      const distance = Math.abs(row.time.getTime() - subject.time.getTime());
      if (distance > dedupConfig.judgeWindowMs) return false;

      const sharesSlot = row.slots.some((slot) => subject.slots.includes(slot));
      if (sharesSlot && distance > dedupConfig.judgeSameSlotWindowMs) return false;

      return (
        sharesFigure({ left: row.figures, right: subject.figures }) ||
        hasNearFigure({ left: row.figures, right: subject.figures })
      );
    })
    .toSorted((a, b) => {
      const exactA = sharesFigure({ left: a.figures, right: subject.figures }) ? 0 : 1;
      const exactB = sharesFigure({ left: b.figures, right: subject.figures }) ? 0 : 1;
      if (exactA !== exactB) return exactA - exactB;

      return Math.abs(a.time.getTime() - subject.time.getTime()) - Math.abs(b.time.getTime() - subject.time.getTime());
    })
    .slice(0, dedupConfig.judgeMaxCandidates)
    .map((row) => row.id);

const figuresOf = ({ row }: { row: Transactions }) =>
  figuresOfRow({
    amount: row.amount,
    currencyCode: row.currencyCode,
    originalAmount: row.originalAmount,
    originalCurrencyCode: row.originalCurrencyCode,
  });

/** The other side of every pair the judge already ruled on for this row, whatever the verdict. */
const loadRuledOnIds = async ({ userId, transactionId }: { userId: number; transactionId: RecordId }) => {
  const rows = await DuplicateSuggestions.findAll({
    where: { userId, [Op.or]: [{ transactionId }, { candidateId: transactionId }] },
    attributes: ['transactionId', 'candidateId'],
  });

  return new Set(
    rows
      .flatMap((row) => [row.transactionId, row.candidateId])
      .filter((id): id is RecordId => !!id && id !== transactionId),
  );
};

const toJudgeSubject = ({ row, names }: { row: Transactions; names: readonly string[] }) => ({
  direction: row.transactionType === TRANSACTION_TYPES.expense ? ('debit' as const) : ('credit' as const),
  amount: row.amount.toNumber(),
  currencyCode: row.currencyCode,
  originalAmount: row.originalAmount ? row.originalAmount.toNumber() : null,
  originalCurrencyCode: row.originalCurrencyCode,
  time: row.time,
  names,
  slots: readTakenSlots({ externalData: row.externalData }),
});

/**
 * The new row and the rows of its own account that may record the same payment, ready for the judge.
 * Only the row's own account and direction are looked at: a payment on another account is another
 * payment. `poolFilter` narrows the rows that may be candidates (the scan only pairs a synced or
 * imported row with an ingest row). Nothing to judge answers `null`.
 */
export const findJudgeCandidates = async ({
  userId,
  transaction,
  poolFilter,
}: {
  userId: number;
  transaction: Transactions;
  poolFilter?: (row: Transactions) => boolean;
}): Promise<{ payment: ReturnType<typeof toJudgeSubject>; candidates: JudgeCandidateRow[] } | null> => {
  const found = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    transfers: 'exclude',
    completeness: { cap: { limit: POOL_LIMIT, onTruncated: 'log', context: { userId } } },
    where: {
      accountId: transaction.accountId,
      transactionType: transaction.transactionType,
      id: { [Op.ne]: transaction.id },
      time: {
        [Op.gte]: new Date(transaction.time.getTime() - dedupConfig.judgeWindowMs),
        [Op.lte]: new Date(transaction.time.getTime() + dedupConfig.judgeWindowMs),
      },
    },
    order: [['time', 'DESC']],
  });
  const rows = poolFilter ? found.filter(poolFilter) : found;
  if (!rows.length) return null;

  const subjectSlots = readTakenSlots({ externalData: transaction.externalData });
  const picked = pickJudgeCandidates({
    subject: {
      id: transaction.id,
      time: transaction.time,
      figures: figuresOf({ row: transaction }),
      slots: subjectSlots,
    },
    pool: rows.map((row) => ({
      id: row.id,
      time: row.time,
      figures: figuresOf({ row }),
      slots: readTakenSlots({ externalData: row.externalData }),
    })),
    excludeIds: await loadRuledOnIds({ userId, transactionId: transaction.id }),
  });
  if (!picked.length) return null;

  const byId = new Map(rows.map((row) => [row.id, row]));
  const chosen = picked.map((id) => byId.get(id)!);
  const names = await loadPlanNames({ plans: [transaction, ...chosen] });

  return {
    payment: toJudgeSubject({ row: transaction, names: names.get(transaction.id) ?? [] }),
    candidates: chosen.map((row) => ({ id: row.id, ...toJudgeSubject({ row, names: names.get(row.id) ?? [] }) })),
  };
};
