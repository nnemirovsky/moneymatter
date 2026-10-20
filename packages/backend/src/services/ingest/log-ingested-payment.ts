import {
  ACCOUNT_TYPES,
  PAYMENT_TYPES,
  TRANSACTION_TRANSFER_NATURE,
  TRANSACTION_TYPES,
  type IngestPipeline,
  type RecordId,
} from '@bt/shared/types';
import type { Money } from '@common/types/money';
import { ExchangeRateUnavailableError } from '@js/errors';
import { connection } from '@models/connection';
import { getBaseCurrency } from '@models/users-currencies.model';
import { DOMAIN_EVENTS, eventBus, type IngestPaymentLoggedPayload } from '@services/common/event-bus';
import { runAfterCommit } from '@services/common/run-after-commit';
import { createTransaction } from '@services/transactions/create-transaction';
import { QueryTypes } from 'sequelize';

import { CardPaymentRateUnavailableError } from './card-payment/rate-unavailable-error';
import type { StoredBalanceAfter } from './event/balance-authority';

/** The `externalData.cardPayment` marker both pipelines write: bank sync settles a plan that carries it. */
interface CardPaymentMarker {
  source: string;
  card: string | null;
  name: string | null;
  merchant: string;
  rawAmount: string;
}

/**
 * The first source of a logged payment, as `externalData.ingest.sources[]` keeps it. `sourceKey` is the
 * notification source (`null` for a tap).
 */
interface IngestSourceRecord {
  requestId: RecordId;
  pipeline: IngestPipeline;
  sourceKey: string | null;
  balanceAfter: StoredBalanceAfter | null;
}

interface LogIngestedPaymentParams {
  userId: number;
  requestId: RecordId;
  pipeline: IngestPipeline;
  account: { id: RecordId; type: ACCOUNT_TYPES; currencyCode: string };
  direction: 'debit' | 'credit';
  /** The amount booked on the account, in the account's currency. */
  amount: Money;
  originalAmount?: Money;
  originalCurrencyCode?: string;
  time: Date;
  /** The merchant or counterparty as the payment printed it: the note and the marker's merchant. */
  merchant: string;
  payeeId: string | null;
  /** The pipeline's own pick: the payee's history category, else the user's default category. */
  categoryId: string;
  externalReference: string;
  cardPayment: CardPaymentMarker;
  sourceKey?: string | null;
  balanceAfter?: StoredBalanceAfter | null;
}

/**
 * Writes the transaction of an automated payment, the one place both ingest pipelines log through.
 *
 * - The row is real at once (balances are current) and carries two markers in `externalData`:
 *   `cardPayment`, which the bank sync uses to settle a plan, and `ingest`, which says where it came
 *   from. `ingest.unconfirmed` stays true until the owner confirms the row in the Automation inbox
 *   (or edits it); `GET /user/settings/card-payments/unconfirmed` lists such rows.
 * - `ingest.systemNote` is the note the pipeline wrote and `ingest.systemCategoryId` the category it
 *   ended up with when no rule or AI stamped one, so a later merge can tell the pipeline's own values
 *   from the owner's edits.
 * - On a bank-connected account the row is planned, the only kind of manual row such an account
 *   accepts; the bank sync later settles it.
 * - After the commit, `INGEST_PAYMENT_LOGGED` is emitted: the inbox posts the one confirm card for the
 *   transaction from it.
 *
 * Runs inside the caller's transaction. A missing exchange rate for the row's base-currency value is
 * thrown as a `CardPaymentRateUnavailableError` naming the pair, so the caller can park the request;
 * anything else `createTransaction` throws passes through unchanged.
 */
export const logIngestedPayment = async ({
  userId,
  requestId,
  pipeline,
  account,
  direction,
  amount,
  originalAmount,
  originalCurrencyCode,
  time,
  merchant,
  payeeId,
  categoryId,
  externalReference,
  cardPayment,
  sourceKey = null,
  balanceAfter = null,
}: LogIngestedPaymentParams): Promise<{ transactionId: RecordId }> => {
  const source: IngestSourceRecord = { requestId, pipeline, sourceKey, balanceAfter };

  let transaction: Awaited<ReturnType<typeof createTransaction>>[0];
  try {
    [transaction] = await createTransaction({
      userId,
      accountId: account.id,
      amount,
      originalAmount,
      originalCurrencyCode,
      time,
      transactionType: direction === 'debit' ? TRANSACTION_TYPES.expense : TRANSACTION_TYPES.income,
      paymentType: PAYMENT_TYPES.mobilePayment,
      transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
      categoryId,
      payeeId: payeeId ?? undefined,
      note: merchant,
      applyAutomations: true,
      isPlanned: account.type !== ACCOUNT_TYPES.system,
      externalReference,
      externalData: {
        cardPayment: { ...cardPayment, requestId },
        ingest: { requestId, pipeline, unconfirmed: true, systemNote: merchant, sources: [source] },
      },
    });
  } catch (error) {
    if (!(error instanceof ExchangeRateUnavailableError)) throw error;

    // The only rate `createTransaction` looks up for a payment is the account currency's to the
    // base currency (the row's `refAmount`).
    const { currency: baseCurrency } = await getBaseCurrency({ userId });
    if (baseCurrency.code === account.currencyCode) throw error;

    throw new CardPaymentRateUnavailableError({
      cause: error,
      fromCurrencyCode: account.currencyCode,
      toCurrencyCode: baseCurrency.code,
      date: time,
    });
  }

  // Rules, a payee's default and the AI decide the category inside `createTransaction`; only a row
  // none of them stamped carries the pipeline's own pick.
  if (!transaction.categorizationMeta) {
    await connection.sequelize.query(
      `UPDATE "Transactions"
          SET "externalData" = jsonb_set("externalData", '{ingest,systemCategoryId}', to_jsonb(CAST(:categoryId AS text)))
        WHERE "id" = :transactionId`,
      {
        replacements: { categoryId: transaction.categoryId, transactionId: transaction.id },
        type: QueryTypes.UPDATE,
      },
    );
  }

  const payload: IngestPaymentLoggedPayload = {
    userId,
    accountId: account.id,
    transactionId: transaction.id,
    requestId,
    pipeline,
  };
  await runAfterCommit({ fn: () => eventBus.emit(DOMAIN_EVENTS.INGEST_PAYMENT_LOGGED, payload) });

  return { transactionId: transaction.id };
};
