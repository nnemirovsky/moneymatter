import {
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  PAYMENT_TYPES,
  TRANSACTION_TRANSFER_NATURE,
  TRANSACTION_TYPES,
  type CardPaymentRejectionReason,
  type RecordId,
} from '@bt/shared/types';
import { Money } from '@common/types/money';
import { ExchangeRateUnavailableError } from '@js/errors';
import Accounts from '@models/accounts.model';
import type CardAccountMappings from '@models/card-account-mappings.model';
import UsersCurrencies, { getBaseCurrency } from '@models/users-currencies.model';
import { getUserDefaultCategory } from '@models/users.model';
import { resolveVisibleCurrencies } from '@services/currencies/assert-currency-codes-visible';
import { resolvePayeeForIncomingRow } from '@services/payees/resolve-payee-for-incoming-row';
import { createTransaction } from '@services/transactions/create-transaction';

import { buildExternalReference } from './constants';
import { convertToAccountCurrency } from './convert-to-account-currency';
import type { ParsedCardPayment } from './parse-payload';
import { pickHistoryCategory } from './pick-history-category';
import { CardPaymentRateUnavailableError, formatRateDate } from './rate-unavailable-error';
import { resolveCurrency } from './resolve-currency';

/**
 * A merchant on a card payment is a deliberate merchant field, not a guess from a note, so its
 * first sighting already creates the payee.
 */
const PAYEE_PROMOTION_THRESHOLD = 1;

export type ProcessCardPaymentResult =
  | { kind: 'logged'; transactionId: RecordId }
  | { kind: 'rejected'; reason: CardPaymentRejectionReason }
  | { kind: 'unlinked' }
  | { kind: 'parked'; reason: 'rateUnavailable'; fromCurrencyCode: string; toCurrencyCode: string; date: string };

/**
 * Logs one parsed payment on the account its card is linked to, inside the caller's transaction.
 *
 * - A linked account that is gone or archived is treated like an unlinked card: the payment waits
 *   until the card is linked again.
 * - The payment's currency is resolved only now that the account's currency is known, and must be
 *   one the user can use. A payment in another currency than the account's is converted at the
 *   rate of its day; the amount as the card charged it stays on the row as the original amount.
 * - The merchant becomes a payee (found by name or alias, or created on first sight). The category
 *   is the payee's default (applied by `createTransaction`), else the payee's most frequent past
 *   category, else the user's default category.
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
}: {
  requestId: RecordId;
  userId: number;
  payment: ParsedCardPayment;
  mapping: Pick<CardAccountMappings, 'accountId'>;
}): Promise<ProcessCardPaymentResult> => {
  const account = await Accounts.findOne({
    where: { id: mapping.accountId, userId },
    attributes: ['id', 'type', 'status', 'currencyCode'],
  });
  if (!account || account.status === ACCOUNT_STATUSES.archived) return { kind: 'unlinked' };

  const heldCurrencies = await UsersCurrencies.findAll({ where: { userId }, attributes: ['currencyCode'], raw: true });
  const resolved = resolveCurrency({
    explicitCurrency: payment.explicitCurrency,
    textCode: payment.amountCurrencyCode,
    textSymbol: payment.amountSymbol,
    userCurrencyCodes: heldCurrencies.map((row) => row.currencyCode),
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

  try {
    const [transaction] = await createTransaction({
      userId,
      accountId: account.id,
      amount: accountAmount,
      originalAmount: inAccountCurrency ? undefined : paymentAmount,
      originalCurrencyCode: inAccountCurrency ? undefined : resolved.currencyCode,
      time: payment.time,
      transactionType: TRANSACTION_TYPES.expense,
      paymentType: PAYMENT_TYPES.mobilePayment,
      transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
      categoryId: historyCategoryId ?? (await getUserDefaultCategory({ id: userId })),
      payeeId: payeeId ?? undefined,
      note: payment.merchant,
      applyAutomations: true,
      isPlanned: account.type !== ACCOUNT_TYPES.system,
      externalReference: buildExternalReference({ source: payment.source, idempotencyKey: payment.idempotencyKey }),
      externalData: {
        cardPayment: {
          source: payment.source,
          card: payment.card,
          name: payment.name,
          merchant: payment.merchant,
          rawAmount: payment.rawAmount,
          requestId,
        },
      },
    });

    return { kind: 'logged', transactionId: transaction.id };
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
      date: payment.time,
    });
  }
};
