import { TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';
import { logger } from '@js/utils/logger';
import Accounts from '@models/accounts.model';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { findTransactions } from '@models/transactions-query';
import { linkTransactions } from '@services/transactions/transactions-linking/link-transactions';
import { Op } from 'sequelize';

import { withdrawCoveredCorrections } from '../corrections/top-up-covers';
import { readStoredParse, type StoredParse, type StoredPayment } from '../event/stored-parse';
import { absorbParkedTwin } from '../twins/absorb-parked-twin';
import { assertUsableAccount } from '../usable-account';
import { findPastConversions, usualNote } from './conversion-history';
import { sidesOf } from './conversion-rule';
import { loadPaymentsBefore, placeConversionTime } from './conversion-timing';
import { findConversionPartner } from './find-conversion-partner';
import { resolveConversionAccount } from './resolve-conversion-account';

/** The accounts of an exchange the bank's notices point at: where the money left, where it arrived. */
export interface ConversionAccounts {
  fromAccountId: RecordId | null;
  toAccountId: RecordId | null;
}

/** The accounts at the bank for both sides of an exchange, found from the bank's accounts alone. */
export const suggestConversionAccounts = async ({
  request,
  debit,
  credit,
}: {
  request: Pick<IngestRequests, 'userId' | 'sourceId' | 'payload'>;
  debit: StoredPayment;
  credit: StoredPayment;
}): Promise<ConversionAccounts> => {
  const source = request.sourceId
    ? await NotificationSources.findOne({ where: { id: request.sourceId, userId: request.userId } })
    : null;
  const [fromAccountId, toAccountId] = await Promise.all(
    [debit, credit].map(({ currencyCode }) =>
      currencyCode
        ? resolveConversionAccount({ userId: request.userId, source, payload: request.payload, currencyCode })
        : null,
    ),
  );

  return { fromAccountId: fromAccountId ?? null, toAccountId: toAccountId ?? null };
};

/**
 * The time to book an exchange at when it differs from the arrival of its notice (see `placeConversionTime`): only an
 * exchange whose notices state no time of their own is moved, to just before the payment it paid for. `null` keeps the
 * notice's time.
 */
const placeExchange = async ({
  userId,
  debit,
  credit,
  toAccountId,
}: {
  userId: number;
  debit: StoredPayment;
  credit: { request: IngestRequests; payment: StoredPayment };
  toAccountId: RecordId;
}): Promise<Date | null> => {
  if (debit.occurredAt || credit.payment.occurredAt) return null;

  const account = await Accounts.findOne({ where: { id: toAccountId, userId }, attributes: ['currencyCode'] });
  if (!account || credit.payment.currencyCode !== account.currencyCode) return null;

  const { payload, createdAt } = credit.request;
  const receivedAt = new Date(typeof payload.time === 'string' ? payload.time : createdAt);
  const placed = placeConversionTime({
    receivedAt,
    received: Money.fromDecimal(credit.payment.amount),
    payments: await loadPaymentsBefore({ userId, accountId: toAccountId, receivedAt }),
  });

  return placed.getTime() === receivedAt.getTime() ? null : placed;
};

/**
 * The owner's yes on a card that holds an exchange: the other side joins it (a request that still waited on a card of
 * its own is closed into this one), and both sides are set up to be logged, this request's payment on `accountId` and
 * the other side's on `counterAccountId`, each defaulting to the bank's account in its currency. Nothing is learned from
 * the choice: the notice names no card of its own. The caller queues the requests; `linkConversionLegs` makes the
 * transfer once both rows are logged.
 *
 * Null when the request has no other side, or the other side moved on meanwhile: the payment is then approved on
 * its own.
 */
export const settleConversion = async ({
  userId,
  row,
  stored,
  accountId,
  counterAccountId,
  note,
}: {
  userId: number;
  row: IngestRequests;
  stored: StoredParse & { payment: StoredPayment };
  /** The account of this request's payment. */
  accountId?: RecordId;
  /** The account of the other side's payment. */
  counterAccountId?: RecordId;
  note?: string;
}): Promise<{ partnerRequestId: RecordId } | null> => {
  const partner = await findConversionPartner({ request: row, payment: stored.payment });
  if (!partner) return null;

  const partnerStored = readStoredParse({ value: partner.request.parsed });
  if (!partnerStored?.payment) return null;

  if (
    !partner.joined &&
    !(await absorbParkedTwin({ twin: partner.request, intoRequestId: row.id, reason: 'conversionLeg' }))
  ) {
    return null;
  }

  const left = { request: row, payment: stored.payment, stored };
  const right = { request: partner.request, payment: partnerStored.payment, stored: partnerStored };
  const { debit, credit } = sidesOf({ left, right });

  const suggested =
    accountId && counterAccountId
      ? null
      : await suggestConversionAccounts({ request: row, debit: debit.payment, credit: credit.payment });
  const rowIsDebit = debit.request.id === row.id;
  const fromAccountId = (rowIsDebit ? accountId : counterAccountId) ?? suggested?.fromAccountId;
  const toAccountId = (rowIsDebit ? counterAccountId : accountId) ?? suggested?.toAccountId;
  if (!fromAccountId || !toAccountId) {
    throw new ValidationError({ message: t({ key: 'ingest.conversionAccountsRequired' }) });
  }
  if (fromAccountId === toAccountId) {
    throw new ValidationError({ message: t({ key: 'ingest.conversionSameAccount' }) });
  }
  for (const id of [fromAccountId, toAccountId]) {
    await assertUsableAccount({ userId, accountId: id, message: t({ key: 'accounts.accountNotFoundForTransaction' }) });
  }

  // With no note written on the card, the exchange gets the note a business sender's message gave it, else the note of
  // the latest exchange between these accounts.
  const history = await findPastConversions({ userId, fromAccountId, toAccountId });
  const legNote = note ?? stored.exchangeNote ?? partnerStored.exchangeNote ?? usualNote({ history }) ?? undefined;

  const placedAt = await placeExchange({ userId, debit: debit.payment, credit, toAccountId });

  for (const [leg, legAccountId, otherId] of [
    [debit, fromAccountId, credit.request.id],
    [credit, toAccountId, debit.request.id],
  ] as const) {
    const parsed = {
      ...leg.stored,
      accountOverrideId: legAccountId,
      approved: true,
      conversion: { partnerRequestId: otherId },
      ...(legNote !== undefined && { noteOverride: legNote }),
      ...(placedAt && { timeOverride: placedAt.toISOString() }),
    } as unknown as Record<string, unknown>;

    if (leg.request.id === row.id) {
      await leg.request.update({ parsed });
    } else {
      // The other side is handed to the job as it is: its reading stays, its text is already gone.
      await leg.request.update({ status: 'received', reason: null, summary: null, duplicateOfId: null, parsed });
    }
  }

  return { partnerRequestId: partner.request.id };
};

/**
 * Once both sides of an approved exchange are logged, links them as one transfer between the owner's accounts and
 * confirms them (the owner approved the pair on its card). Runs after each side is logged and does nothing until
 * the other has its row; of the two jobs the later one sees both. A failure is logged and leaves two ordinary
 * rows, which the conversion suggestion still offers to link.
 */
export const linkConversionLegs = async ({ requestId }: { requestId: RecordId }): Promise<void> => {
  try {
    const request = await IngestRequests.findOne({ where: { id: requestId, pipeline: 'notification' } });
    const partnerRequestId = readStoredParse({ value: request?.parsed ?? null })?.conversion?.partnerRequestId;
    if (!request?.transactionId || !partnerRequestId) return;

    const partner = await IngestRequests.findOne({
      where: { id: partnerRequestId, userId: request.userId, pipeline: 'notification' },
    });
    if (!partner?.transactionId || partner.transactionId === request.transactionId) return;

    const rows = await findTransactions({
      planned: 'include',
      access: { accountOwner: request.userId },
      balanceAdjustments: 'exclude',
      completeness: 'all',
      where: { id: { [Op.in]: [request.transactionId, partner.transactionId] } },
    });
    const expense = rows.find((row) => row.transactionType === TRANSACTION_TYPES.expense);
    const income = rows.find((row) => row.transactionType === TRANSACTION_TYPES.income);
    if (rows.length !== 2 || !expense || !income || expense.transferId || income.transferId) return;

    await linkTransactions({ userId: request.userId, ids: [[expense.id, income.id]], announce: false });
    // The exchange may be what paid for a payment that looked short of balance.
    await withdrawCoveredCorrections({ userId: request.userId, topUp: income });
  } catch (error) {
    logger.error({ message: 'Failed to link the two sides of an exchange', error: error as Error });
  }
};
