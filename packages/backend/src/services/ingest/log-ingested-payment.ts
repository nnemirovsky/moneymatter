import { resolveRecordedZone } from '@bt/shared/time-zone';
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
import { getStoredUserTimeZone } from '@services/user-settings/get-user-time-zone';
import { QueryTypes } from 'sequelize';

import { readPayloadTimeOffset, readPayloadTimeZone } from './card-payment/parse-payload';
import { CardPaymentRateUnavailableError } from './card-payment/rate-unavailable-error';
import type { IngestSlot, IngestSourceEntry } from './dedup/source-slots';
import type { StoredBalanceAfter } from './event/balance-authority';
import { loadNoteSuggestion } from './note/load-note-suggestion';
import { offsetMinutesOf } from './note/note-history';

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
  /**
   * The note the owner wrote on the inbox card of a parked payment; `null` is no note. Absent, the pipeline
   * picks it (the payee's usual note, else none; the merchant for a row without a payee).
   */
  noteOverride?: string | null;
  /** The owner approved this payment on its card, so the row needs no confirm card. */
  confirmed?: boolean;
}

/**
 * The zone and offset a logged payment records, decided by `resolveRecordedZone`:
 * the request's own `timeZone` wins; else the offset its time wrote, kept as a zone when the user's
 * stored zone has that offset at the time; else the stored zone itself (a blank time, or a `Z` one).
 * A user with no stored zone and no information records `null`.
 */
const readRecordedZone = async ({ userId, requestId, time }: { userId: number; requestId: RecordId; time: Date }) => {
  const [request, candidateZone] = await Promise.all([
    IngestRequests.findByPk(requestId, { attributes: ['payload'] }),
    getStoredUserTimeZone({ userId }),
  ]);
  const payload = (request?.payload ?? {}) as { time?: unknown; timeZone?: unknown; timeOffsetMinutes?: unknown };
  const offsetMinutes =
    typeof payload.timeOffsetMinutes === 'number'
      ? payload.timeOffsetMinutes
      : readPayloadTimeOffset({ value: payload.time });

  return resolveRecordedZone({
    instant: time,
    explicitZone: readPayloadTimeZone({ value: payload.timeZone }),
    offsetMinutes,
    candidateZone,
  });
};

/**
 * What the payee brings to the row: the note the owner's past payments there suggest (see
 * `suggestNoteFromHistory`; one the AI must pick is left to the follow-up), and whether this request's
 * merchant created the payee, which the owner's correction of the payee folds into the one they chose.
 */
const readPayeeContext = async ({
  userId,
  payeeId,
  requestId,
  merchant,
  time,
}: {
  userId: number;
  payeeId: string;
  requestId: RecordId;
  merchant: string;
  time: Date;
}): Promise<{ note: string | null; createdPayeeId: string | null }> => {
  const [payee, request] = await Promise.all([
    Payees.findByPk(payeeId, { attributes: ['createdAt'] }),
    IngestRequests.findByPk(requestId, { attributes: ['createdAt', 'payload'] }),
  ]);
  const suggestion = await loadNoteSuggestion({
    ownerUserId: userId,
    payeeId,
    merchant,
    time,
    offsetMinutes: offsetMinutesOf({ time: (request?.payload as { time?: unknown } | null)?.time }),
  });

  return {
    note: suggestion.kind === 'note' ? suggestion.note : null,
    createdPayeeId: payee && request && payee.createdAt >= request.createdAt ? payeeId : null,
  };
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
 * - With a payee, the note is the one the owner's past payments there suggest, else empty: never the
 *   merchant, which the payee names already and the `cardPayment` marker keeps verbatim. A row without
 *   a payee keeps the merchant as its note, so the owner still sees where the money went.
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
  noteOverride,
  confirmed = false,
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
  const context = payeeId
    ? await readPayeeContext({ userId, payeeId, requestId, merchant, time })
    : { note: merchant || null, createdPayeeId: null };
  const { createdPayeeId } = context;
  // The owner's own note is theirs, not the pipeline's: it is not recorded as `systemNote`.
  const note = noteOverride === undefined ? context.note : noteOverride;

  const recordedZone = await readRecordedZone({ userId, requestId, time });

  let transaction: Awaited<ReturnType<typeof createTransaction>>[0];
  try {
    [transaction] = await createTransaction({
      userId,
      accountId: account.id,
      amount,
      originalAmount,
      originalCurrencyCode,
      time,
      timeZone: recordedZone.timeZone,
      utcOffsetMinutes: recordedZone.utcOffsetMinutes,
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
          ...(!confirmed && { unconfirmed: true }),
          systemNote: noteOverride === undefined ? (note ?? '') : '',
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
