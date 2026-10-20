import { TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import { findTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import { isSameShop } from '@services/transactions/planned-matching/card-payment-tolerance';
import { loadPlanNames } from '@services/transactions/planned-matching/find-planned-match';
import { Op, literal } from 'sequelize';

import { findCardRows } from '../resolve-card-account';
import { dedupConfig } from './constants';
import { readTakenSlots } from './source-slots';
import { figuresOfRow, pickSettlementTarget, pickTwin, type DedupCandidate, type DedupIncoming } from './twin-rule';

/** Rows read per lookup; an account holds a handful of ingest rows inside the widest window. */
const CANDIDATE_LIMIT = 100;

type DedupRule = 'twin' | 'settlement';

interface DedupTarget {
  transaction: Transactions;
  rule: DedupRule;
}

/**
 * The accounts a payment may already be on: the account it resolved to, and the other accounts of the
 * same card. A multi-currency card has one account per currency, and a row moved to another of them
 * (a short balance the bank covered from elsewhere) is still the same payment.
 */
const loadCardAccountIds = async ({
  userId,
  accountId,
  cardLabel,
  cardLastDigits,
}: {
  userId: number;
  accountId: RecordId;
  cardLabel: string | null;
  cardLastDigits: string | null;
}): Promise<RecordId[]> => {
  const rows = cardLabel || cardLastDigits ? await findCardRows({ userId, cardLabel, lastDigits: cardLastDigits }) : [];

  return [...new Set([accountId, ...rows.map((row) => row.accountId)])];
};

const toCandidates = async ({ rows }: { rows: Transactions[] }): Promise<DedupCandidate[]> => {
  const names = await loadPlanNames({ plans: rows });

  return rows.map((row) => {
    const merchant = (row.externalData?.cardPayment as { merchant?: unknown } | undefined)?.merchant;

    return {
      id: row.id,
      time: row.time,
      figures: figuresOfRow({
        amount: row.amount,
        currencyCode: row.currencyCode,
        originalAmount: row.originalAmount,
        originalCurrencyCode: row.originalCurrencyCode,
      }),
      takenSlots: readTakenSlots({ externalData: row.externalData }),
      names: names.get(row.id) ?? [],
      payeeId: row.payeeId,
      merchant: typeof merchant === 'string' ? merchant : null,
    };
  });
};

/**
 * The logged row an incoming payment joins, if any. Runs under the user's `ingest-dedup` lock in both
 * pipelines, so two sources of one payment that arrive together cannot both log a row.
 *
 * Only rows the ingest wrote qualify (a hand-typed or bank-synced row is never absorbed): same
 * direction, on the payment's account or another account of its card, inside the widest window of the
 * two rules. A settlement is tried first on its own rule, then the exact twin rule decides.
 */
export const findDedupTarget = async ({
  userId,
  accountId,
  cardLabel,
  cardLastDigits,
  direction,
  incoming,
}: {
  userId: number;
  accountId: RecordId;
  cardLabel: string | null;
  cardLastDigits: string | null;
  direction: 'debit' | 'credit';
  incoming: DedupIncoming;
}): Promise<DedupTarget | null> => {
  const accountIds = await loadCardAccountIds({ userId, accountId, cardLabel, cardLastDigits });
  const windowMs = incoming.stage === 'settlement' ? dedupConfig.settlementWindowMs : dedupConfig.twinWindowMs;

  const rows = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    transfers: 'exclude',
    completeness: { cap: { limit: CANDIDATE_LIMIT, onTruncated: 'log', context: { userId } } },
    where: {
      accountId: { [Op.in]: accountIds },
      transactionType: direction === 'debit' ? TRANSACTION_TYPES.expense : TRANSACTION_TYPES.income,
      time: {
        [Op.gte]: new Date(incoming.time.getTime() - windowMs),
        [Op.lte]: new Date(incoming.time.getTime() + dedupConfig.twinWindowMs),
      },
      [Op.and]: literal(`("Transactions"."externalData"->'ingest') IS NOT NULL`),
    },
    order: [['time', 'ASC']],
  });
  if (!rows.length) return null;

  const candidates = await toCandidates({ rows });
  const byId = new Map(rows.map((row) => [row.id, row]));

  const settlement = pickSettlementTarget({ candidates, incoming });
  if (settlement) return { transaction: byId.get(settlement.id)!, rule: 'settlement' };

  const twin = pickTwin({
    candidates,
    incoming,
    sameShop: ({ candidate }) =>
      incoming.merchant === null ||
      isSameShop({
        planNames: [...candidate.names],
        planPayeeId: candidate.payeeId,
        incomingText: incoming.merchant,
        incomingPayeeId: incoming.payeeId,
      }),
  });

  return twin ? { transaction: byId.get(twin.id)!, rule: 'twin' } : null;
};
