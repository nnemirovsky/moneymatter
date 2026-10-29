import { TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { logger } from '@js/utils/logger';
import { findTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import { Op, literal } from 'sequelize';

import { ingestMarkersOf } from '../ingest-markers';
import { dismissCorrection } from './apply-correction';

/**
 * How far from a payment an incoming transfer to its account counts as the top-up that paid for it. A bank takes the
 * payment at once, and the transfer that tops the balance up (a conversion, a move between accounts) is booked a few
 * minutes before or after.
 */
export const TOP_UP_WINDOW_MS = 10 * 60_000;

/** The transfers into `accountId` landed within the top-up window of `time`, newest first. */
export const findTopUps = async ({
  userId,
  accountId,
  time,
}: {
  userId: number;
  accountId: RecordId;
  time: Date;
}): Promise<Transactions[]> =>
  findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: 'all',
    order: [['time', 'DESC']],
    where: {
      accountId,
      transactionType: TRANSACTION_TYPES.income,
      time: {
        [Op.between]: [new Date(time.getTime() - TOP_UP_WINDOW_MS), new Date(time.getTime() + TOP_UP_WINDOW_MS)],
      },
      // A transfer leg: linked to another row.
      transferId: { [Op.ne]: null },
    },
  });

/** Whether the balance the account held before the payment, with the top-ups that landed around it, covers the payment. */
export const isCoveredByTopUps = ({
  balanceBefore,
  amount,
  topUps,
}: {
  balanceBefore: Money;
  amount: Money;
  topUps: readonly Transactions[];
}): boolean => topUps.length > 0 && topUps.reduce((sum, topUp) => sum.add(topUp.amount), balanceBefore).gte(amount);

/**
 * A transfer into an account landed: the open short-balance suggestions of payments logged on that account around the
 * same time are withdrawn when the balance with the transfer covers the payment, because the bank paid from that
 * account and the suggestion to move the payment to another one would be wrong. A failure is logged.
 */
export const withdrawCoveredCorrections = async ({
  userId,
  topUp,
}: {
  userId: number;
  topUp: Transactions;
}): Promise<number> => {
  try {
    const payments = await findTransactions({
      planned: 'include',
      access: { accountOwner: userId },
      balanceAdjustments: 'exclude',
      completeness: 'all',
      where: {
        accountId: topUp.accountId,
        transactionType: TRANSACTION_TYPES.expense,
        time: {
          [Op.between]: [
            new Date(topUp.time.getTime() - TOP_UP_WINDOW_MS),
            new Date(topUp.time.getTime() + TOP_UP_WINDOW_MS),
          ],
        },
        [Op.and]: literal(`("Transactions"."externalData" #>> '{ingest,correction,status}') = 'open'`),
      },
    });
    let withdrawn = 0;
    for (const payment of payments) {
      const { balanceBefore } = ingestMarkersOf({ externalData: payment.externalData });
      if (!balanceBefore) continue;

      const topUps = await findTopUps({ userId, accountId: payment.accountId, time: payment.time });
      if (
        !isCoveredByTopUps({ balanceBefore: Money.fromDecimal(balanceBefore.amount), amount: payment.amount, topUps })
      ) {
        continue;
      }

      await dismissCorrection({ userId, transactionId: payment.id });
      withdrawn += 1;
    }

    return withdrawn;
  } catch (error) {
    logger.error({ message: 'Failed to withdraw a short-balance suggestion the top-up covers', error: error as Error });

    return 0;
  }
};
