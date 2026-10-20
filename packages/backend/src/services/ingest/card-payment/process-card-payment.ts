import { ACCOUNT_STATUSES, type CardPaymentRejectionReason, type RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import Accounts from '@models/accounts.model';
import type CardAccountMappings from '@models/card-account-mappings.model';
import { getUserDefaultCategory } from '@models/users.model';
import { resolveVisibleCurrencies } from '@services/currencies/assert-currency-codes-visible';
import { resolvePayeeForIncomingRow } from '@services/payees/resolve-payee-for-incoming-row';

import { attachToExistingPayment } from '../dedup/attach-to-existing-payment';
import { TAP_SLOT } from '../dedup/source-slots';
import { logIngestedPayment } from '../log-ingested-payment';
import { buildExternalReference } from './constants';
import { convertToAccountCurrency } from './convert-to-account-currency';
import type { ParsedCardPayment } from './parse-payload';
import { pickHistoryCategory } from './pick-history-category';
import { formatRateDate } from './rate-unavailable-error';
import { resolveCurrency } from './resolve-currency';

/**
 * A merchant on a card payment is a deliberate merchant field, not a guess from a note, so its
 * first sighting already creates the payee.
 */
const PAYEE_PROMOTION_THRESHOLD = 1;

type ProcessCardPaymentResult =
  | { kind: 'logged'; transactionId: RecordId }
  | { kind: 'attached'; transactionId: RecordId }
  | { kind: 'rejected'; reason: CardPaymentRejectionReason }
  | { kind: 'unlinked' }
  | { kind: 'parked'; reason: 'rateUnavailable'; fromCurrencyCode: string; toCurrencyCode: string; date: string };

/**
 * Logs one parsed payment on the account its card is linked to, inside the caller's transaction.
 *
 * - A linked account that is gone or archived is treated like an unlinked card: the payment waits
 *   until the card is linked again. The caller picks `mapping` by the payment's currency (the row of
 *   that currency, else the card's default), so the account is already the right one for it.
 * - The payment's currency is resolved only now that the account's currency is known, and must be
 *   one the user can use. A payment in another currency than the account's is converted at the
 *   rate of its day; the amount as the card charged it stays on the row as the original amount.
 * - The merchant becomes a payee (found by name or alias, or created on first sight). The category
 *   is the payee's default (applied by `createTransaction`), else the payee's most frequent past
 *   category, else the user's default category.
 * - A payment another source already logged (the Wallet notification of the same payment, a bank
 *   push) is not logged twice: the tap joins that row (`attached`) and enriches it.
 * - On a bank-connected account the row is planned, the only kind of manual row such an account
 *   accepts; the bank sync later settles it.
 *
 * A missing exchange rate is a returned `parked` outcome for the payment conversion. For the rate
 * `createTransaction` needs to value the row in the base currency it throws, as a
 * `CardPaymentRateUnavailableError` naming the pair, so the caller can park the request. Anything
 * else `createTransaction` throws passes through unchanged.
 */
export const processCardPayment = async ({
  requestId,
  userId,
  payment,
  mapping,
  userCurrencyCodes,
}: {
  requestId: RecordId;
  userId: number;
  payment: ParsedCardPayment;
  mapping: Pick<CardAccountMappings, 'accountId'>;
  /** The currencies the user holds, which narrow down a shared symbol such as `$`. */
  userCurrencyCodes: readonly string[];
}): Promise<ProcessCardPaymentResult> => {
  const account = await Accounts.findOne({
    where: { id: mapping.accountId, userId },
    attributes: ['id', 'type', 'status', 'currencyCode'],
  });
  if (!account || account.status === ACCOUNT_STATUSES.archived) return { kind: 'unlinked' };

  const resolved = resolveCurrency({
    explicitCurrency: payment.explicitCurrency,
    textCode: payment.amountCurrencyCode,
    textSymbol: payment.amountSymbol,
    userCurrencyCodes,
    accountCurrencyCode: account.currencyCode,
  });
  if (!resolved.ok) return { kind: 'rejected', reason: resolved.reason };

  const { rejected } = await resolveVisibleCurrencies({ userId, codes: [resolved.currencyCode] });
  if (rejected.length) return { kind: 'rejected', reason: 'invalidCurrency' };

  const paymentAmount = Money.fromDecimal(payment.amount);
  const inAccountCurrency = resolved.currencyCode === account.currencyCode;
  let accountAmount = paymentAmount;

  if (!inAccountCurrency) {
    const converted = await convertToAccountCurrency({
      ownerUserId: userId,
      amount: paymentAmount,
      from: resolved.currencyCode,
      to: account.currencyCode,
      date: payment.time,
    });
    if ('parked' in converted) {
      return {
        kind: 'parked',
        reason: converted.parked,
        fromCurrencyCode: resolved.currencyCode,
        toCurrencyCode: account.currencyCode,
        date: formatRateDate({ date: payment.time }),
      };
    }

    accountAmount = converted.amount;
  }

  const payeeId = await resolvePayeeForIncomingRow({
    ownerUserId: userId,
    rawMerchantName: payment.merchant,
    failureLogMessage: 'Failed to resolve the payee of a card payment; continuing without link',
    logContext: { requestId },
    promotionThreshold: PAYEE_PROMOTION_THRESHOLD,
  });
  const historyCategoryId = payeeId
    ? await pickHistoryCategory({ ownerUserId: userId, payeeId, asOf: payment.time })
    : null;

  const attached = await attachToExistingPayment({
    userId,
    payment: {
      requestId,
      pipeline: 'cardPayment',
      account,
      direction: 'debit',
      time: payment.time,
      slot: TAP_SLOT,
      stage: null,
      sourceKey: null,
      fromBank: false,
      statedAmount: paymentAmount,
      statedCurrencyCode: resolved.currencyCode,
      originalAmount: null,
      originalCurrencyCode: null,
      merchant: payment.merchant,
      payeeId,
      cardLabel: payment.card,
      cardLastDigits: null,
      balanceAfter: null,
      bankWallClock: null,
    },
  });
  if (attached) return { kind: 'attached', transactionId: attached.transactionId };

  const { transactionId } = await logIngestedPayment({
    userId,
    requestId,
    pipeline: 'cardPayment',
    account,
    direction: 'debit',
    amount: accountAmount,
    originalAmount: inAccountCurrency ? undefined : paymentAmount,
    originalCurrencyCode: inAccountCurrency ? undefined : resolved.currencyCode,
    time: payment.time,
    merchant: payment.merchant,
    payeeId,
    categoryId: historyCategoryId ?? (await getUserDefaultCategory({ id: userId })),
    externalReference: buildExternalReference({ source: payment.source, idempotencyKey: payment.idempotencyKey }),
    slot: TAP_SLOT,
    cardPayment: {
      source: payment.source,
      card: payment.card,
      name: payment.name,
      merchant: payment.merchant,
      rawAmount: payment.rawAmount,
    },
  });

  return { kind: 'logged', transactionId };
};
