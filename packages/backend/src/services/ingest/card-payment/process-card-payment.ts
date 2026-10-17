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
import Accounts from '@models/accounts.model';
import type CardAccountMappings from '@models/card-account-mappings.model';
import UsersCurrencies from '@models/users-currencies.model';
import { getUserDefaultCategory } from '@models/users.model';
import { resolveVisibleCurrencies } from '@services/currencies/assert-currency-codes-visible';
import { createTransaction } from '@services/transactions/create-transaction';

import { buildExternalReference } from './constants';
import type { ParsedCardPayment } from './parse-payload';
import { resolveCurrency } from './resolve-currency';

export type ProcessCardPaymentResult =
  | { kind: 'logged'; transactionId: RecordId }
  | { kind: 'rejected'; reason: CardPaymentRejectionReason }
  | { kind: 'unlinked' }
  | { kind: 'parked'; reason: 'processingFailed' };

/**
 * Logs one parsed payment on the account its card is linked to, inside the caller's transaction.
 *
 * - A linked account that is gone or archived is treated like an unlinked card: the payment waits
 *   until the card is linked again.
 * - The payment's currency is resolved only now that the account's currency is known, and must be
 *   one the user can use.
 * - On a bank-connected account the row is planned, the only kind of manual row such an account
 *   accepts; the bank sync later settles it.
 * - A payment in another currency than the account's waits as `processingFailed` until it can be
 *   converted.
 *
 * Throws what `createTransaction` throws, an `ExchangeRateUnavailableError` among them, so the
 * caller can park the request.
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

  if (resolved.currencyCode !== account.currencyCode) return { kind: 'parked', reason: 'processingFailed' };

  const [transaction] = await createTransaction({
    userId,
    accountId: account.id,
    amount: Money.fromDecimal(payment.amount),
    time: payment.time,
    transactionType: TRANSACTION_TYPES.expense,
    paymentType: PAYMENT_TYPES.mobilePayment,
    transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
    categoryId: await getUserDefaultCategory({ id: userId }),
    note: payment.merchant,
    rawMerchantName: payment.merchant,
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
};
