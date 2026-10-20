import { ACCOUNT_TYPES, type IngestShortBalanceCorrection, type RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { t } from '@i18n/index';
import { ConflictError, NotFoundError, ValidationError } from '@js/errors';
import Accounts from '@models/accounts.model';
import { connection } from '@models/connection';
import { findOneTransaction } from '@models/transactions-query';
import { DOMAIN_EVENTS, eventBus, type IngestPaymentLoggedPayload } from '@services/common/event-bus';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';
import { updateTransaction } from '@services/transactions/update-transaction';
import { QueryTypes } from 'sequelize';

import { correctionOf } from './read-ingest-suggestions';

const loadOpenCorrection = async ({ userId, transactionId }: { userId: number; transactionId: RecordId }) => {
  const transaction = await findOneTransaction({
    where: { id: transactionId },
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
  });
  if (!transaction) throw new NotFoundError({ message: t({ key: 'transactions.notFound' }) });

  const correction = correctionOf({ externalData: transaction.externalData });
  if (!correction || correction.status !== 'open') {
    throw new ConflictError({ message: t({ key: 'ingest.correctionNotOpen' }) });
  }

  return { transaction, correction };
};

const settleCorrection = async ({
  transactionId,
  status,
  accountId,
}: {
  transactionId: RecordId;
  status: Exclude<IngestShortBalanceCorrection['status'], 'open'>;
  accountId?: RecordId;
}) => {
  await connection.sequelize.query(
    `UPDATE "Transactions"
        SET "externalData" = jsonb_set(
              "externalData",
              '{ingest,correction}',
              ("externalData"->'ingest'->'correction') || CAST(:patch AS jsonb)
            )
      WHERE "id" = :transactionId`,
    {
      replacements: {
        patch: JSON.stringify({
          status,
          resolvedAt: new Date().toISOString(),
          ...(accountId && { appliedAccountId: accountId }),
        }),
        transactionId,
      },
      type: QueryTypes.UPDATE,
    },
  );
};

const emitLogged = async ({ userId, transactionId }: { userId: number; transactionId: RecordId }) => {
  const transaction = await findOneTransaction({
    where: { id: transactionId },
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    attributes: ['id', 'accountId', 'externalData'],
  });
  if (!transaction) return;

  const ingest = (transaction.externalData?.ingest ?? {}) as Partial<IngestPaymentLoggedPayload>;
  const payload: IngestPaymentLoggedPayload = {
    userId,
    accountId: transaction.accountId,
    transactionId,
    requestId: ingest.requestId ?? ('' as RecordId),
    pipeline: ingest.pipeline ?? 'notification',
  };
  await runAfterCommit({ fn: () => eventBus.emit(DOMAIN_EVENTS.INGEST_PAYMENT_LOGGED, payload) });
};

const approveCorrectionImpl = async ({
  userId,
  transactionId,
  accountId,
  amount,
}: {
  userId: number;
  transactionId: RecordId;
  /** The account to move the payment to; the suggested one when omitted. */
  accountId?: RecordId;
  /** The amount on that account, in its currency; the estimate when omitted (the owner may know the bank's figure). */
  amount?: Money;
}): Promise<{ transactionId: RecordId; accountId: RecordId }> => {
  const { transaction, correction } = await loadOpenCorrection({ userId, transactionId });

  const targetId = accountId ?? correction.suggestedAccountId;
  const candidate = correction.candidates.find((entry) => entry.accountId === targetId);
  if (!candidate) throw new ValidationError({ message: t({ key: 'ingest.correctionAccountNotOffered' }) });

  const target = await Accounts.findOne({
    where: { id: targetId, userId },
    attributes: ['id', 'type', 'currencyCode'],
  });
  if (!target) throw new NotFoundError({ message: t({ key: 'accounts.accountNotFoundForTransaction' }) });

  // The payment keeps what the card was charged as the original amount: the figure it was logged with,
  // unless it already carried one (a payment converted when it was first logged).
  const original = transaction.originalAmount
    ? { amount: transaction.originalAmount, currencyCode: transaction.originalCurrencyCode! }
    : { amount: transaction.amount, currencyCode: transaction.currencyCode };
  const keepsOriginal = original.currencyCode !== target.currencyCode;

  await updateTransaction({
    id: transactionId,
    userId,
    accountId: target.id,
    amount: amount ?? Money.fromDecimal(candidate.estimatedAmount),
    originalAmount: keepsOriginal ? original.amount : null,
    originalCurrencyCode: keepsOriginal ? original.currencyCode : null,
    isPlanned: target.type !== ACCOUNT_TYPES.system,
    keepIngestUnconfirmed: true,
  });

  await settleCorrection({ transactionId, status: 'applied', accountId: target.id });
  await emitLogged({ userId, transactionId });

  return { transactionId, accountId: target.id };
};

/**
 * Moves a payment to the account the correction suggests (or another one it offers) and takes the
 * amount in that account's currency: the estimate unless the owner enters the bank's figure. Balances
 * follow, and the amount the card was charged stays on the row as its original amount.
 */
export const approveCorrection = withTransaction(approveCorrectionImpl);

const dismissCorrectionImpl = async ({
  userId,
  transactionId,
}: {
  userId: number;
  transactionId: RecordId;
}): Promise<{ transactionId: RecordId }> => {
  await loadOpenCorrection({ userId, transactionId });
  await settleCorrection({ transactionId, status: 'dismissed' });
  await emitLogged({ userId, transactionId });

  return { transactionId };
};

/** Leaves the payment where it was logged and closes the suggestion. */
export const dismissCorrection = withTransaction(dismissCorrectionImpl);
