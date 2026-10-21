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
import Accounts from '@models/accounts.model';
import { connection } from '@models/connection';
import IngestRequests from '@models/ingest-requests.model';
import Payees from '@models/payees.model';
import { getBaseCurrency } from '@models/users-currencies.model';
import { DOMAIN_EVENTS, eventBus, type IngestPaymentLoggedPayload } from '@services/common/event-bus';
import { runAfterCommit } from '@services/common/run-after-commit';
import { createTransaction } from '@services/transactions/create-transaction';
import { QueryTypes } from 'sequelize';

import { CardPaymentRateUnavailableError } from './card-payment/rate-unavailable-error';
import type { IngestSlot, IngestSourceEntry } from './dedup/source-slots';
import type { StoredBalanceAfter } from './event/balance-authority';

/** The `externalData.cardPayment` marker both pipelines write: bank sync settles a plan that carries it. */
interface CardPaymentMarker {
  source: string;
  card: string | null;
  name: string | null;
  merchant: string;
  rawAmount: string;
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
  /**
   * The merchant or counterparty as the payment printed it: the marker's merchant, and the note of a
   * row without a payee.
   */
  merchant: string;
  payeeId: string | null;
  /** The pipeline's own pick: the payee's history category, else the user's default category. */
  categoryId: string;
  externalReference: string;
  cardPayment: CardPaymentMarker;
  sourceKey?: string | null;
  /** The dedup slot the request fills (`tap`, `wallet-notification` or `bank:<sourceKey>:<stage>`). */
  slot: IngestSlot;
  balanceAfter?: StoredBalanceAfter | null;
  /** The card's last digits, when the source states them. */
  cardLastDigits?: string | null;
}

/**
 * The payee, when it was created while this request was processed: its merchant made it. The owner's
 * correction of the payee folds such a payee into the one they chose.
 */
const payeeCreatedByRequest = async ({
  payeeId,
  requestId,
}: {
  payeeId: string;
  requestId: RecordId;
}): Promise<string | null> => {
  const [payee, request] = await Promise.all([
    Payees.findByPk(payeeId, { attributes: ['createdAt'] }),
    IngestRequests.findByPk(requestId, { attributes: ['createdAt'] }),
  ]);

  return payee && request && payee.createdAt >= request.createdAt ? payeeId : null;
};

/**
 * Writes the transaction of an automated payment, the one place both ingest pipelines log through.
 *
 * - The row is real at once (balances are current) and carries two markers in `externalData`:
 *   `cardPayment`, which the bank sync uses to settle a plan, and `ingest`, which says where it came
 *   from. `ingest.unconfirmed` stays true until the owner confirms the row in the Automation inbox
 *   (or edits it); `GET /user/settings/card-payments/unconfirmed` lists such rows.
 * - `ingest.balanceBefore` is what a debit's account held before it (the correction suggestion for a
 *   short per-currency balance starts from it); `ingest.sources[]` lists every request that told of
 *   the payment, each with the dedup slot it fills.
 * - The note is empty when a payee names the merchant: the payee says it already, and the raw spelling
 *   stays in the `cardPayment` marker. A row without a payee keeps the merchant as its note, so the
 *   owner still sees where the money went.
 * - `ingest.systemNote` is the note the pipeline wrote and `ingest.systemCategoryId` the category it
 *   ended up with when no rule or AI stamped one, so a later merge can tell the pipeline's own values
 *   from the owner's edits. `ingest.createdPayeeId` names a payee this payment's merchant created, which
 *   the owner's correction of the payee folds into the payee they chose.
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
  slot,
  balanceAfter = null,
  cardLastDigits = null,
}: LogIngestedPaymentParams): Promise<{ transactionId: RecordId }> => {
  const source: IngestSourceEntry = {
    requestId,
    pipeline,
    sourceKey,
    slot,
    balanceAfter,
    ...(cardLastDigits && { cardLastDigits }),
  };

  // What the account held before this payment: a short balance on a per-currency account is what the
  // correction suggestion starts from.
  const accountBefore = await Accounts.findOne({ where: { id: account.id }, attributes: ['currentBalance'] });
  const note = payeeId ? null : merchant;
  const createdPayeeId = payeeId ? await payeeCreatedByRequest({ payeeId, requestId }) : null;

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
      note: note ?? undefined,
      applyAutomations: true,
      isPlanned: account.type !== ACCOUNT_TYPES.system,
      externalReference,
      externalData: {
        cardPayment: { ...cardPayment, requestId },
        ingest: {
          requestId,
          pipeline,
          unconfirmed: true,
          systemNote: note ?? '',
          sources: [source],
          ...(createdPayeeId && { createdPayeeId }),
          ...(cardLastDigits && { cardLastDigits }),
          ...(direction === 'debit' &&
            accountBefore && {
              balanceBefore: { amount: accountBefore.currentBalance.toNumber(), currencyCode: account.currencyCode },
            }),
        },
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
