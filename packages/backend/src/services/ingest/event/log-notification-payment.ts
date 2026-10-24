import type { RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import UsersCurrencies from '@models/users-currencies.model';
import { getUserDefaultCategory } from '@models/users.model';
import { withTransaction } from '@services/common/with-transaction';
import { resolveVisibleCurrencies } from '@services/currencies/assert-currency-codes-visible';

import { buildExternalReference } from '../card-payment/constants';
import { convertToAccountCurrency } from '../card-payment/convert-to-account-currency';
import { formatSummary } from '../card-payment/format-summary';
import { readPayloadTimeZone } from '../card-payment/parse-payload';
import { pickHistoryCategory } from '../card-payment/pick-history-category';
import { formatRateDate } from '../card-payment/rate-unavailable-error';
import { resolveCurrency, resolveStatedCurrency } from '../card-payment/resolve-currency';
import { attachToExistingPayment } from '../dedup/attach-to-existing-payment';
import { slotOfNotification } from '../dedup/source-slots';
import { dropHoldRelease } from '../hold-release/drop-hold-release';
import { logIngestedPayment } from '../log-ingested-payment';
import { applyPayeeChoice } from './apply-payee-choice';
import { resolveBalanceAuthority } from './balance-authority';
import type { ParsedPayment } from './classify-notification';
import { loadSiblingBalances } from './load-sibling-balances';
import { buildNeedsOkSummary } from './needs-ok-summary';
import {
  findUsableAccount,
  guessNotificationAccount,
  resolveNotificationAccount,
} from './resolve-notification-account';
import { describeSource, sourceAppName } from './source-label';
import { readStoredParse, toStoredPayment, type StoredParse } from './stored-parse';

/** What the job should do after the logging transaction. */
type LogNotificationResult =
  | { kind: 'logged'; transactionId: RecordId; attached: boolean }
  | {
      kind: 'park';
      reason: 'unknownAccount' | 'lowConfidence' | 'rateUnavailable';
      summary: string;
      parsed: StoredParse;
      cardLabel: string | null;
    }
  | { kind: 'skipped' }
  /** The payment cancelled out the opposite one (a hold and its release): both rows are gone. */
  | { kind: 'dropped' };

/** What the owner chose on the inbox card of a parked payment. */
export interface PaymentOverride {
  accountId: RecordId | null;
  direction: 'debit' | 'credit' | null;
  /** The note the owner wrote on the card; `''` is no note, `null` leaves the note to the pipeline. */
  note: string | null;
}

/**
 * A parsed time stated without a zone (`new Date("2026-10-20T18:40:00")`) read back as the wall clock
 * it was written as, whatever zone the server runs in.
 */
const wallClockOf = ({ date }: { date: Date }): Date =>
  new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()));

const logNotificationPaymentImpl = async ({
  requestId,
  payment,
  symbol,
  parser,
  kind,
  confidence,
  source,
  locale,
  override,
}: {
  requestId: RecordId;
  payment: ParsedPayment;
  symbol: string | null;
  parser: 'wallet' | 'ai';
  kind: string;
  confidence: number;
  source: NotificationSources | null;
  locale: string;
  override?: PaymentOverride;
}): Promise<LogNotificationResult> => {
  const row = await IngestRequests.findOne({ where: { id: requestId }, lock: true });
  if (!row || row.status !== 'received' || row.transactionId) return { kind: 'skipped' };

  const userId = row.userId;
  // The other side of an approved currency exchange is kept on the request, where the link of the two rows finds it.
  const conversion = readStoredParse({ value: row.parsed })?.conversion;
  const base: StoredParse = {
    parser,
    kind,
    confidence,
    payment: toStoredPayment({ payment }),
    symbol,
    ...(conversion && { conversion }),
  };
  const cardLabel = payment.cardName;
  const sourceLabel = describeSource({ source, payload: row.payload });

  const heldCurrencies = await UsersCurrencies.findAll({ where: { userId }, attributes: ['currencyCode'], raw: true });
  const userCurrencyCodes = heldCurrencies.map((held) => held.currencyCode);

  // The card's account depends on the payment's currency, so the currency the payment states is read
  // first. One that contradicts itself picks no currency row (the default is used) and parks below.
  const stated = resolveStatedCurrency({
    explicitCurrency: payment.currencyCode,
    textCode: null,
    textSymbol: symbol,
    userCurrencyCodes,
  });
  const statedCurrencyCode = stated.ok ? stated.currencyCode : null;

  const needsOk = async ({
    reason,
    extra = {},
  }: {
    reason: 'unknownAccount' | 'lowConfidence';
    extra?: Partial<StoredParse>;
  }): Promise<LogNotificationResult> => ({
    kind: 'park',
    reason,
    parsed: { ...base, ...extra },
    cardLabel,
    summary: await buildNeedsOkSummary({
      userId,
      amount: payment.amount,
      currencyCode: statedCurrencyCode,
      merchant: payment.merchant,
      source: sourceLabel,
      locale,
    }),
  });

  // The owner's choice on the inbox card wins over the usual resolution; the server still never guesses.
  const chosen = override?.accountId ? await findUsableAccount({ userId, accountId: override.accountId }) : null;
  const found =
    chosen ??
    (await resolveNotificationAccount({
      userId,
      cardName: payment.cardName,
      cardLastDigits: payment.cardLastDigits,
      currencyCode: statedCurrencyCode,
      source,
    }));
  if (!found) {
    return needsOk({
      reason: 'unknownAccount',
      extra: {
        accountGuessId: await guessNotificationAccount({
          userId,
          currencyCode: statedCurrencyCode,
          appName: sourceAppName({ source, payload: row.payload }),
        }),
      },
    });
  }

  const { account } = found;
  const resolved = resolveCurrency({
    explicitCurrency: payment.currencyCode,
    textCode: null,
    textSymbol: symbol,
    userCurrencyCodes,
    accountCurrencyCode: account.currencyCode,
  });
  if (!resolved.ok) return needsOk({ reason: 'lowConfidence' });

  const original =
    payment.originalAmount && payment.originalCurrencyCode
      ? { amount: Money.fromDecimal(payment.originalAmount), currencyCode: payment.originalCurrencyCode }
      : null;
  const { rejected } = await resolveVisibleCurrencies({
    userId,
    codes: [resolved.currencyCode, original?.currencyCode],
  });
  if (rejected.length) return needsOk({ reason: 'lowConfidence' });

  const direction = override?.direction ?? payment.kind;
  const time = new Date(typeof row.payload.time === 'string' ? row.payload.time : row.createdAt);
  const paymentAmount = Money.fromDecimal(payment.amount);
  const inAccountCurrency = resolved.currencyCode === account.currencyCode;
  let accountAmount = paymentAmount;

  if (!inAccountCurrency) {
    const converted = await convertToAccountCurrency({
      ownerUserId: userId,
      amount: paymentAmount,
      from: resolved.currencyCode,
      to: account.currencyCode,
      date: time,
    });
    if ('parked' in converted) {
      return {
        kind: 'park',
        reason: 'rateUnavailable',
        parsed: base,
        cardLabel,
        summary: formatSummary({
          summary: {
            type: 'parked',
            reason: 'rateUnavailable',
            fromCurrencyCode: resolved.currencyCode,
            toCurrencyCode: account.currencyCode,
            date: formatRateDate({ date: time }),
          },
          locale,
        }),
      };
    }

    accountAmount = converted.amount;
  }

  const payeeId = await applyPayeeChoice({
    userId,
    requestId,
    rawMerchant: payment.merchant,
    choice: payment.payee,
  });
  const historyCategoryId = payeeId ? await pickHistoryCategory({ ownerUserId: userId, payeeId, asOf: time }) : null;

  const siblings = payment.balanceAfter
    ? await loadSiblingBalances({
        userId,
        accountIds: [account.id],
        cardLabel: payment.cardName,
        cardLastDigits: payment.cardLastDigits,
        sourceId: row.sourceId,
      })
    : [];
  const balanceAfter = payment.balanceAfter
    ? resolveBalanceAuthority({
        balance: payment.balanceAfter,
        accountCurrencyCode: account.currencyCode,
        siblings,
      })
    : null;

  // A payment in a foreign currency keeps what the card was charged; a bank that states both
  // amounts supplies the charged one itself.
  const kept = original ?? (inAccountCurrency ? null : { amount: paymentAmount, currencyCode: resolved.currencyCode });

  const merchant = payment.merchant ?? sourceLabel;
  const slot = slotOfNotification({ sourceKey: source?.sourceKey ?? null, stage: payment.stage });
  const balanceStored = { ...base, balanceAfter };

  // A source of a payment that is already logged joins that row and enriches it.
  const attached = await attachToExistingPayment({
    userId,
    payment: {
      requestId,
      pipeline: 'notification',
      account,
      direction,
      time,
      slot,
      stage: payment.stage,
      sourceKey: source?.sourceKey ?? null,
      fromBank: slot.startsWith('bank:'),
      statedAmount: paymentAmount,
      statedCurrencyCode: resolved.currencyCode,
      originalAmount: original?.amount ?? null,
      originalCurrencyCode: original?.currencyCode ?? null,
      merchant: payment.merchant,
      payeeId,
      cardLabel: payment.cardName,
      cardLastDigits: payment.cardLastDigits,
      balanceAfter,
      bankWallClock: payment.occurredAt ? wallClockOf({ date: payment.occurredAt }) : null,
      requestTimeZone: readPayloadTimeZone({ value: row.payload.timeZone }),
    },
  });
  if (attached) {
    await row.update({
      transactionId: attached.transactionId,
      cardLabel,
      parsed: { ...balanceStored, attached: true } as unknown as Record<string, unknown>,
    });

    return { kind: 'logged', transactionId: attached.transactionId, attached: true };
  }

  const { transactionId } = await logIngestedPayment({
    userId,
    requestId,
    pipeline: 'notification',
    account,
    direction,
    amount: accountAmount,
    originalAmount: kept?.amount,
    originalCurrencyCode: kept?.currencyCode,
    time,
    merchant,
    payeeId,
    categoryId: historyCategoryId ?? (await getUserDefaultCategory({ id: userId })),
    externalReference: buildExternalReference({ source: row.source, idempotencyKey: row.idempotencyKey }),
    cardPayment: {
      source: row.source,
      card: payment.cardName ?? payment.cardLastDigits,
      name: null,
      merchant,
      rawAmount: `${payment.amount} ${resolved.currencyCode}`,
    },
    sourceKey: source?.sourceKey ?? null,
    slot,
    balanceAfter,
    cardLastDigits: payment.cardLastDigits,
    ...(override?.note != null && { noteOverride: override.note.trim() || null }),
  });

  await row.update({
    transactionId,
    cardLabel,
    parsed: balanceStored as unknown as Record<string, unknown>,
  });

  // A hold and its release drop each other. Inside this transaction, so the dropped row never gets a card.
  if ((await dropHoldRelease({ userId, requestId, transactionId })) === 'dropped') return { kind: 'dropped' };

  return { kind: 'logged', transactionId, attached: false };
};

/**
 * Tx 2 of a notification: resolves the account and currency, settles the payee, writes the
 * transaction through the shared logging core and links it to the request. The request stays
 * `received`; the job closes it after the AI had its short chance to categorize the row.
 *
 * Returns what the job must do: a payment that cannot be logged (`unknownAccount`, a currency the
 * user cannot use, a missing rate) comes back as a `park` for the job to record in its own
 * transaction. A request that is no longer `received`, or is already linked to a transaction, is
 * `skipped`.
 *
 * A missing rate for the row's base-currency value is thrown as a `CardPaymentRateUnavailableError`
 * (after the transaction rolled back) for the job to park; anything else passes through.
 */
export const logNotificationPayment = withTransaction(logNotificationPaymentImpl);
