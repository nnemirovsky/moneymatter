import type { RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import Accounts from '@models/accounts.model';
import IngestRequests from '@models/ingest-requests.model';
import { findTransactions } from '@models/transactions-query';
import { Op } from 'sequelize';

import { readStoredParse } from './stored-parse';

/** How many of a source's latest logged payments are read for the accounts it has used. */
const HISTORY_LIMIT = 100;

/** A logged payment of the source: where it landed and what it named. */
export interface HistoryUse {
  accountId: RecordId;
  accountCurrencyCode: string;
  /** The currency the payment stated. */
  paymentCurrencyCode: string | null;
  cardLastDigits: string | null;
}

/**
 * How sure the pick is:
 * - `digits`: the same last digits in the same currency landed on that one account before;
 * - `balance`: the balance the notice states fits that one account (the digits did not settle it);
 * - `unique`: the source used that one account in the currency, and nothing else supports or contradicts it.
 */
export type HistoryConfidence = 'digits' | 'balance' | 'unique';

/** Tolerance of the balance check: unlogged small movements and rounding make a bank's balance differ slightly. */
const balanceTolerance = ({ balance }: { balance: Money }): Money => {
  const relative = balance.abs().multiply(0.01);
  const floor = Money.fromDecimal('0.5');

  return relative.greaterThan(floor) ? relative : floor;
};

const unique = <T>({ values }: { values: readonly T[] }): T[] => [...new Set(values)];

/**
 * The account a notification's payment belongs to, from the accounts the same source has landed payments on.
 *
 * 1. The accounts that took a payment with the same last digits in the same currency. One is the answer.
 * 2. Without digits or a digit match, the accounts in the payment's currency among those the source used.
 * 3. With several candidates, or one that is not backed by digits, the balance the notice states: the account whose
 *    balance, moved by this payment, equals it. Exactly one fitting account is the answer.
 *
 * `null` when nothing points at exactly one account.
 */
export const pickHistoryAccount = ({
  uses,
  balances,
  cardLastDigits,
  currencyCode,
  balanceAfter,
  amount,
  kind,
}: {
  uses: readonly HistoryUse[];
  /** The current balance of each used account. */
  balances: ReadonlyMap<RecordId, Money>;
  cardLastDigits: string | null;
  currencyCode: string | null;
  balanceAfter: Money | null;
  amount: Money;
  kind: 'debit' | 'credit';
}): { accountId: RecordId; confidence: HistoryConfidence } | null => {
  if (!currencyCode) return null;

  const fitsBalance = ({ accountId }: { accountId: RecordId }): boolean => {
    const current = balances.get(accountId);
    if (!current || !balanceAfter) return false;

    const expected = kind === 'debit' ? current.subtract(amount) : current.add(amount);

    return expected
      .subtract(balanceAfter)
      .abs()
      .lte(balanceTolerance({ balance: balanceAfter }));
  };
  const settle = ({
    candidates,
    alone,
  }: {
    candidates: readonly RecordId[];
    alone: HistoryConfidence;
  }): { accountId: RecordId; confidence: HistoryConfidence } | null => {
    if (candidates.length === 1) {
      const [only] = candidates;

      return only
        ? { accountId: only, confidence: alone === 'unique' && fitsBalance({ accountId: only }) ? 'balance' : alone }
        : null;
    }

    const fitting = candidates.filter((accountId) => fitsBalance({ accountId }));
    const [fit] = fitting;

    return fitting.length === 1 && fit ? { accountId: fit, confidence: 'balance' } : null;
  };

  const byDigits = cardLastDigits
    ? unique({
        values: uses
          .filter((use) => use.cardLastDigits === cardLastDigits && use.paymentCurrencyCode === currencyCode)
          .map((use) => use.accountId),
      })
    : [];
  if (byDigits.length) return settle({ candidates: byDigits, alone: 'digits' });

  const byCurrency = unique({
    values: uses.filter((use) => use.accountCurrencyCode === currencyCode).map((use) => use.accountId),
  });

  return settle({ candidates: byCurrency, alone: 'unique' });
};

/** The accounts the source's logged notification payments landed on, newest first. */
export const loadHistoryUses = async ({
  userId,
  sourceId,
}: {
  userId: number;
  sourceId: RecordId;
}): Promise<{ uses: HistoryUse[]; balances: Map<RecordId, Money> }> => {
  const requests = await IngestRequests.findAll({
    where: { userId, sourceId, pipeline: 'notification', status: 'logged', transactionId: { [Op.ne]: null } },
    attributes: ['transactionId', 'parsed'],
    order: [['createdAt', 'DESC']],
    limit: HISTORY_LIMIT,
  });
  const transactionIds = requests.flatMap((request) => (request.transactionId ? [request.transactionId] : []));
  if (!transactionIds.length) return { uses: [], balances: new Map() };

  const transactions = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: 'all',
    where: { id: { [Op.in]: transactionIds } },
  });
  const accountOf = new Map(transactions.map((transaction) => [transaction.id, transaction.accountId]));
  const accounts = await Accounts.findAll({
    where: { userId, id: { [Op.in]: unique({ values: [...accountOf.values()] }) } },
    attributes: ['id', 'currencyCode', 'currentBalance'],
  });
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  const uses: HistoryUse[] = [];
  for (const request of requests) {
    const accountId = request.transactionId ? accountOf.get(request.transactionId) : undefined;
    const account = accountId ? accountById.get(accountId) : undefined;
    if (!accountId || !account) continue;

    const payment = readStoredParse({ value: request.parsed })?.payment;
    uses.push({
      accountId,
      accountCurrencyCode: account.currencyCode,
      paymentCurrencyCode: payment?.currencyCode ?? null,
      cardLastDigits: payment?.cardLastDigits ?? null,
    });
  }

  return { uses, balances: new Map(accounts.map((account) => [account.id, account.currentBalance])) };
};
