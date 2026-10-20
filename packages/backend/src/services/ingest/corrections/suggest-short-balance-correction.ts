import {
  ACCOUNT_STATUSES,
  TRANSACTION_TYPES,
  isDedicatedFlowAccountCategory,
  type IngestShortBalanceCorrection,
  type RecordId,
} from '@bt/shared/types';
import { Money } from '@common/types/money';
import Accounts from '@models/accounts.model';
import { connection } from '@models/connection';
import { findOneTransaction } from '@models/transactions-query';
import { DOMAIN_EVENTS, eventBus, type IngestPaymentLoggedPayload } from '@services/common/event-bus';
import { Op, QueryTypes } from 'sequelize';

import { convertToAccountCurrency } from '../card-payment/convert-to-account-currency';
import { readUserLocale } from '../card-payment/read-user-locale';
import { findCardRows } from '../resolve-card-account';
import { composeCorrection } from './compose-correction';
import { correctionOf } from './read-ingest-suggestions';
import { applyRanking, isBalanceShort, rankByCoverage, type ShortBalanceCandidate } from './short-balance-rule';

interface IngestMarkers {
  requestId?: RecordId;
  pipeline?: 'cardPayment' | 'notification';
  cardLastDigits?: string;
  balanceBefore?: { amount: number; currencyCode: string };
}

const amountOf = ({ money, currencyCode }: { money: Money; currencyCode: string }) => ({
  amount: money.toNumber(),
  currencyCode,
});

/**
 * Looks at a payment that was just logged and, when it went to a per-currency account that held less
 * than the payment, stores a suggestion on the transaction saying which other account of the card
 * most likely paid. Nothing moves: the owner approves "Move it to <account>?" from the transaction's
 * confirm card, or dismisses it.
 *
 * - Only a debit logged to an account of a card (a per-currency row or the default row) qualifies, and
 *   only when the account held less than the payment before it (`ingest.balanceBefore`).
 * - The candidates are the card's other accounts whose balance covers the payment converted at that
 *   day's rate. No covering account, no suggestion.
 * - The `duplicateMatching` connection ranks them and writes the one-line reason. Without a model
 *   (or when it fails) the deterministic order stands: the default account first, no reason.
 *
 * Returns whether a suggestion was stored. Runs after the logging transaction committed.
 */
export const suggestShortBalanceCorrection = async ({
  userId,
  transactionId,
}: {
  userId: number;
  transactionId: RecordId;
}): Promise<boolean> => {
  const transaction = await findOneTransaction({
    where: { id: transactionId },
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
  });
  if (!transaction || transaction.transactionType !== TRANSACTION_TYPES.expense) return false;

  const ingest = (transaction.externalData?.ingest ?? {}) as IngestMarkers;
  if (!ingest.balanceBefore || correctionOf({ externalData: transaction.externalData })) return false;

  const balanceBefore = Money.fromDecimal(ingest.balanceBefore.amount);
  if (!isBalanceShort({ balanceBefore, amount: transaction.amount })) return false;

  const cardLabel = (transaction.externalData?.cardPayment as { card?: string | null } | undefined)?.card ?? null;
  const rows = await findCardRows({ userId, cardLabel, lastDigits: ingest.cardLastDigits ?? null });
  if (!rows.some((row) => row.accountId === transaction.accountId)) return false;

  const otherIds = [...new Set(rows.map((row) => row.accountId).filter((id) => id !== transaction.accountId))];
  if (!otherIds.length) return false;

  const accounts = await Accounts.findAll({
    where: { userId, id: { [Op.in]: otherIds }, status: ACCOUNT_STATUSES.active },
    attributes: ['id', 'name', 'currencyCode', 'currentBalance', 'accountCategory'],
  });

  const candidates: (ShortBalanceCandidate & { accountName: string })[] = [];
  for (const account of accounts) {
    if (isDedicatedFlowAccountCategory(account.accountCategory)) continue;

    const converted = await convertToAccountCurrency({
      ownerUserId: userId,
      amount: transaction.amount,
      from: transaction.currencyCode,
      to: account.currencyCode,
      date: transaction.time,
    });
    // A pair with no rate cannot be estimated, so the account cannot be offered.
    if ('parked' in converted) continue;

    candidates.push({
      accountId: account.id,
      accountName: account.name,
      currencyCode: account.currencyCode,
      balance: account.currentBalance,
      estimatedAmount: converted.amount,
      isDefault: rows.some((row) => row.accountId === account.id && row.currencyCode === null),
    });
  }

  const covering = rankByCoverage({ candidates });
  if (!covering.length) return false;

  const loggedAccount = await Accounts.findOne({ where: { id: transaction.accountId }, attributes: ['name'] });
  const merchant = (transaction.externalData?.cardPayment as { merchant?: string } | undefined)?.merchant ?? null;
  const composition = await composeCorrection({
    userId,
    amount: transaction.amount,
    currencyCode: transaction.currencyCode,
    merchant,
    loggedAccountName: loggedAccount?.name ?? '',
    balanceBefore,
    candidates: covering.map((candidate) => ({
      ...candidate,
      accountName: candidates.find((entry) => entry.accountId === candidate.accountId)?.accountName ?? '',
    })),
    locale: await readUserLocale({ userId }),
  });

  const ranked = composition ? applyRanking({ covering, ranking: composition.ranking }) : covering;
  const best = ranked[0]!;
  const correction: IngestShortBalanceCorrection = {
    kind: 'shortBalance',
    status: 'open',
    balanceBefore: amountOf({ money: balanceBefore, currencyCode: transaction.currencyCode }),
    suggestedAccountId: best.accountId,
    estimatedAmount: { ...amountOf({ money: best.estimatedAmount, currencyCode: best.currencyCode }), estimate: true },
    candidates: ranked.map((candidate) => ({
      accountId: candidate.accountId,
      currencyCode: candidate.currencyCode,
      balance: candidate.balance.toNumber(),
      estimatedAmount: candidate.estimatedAmount.toNumber(),
      isDefault: candidate.isDefault,
    })),
    reason: composition?.reason ?? null,
    composedBy: composition ? 'ai' : 'rules',
    createdAt: new Date().toISOString(),
  };

  await connection.sequelize.query(
    `UPDATE "Transactions"
        SET "externalData" = jsonb_set("externalData", '{ingest,correction}', CAST(:correction AS jsonb))
      WHERE "id" = :transactionId`,
    { replacements: { correction: JSON.stringify(correction), transactionId }, type: QueryTypes.UPDATE },
  );

  // The one confirm card of this transaction shows the suggestion.
  const payload: IngestPaymentLoggedPayload = {
    userId,
    accountId: transaction.accountId,
    transactionId,
    requestId: ingest.requestId ?? ('' as RecordId),
    pipeline: ingest.pipeline ?? 'notification',
  };
  eventBus.emit(DOMAIN_EVENTS.INGEST_PAYMENT_LOGGED, payload);

  return true;
};
