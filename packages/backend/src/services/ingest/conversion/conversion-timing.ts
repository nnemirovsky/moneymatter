import { TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { findTransactions } from '@models/transactions-query';
import { Op } from 'sequelize';

import { ingestMarkersOf } from '../ingest-markers';

/** How long after a payment a conversion notice may arrive and still be the one that paid for it. */
export const PAYMENT_LOOKBACK_MS = 5 * 60_000;

/** How long before the payment the conversion is placed. */
export const BEFORE_PAYMENT_MS = 60_000;

/** A payment on the account the exchange topped up, as far as the ordering needs it. */
export interface PaymentOnAccount {
  time: Date;
  amount: Money;
  /** What the account held before the payment; `null` when the payment did not record it. */
  balanceBefore: Money | null;
}

/**
 * When a currency exchange that states no time of its own is booked. A bank's notice of the exchange can arrive after the
 * notice of the payment it paid for (the owner tops the account up to pay), so the notice's arrival time would put the
 * exchange after the payment. The exchange is placed a minute before the earliest payment on its destination account
 * that:
 *
 * - arrived no more than `PAYMENT_LOOKBACK_MS` before the exchange's notice;
 * - looked short of balance (the account held less than the payment took);
 * - is covered by the exchange (the balance before it plus the amount received reaches the payment).
 *
 * Any other exchange keeps the time its notice arrived at.
 */
export const placeConversionTime = ({
  receivedAt,
  received,
  payments,
}: {
  receivedAt: Date;
  /** The amount that arrived on the destination account, in that account's currency. */
  received: Money;
  payments: readonly PaymentOnAccount[];
}): Date => {
  const paidFor = payments
    .filter((payment) => {
      const age = receivedAt.getTime() - payment.time.getTime();
      if (age < 0 || age > PAYMENT_LOOKBACK_MS || !payment.balanceBefore) return false;

      return payment.balanceBefore.lessThan(payment.amount) && payment.balanceBefore.add(received).gte(payment.amount);
    })
    .sort((left, right) => left.time.getTime() - right.time.getTime())[0];

  return paidFor ? new Date(paidFor.time.getTime() - BEFORE_PAYMENT_MS) : receivedAt;
};

/** The payments logged on the account shortly before `receivedAt`, with the balance each recorded. */
export const loadPaymentsBefore = async ({
  userId,
  accountId,
  receivedAt,
}: {
  userId: number;
  accountId: RecordId;
  receivedAt: Date;
}): Promise<PaymentOnAccount[]> => {
  const rows = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: 'all',
    where: {
      accountId,
      transactionType: TRANSACTION_TYPES.expense,
      time: { [Op.between]: [new Date(receivedAt.getTime() - PAYMENT_LOOKBACK_MS), receivedAt] },
    },
  });

  return rows.map((row) => {
    const { balanceBefore } = ingestMarkersOf({ externalData: row.externalData });

    return {
      time: row.time,
      amount: row.amount,
      balanceBefore: balanceBefore ? Money.fromDecimal(balanceBefore.amount) : null,
    };
  });
};
