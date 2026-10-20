import { TRANSACTION_TYPES, type IngestTransferSuggestion, type RecordId } from '@bt/shared/types';
import { connection } from '@models/connection';
import { findTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import { getDismissalsForUser } from '@models/transfer-suggestion-dismissals.model';
import { DOMAIN_EVENTS, eventBus, type IngestPaymentLoggedPayload } from '@services/common/event-bus';
import { Op, QueryTypes } from 'sequelize';

import { convertToAccountCurrency } from '../card-payment/convert-to-account-currency';
import { transferSuggestionOf } from '../corrections/read-ingest-suggestions';
import { dedupConfig } from './constants';
import { conversionDeviation, isPlausibleConversion } from './conversion-pair-rule';

/** Rows read per lookup; a window of an hour on other accounts holds a handful. */
const CANDIDATE_LIMIT = 50;

const oppositeType = ({ type }: { type: TRANSACTION_TYPES }) =>
  type === TRANSACTION_TYPES.expense ? TRANSACTION_TYPES.income : TRANSACTION_TYPES.expense;

interface IngestMarkers {
  requestId?: RecordId;
  pipeline?: 'cardPayment' | 'notification';
}

const markLeg = async ({
  transactionId,
  suggestion,
}: {
  transactionId: RecordId;
  suggestion: IngestTransferSuggestion;
}) => {
  await connection.sequelize.query(
    `UPDATE "Transactions"
        SET "externalData" = COALESCE("externalData", '{}'::jsonb)
            || jsonb_build_object('ingestTransferSuggestion', CAST(:suggestion AS jsonb))
      WHERE "id" = :transactionId`,
    { replacements: { suggestion: JSON.stringify(suggestion), transactionId }, type: QueryTypes.UPDATE },
  );
};

const emitLogged = ({ userId, transaction }: { userId: number; transaction: Transactions }) => {
  const ingest = transaction.externalData?.ingest as IngestMarkers | undefined;
  // Only a row the ingest wrote has an inbox card to update.
  if (!ingest?.requestId) return;

  const payload: IngestPaymentLoggedPayload = {
    userId,
    accountId: transaction.accountId,
    transactionId: transaction.id,
    requestId: ingest.requestId,
    pipeline: ingest.pipeline ?? 'notification',
  };
  eventBus.emit(DOMAIN_EVENTS.INGEST_PAYMENT_LOGGED, payload);
};

/**
 * Looks at a payment that was just logged for the other leg of a currency conversion between two of
 * the user's own accounts: money out of one, the converted money into the other, in different
 * currencies, within about an hour and at a rate close to the day's (±3%). The pair is suggested as a
 * transfer; nothing is ever linked here.
 *
 * - The suggestion is stored on both legs (`externalData.ingestTransferSuggestion`), where the inbox
 *   card of the transaction can show it. The owner links the pair with the existing transfer link
 *   (`PUT /transactions/link`), or dismisses it with the existing transfer-suggestion dismissal, which
 *   also keeps this lookup from offering the pair again.
 * - A leg that already carries a suggestion is left alone, so a row has at most one.
 * - The legs must be on different accounts of the user and must not be transfers or splits already.
 * - The best pair wins: the smallest deviation from the day's rate, then the closest in time.
 *
 * Returns whether a suggestion was stored. Runs after the logging transaction committed.
 */
export const suggestConversionPair = async ({
  userId,
  transactionId,
}: {
  userId: number;
  transactionId: RecordId;
}): Promise<boolean> => {
  const [transaction] = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    transfers: 'exclude',
    completeness: 'probe',
    where: { id: transactionId },
  });
  if (!transaction || transferSuggestionOf({ externalData: transaction.externalData })) return false;

  const candidates = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    transfers: 'exclude',
    completeness: { cap: { limit: CANDIDATE_LIMIT, onTruncated: 'log', context: { userId } } },
    where: {
      id: { [Op.ne]: transaction.id },
      transactionType: oppositeType({ type: transaction.transactionType }),
      accountId: { [Op.ne]: transaction.accountId },
      currencyCode: { [Op.ne]: transaction.currencyCode },
      time: {
        [Op.gte]: new Date(transaction.time.getTime() - dedupConfig.conversionPairWindowMs),
        [Op.lte]: new Date(transaction.time.getTime() + dedupConfig.conversionPairWindowMs),
      },
    },
    order: [['time', 'ASC']],
  });
  if (!candidates.length) return false;

  const dismissed = new Set(
    (await getDismissalsForUser({ userId })).map(
      (entry) => `${entry.expenseTransactionId}:${entry.incomeTransactionId}`,
    ),
  );

  let best: { counterpart: Transactions; deviation: number; impliedRate: number; marketRate: number } | null = null;

  for (const counterpart of candidates) {
    if (transferSuggestionOf({ externalData: counterpart.externalData })) continue;

    const [expense, income] =
      transaction.transactionType === TRANSACTION_TYPES.expense
        ? [transaction, counterpart]
        : [counterpart, transaction];
    if (dismissed.has(`${expense.id}:${income.id}`)) continue;
    if (!expense.amount.isPositive() || !income.amount.isPositive()) continue;

    // What the outgoing leg is worth in the incoming leg's currency at the day's rate.
    const converted = await convertToAccountCurrency({
      ownerUserId: userId,
      amount: expense.amount,
      from: expense.currencyCode,
      to: income.currencyCode,
      date: expense.time,
    });
    if ('parked' in converted) continue;

    const deviation = conversionDeviation({ expectedIncoming: converted.amount, actualIncoming: income.amount });
    if (!isPlausibleConversion({ deviation })) continue;

    const closer =
      !best ||
      deviation < best.deviation ||
      (deviation === best.deviation &&
        Math.abs(counterpart.time.getTime() - transaction.time.getTime()) <
          Math.abs(best.counterpart.time.getTime() - transaction.time.getTime()));
    if (!closer) continue;

    best = {
      counterpart,
      deviation,
      impliedRate: income.amount.divide(expense.amount.toNumber()).toNumber(),
      marketRate: converted.amount.divide(expense.amount.toNumber()).toNumber(),
    };
  }
  if (!best) return false;

  const [expense, income] =
    transaction.transactionType === TRANSACTION_TYPES.expense
      ? [transaction, best.counterpart]
      : [best.counterpart, transaction];
  const suggestion: IngestTransferSuggestion = {
    kind: 'currencyConversion',
    expenseTransactionId: expense.id,
    incomeTransactionId: income.id,
    impliedRate: best.impliedRate,
    marketRate: best.marketRate,
    deviation: best.deviation,
    createdAt: new Date().toISOString(),
  };

  await markLeg({ transactionId: transaction.id, suggestion });
  await markLeg({ transactionId: best.counterpart.id, suggestion });
  emitLogged({ userId, transaction });
  emitLogged({ userId, transaction: best.counterpart });

  return true;
};
