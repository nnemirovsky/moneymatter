import { TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { logger } from '@js/utils/logger';
import IngestRequests from '@models/ingest-requests.model';
import { findTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import { withTransaction } from '@services/common/with-transaction';
import { subDays } from 'date-fns';
import { Op } from 'sequelize';

import { readStoredParse, type StoredPayment } from '../event/stored-parse';
import { findJoinedConversionLeg } from './find-conversion-partner';
import { absorbLockedRequest } from './lock-request';

/** How far a notification's received time may be from the transfer it tells of. */
const MATCH_WINDOW_MS = 24 * 60 * 60_000;
const LOOKBACK_DAYS = 3;
const WAITING_LIMIT = 100;
/** The park reasons whose payment the owner would otherwise log by hand. */
const SETTLEABLE_REASONS = ['ownTransfer', 'unknownAccount', 'lowConfidence', 'unverifiedParse'];

const timeOf = ({ request }: { request: IngestRequests }): Date =>
  new Date(typeof request.payload.time === 'string' ? request.payload.time : request.createdAt);

const sameFigure = ({ payment, leg }: { payment: StoredPayment | undefined; leg: Transactions }): boolean =>
  Boolean(payment) &&
  payment!.currencyCode === leg.currencyCode &&
  Money.fromDecimal(payment!.amount).equals(leg.amount);

/**
 * A transfer between the user's accounts was logged or linked somewhere else (chat, the app, an import). A notification
 * that waits for the owner and tells of that same transfer is settled by it, and its card closes:
 *
 * - an exchange card (a request with the other side joined) when both amounts and currencies equal the two legs;
 * - a payment parked as an own transfer when its amount and currency equal the leg it tells of.
 *
 * Both are matched within a day of the transfer's time. Nothing else is touched. Returns how many requests were settled.
 */
const resolveImpl = async ({
  userId,
  transactionIds,
}: {
  userId: number;
  transactionIds: readonly RecordId[];
}): Promise<number> => {
  const legs = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: 'all',
    where: { id: { [Op.in]: [...transactionIds] } },
  });
  const expense = legs.find((leg) => leg.transactionType === TRANSACTION_TYPES.expense);
  const income = legs.find((leg) => leg.transactionType === TRANSACTION_TYPES.income);
  if (!expense || !income) return 0;

  const waiting = await IngestRequests.findAll({
    where: {
      userId,
      pipeline: 'notification',
      status: 'parked',
      reason: { [Op.in]: SETTLEABLE_REASONS },
      createdAt: { [Op.gte]: subDays(expense.time, LOOKBACK_DAYS) },
    },
    order: [['createdAt', 'ASC']],
    limit: WAITING_LIMIT,
  });

  let settled = 0;
  for (const request of waiting) {
    if (Math.abs(timeOf({ request }).getTime() - expense.time.getTime()) > MATCH_WINDOW_MS) continue;

    const payment = readStoredParse({ value: request.parsed })?.payment;
    const joined = await findJoinedConversionLeg({ userId, requestId: request.id });
    const other = joined ? readStoredParse({ value: joined.parsed })?.payment : undefined;

    const isExchange = joined
      ? payment?.kind === 'debit'
        ? sameFigure({ payment, leg: expense }) && sameFigure({ payment: other, leg: income })
        : sameFigure({ payment: other, leg: expense }) && sameFigure({ payment, leg: income })
      : false;
    const isOwnTransfer =
      !joined &&
      request.reason === 'ownTransfer' &&
      (payment?.kind === 'debit' ? sameFigure({ payment, leg: expense }) : sameFigure({ payment, leg: income }));
    if (!isExchange && !isOwnTransfer) continue;

    if (await absorbLockedRequest({ request })) settled += 1;
  }

  return settled;
};

export const resolveParkedByTransfer = withTransaction(resolveImpl);

/** Runs `resolveParkedByTransfer` where a failure must never reach the transfer that was logged. */
export const settleParkedForTransfer = async ({
  userId,
  transactionIds,
}: {
  userId: number;
  transactionIds: readonly RecordId[];
}): Promise<void> => {
  try {
    await resolveParkedByTransfer({ userId, transactionIds });
  } catch (error) {
    logger.error({ message: 'Failed to settle the waiting notifications of a transfer', error: error as Error });
  }
};
