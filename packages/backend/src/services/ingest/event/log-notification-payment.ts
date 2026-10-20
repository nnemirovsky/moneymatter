import type { RecordId } from '@bt/shared/types';
import { getCurrencyDecimals } from '@common/lib/currency-precision';
import { Money } from '@common/types/money';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import UsersCurrencies from '@models/users-currencies.model';
import { getUserDefaultCategory } from '@models/users.model';
import { withTransaction } from '@services/common/with-transaction';
import { resolveVisibleCurrencies } from '@services/currencies/assert-currency-codes-visible';

import { buildExternalReference } from '../card-payment/constants';
import { convertToAccountCurrency } from '../card-payment/convert-to-account-currency';
import { formatSummary, type SummaryAmount } from '../card-payment/format-summary';
import { pickHistoryCategory } from '../card-payment/pick-history-category';
import { formatRateDate } from '../card-payment/rate-unavailable-error';
import { resolveCurrency, resolveStatedCurrency } from '../card-payment/resolve-currency';
import { logIngestedPayment } from '../log-ingested-payment';
import { applyPayeeChoice } from './apply-payee-choice';
import { resolveBalanceAuthority } from './balance-authority';
import type { ParsedPayment } from './classify-notification';
import { loadSiblingBalances } from './load-sibling-balances';
import { guessNotificationAccount, resolveNotificationAccount } from './resolve-notification-account';
import { describeSource } from './source-label';
import { toStoredPayment, type StoredParse } from './stored-parse';

/** What the job should do after the logging transaction. */
type LogNotificationResult =
  | { kind: 'logged'; transactionId: RecordId }
  | {
      kind: 'park';
      reason: 'unknownAccount' | 'lowConfidence' | 'rateUnavailable';
      summary: string;
      parsed: StoredParse;
      cardLabel: string | null;
    }
  | { kind: 'skipped' };

const amountOf = async ({
  userId,
  amount,
  currencyCode,
}: {
  userId: number;
  amount: string;
  currencyCode: string;
}): Promise<SummaryAmount> => {
  let decimals = 2;
  try {
    decimals = await getCurrencyDecimals({ userId, code: currencyCode });
  } catch {
    // A code the user cannot price keeps the common two decimals in the line that names it.
  }

  return { amount: Number(amount), currencyCode, decimals };
};

const logNotificationPaymentImpl = async ({
  requestId,
  payment,
  symbol,
  parser,
  kind,
  confidence,
  source,
  locale,
}: {
  requestId: RecordId;
  payment: ParsedPayment;
  symbol: string | null;
  parser: 'wallet' | 'ai';
  kind: string;
  confidence: number;
  source: NotificationSources | null;
  locale: string;
}): Promise<LogNotificationResult> => {
  const row = await IngestRequests.findOne({ where: { id: requestId }, lock: true });
  if (!row || row.status !== 'received' || row.transactionId) return { kind: 'skipped' };

  const userId = row.userId;
  const base: StoredParse = { parser, kind, confidence, payment: toStoredPayment({ payment }), symbol };
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
    summary: formatSummary({
      summary: {
        type: 'notificationParked',
        reason: 'needsOk',
        payment: statedCurrencyCode
          ? await amountOf({ userId, amount: payment.amount, currencyCode: statedCurrencyCode })
          : null,
        merchant: payment.merchant,
        source: sourceLabel,
      },
      locale,
    }),
  });

  const found = await resolveNotificationAccount({
    userId,
    cardName: payment.cardName,
    cardLastDigits: payment.cardLastDigits,
    currencyCode: statedCurrencyCode,
    source,
  });
  if (!found) {
    return needsOk({
      reason: 'unknownAccount',
      extra: { accountGuessId: await guessNotificationAccount({ userId, currencyCode: statedCurrencyCode }) },
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

  const { transactionId } = await logIngestedPayment({
    userId,
    requestId,
    pipeline: 'notification',
    account,
    direction: payment.kind,
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
    balanceAfter,
  });

  await row.update({
    transactionId,
    cardLabel,
    parsed: { ...base, balanceAfter } as unknown as Record<string, unknown>,
  });

  return { kind: 'logged', transactionId };
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
