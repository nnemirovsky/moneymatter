import { TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import { getCurrencyDecimals } from '@common/lib/currency-precision';
import { Money } from '@common/types/money';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { findOneTransaction, findTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import { createInboxNotice } from '@services/chat/inbox/create-inbox-notice';
import { createSystemProposal } from '@services/chat/inbox/create-system-proposal';
import { resolveCardsElsewhere } from '@services/chat/inbox/inbox-resolution';
import { lockInbox } from '@services/chat/inbox/inbox-thread';
import { withTransaction } from '@services/common/with-transaction';
import { deleteTransaction } from '@services/transactions/delete-transaction';
import { Op, literal } from 'sequelize';

import { readUserLocale } from '../card-payment/read-user-locale';
import { describeSource } from '../event/source-label';
import { readStoredParse, type StoredPayment } from '../event/stored-parse';
import { ingestMarkersOf, isUnconfirmedIngest } from '../ingest-markers';
import { pickHoldCounterpart, type HoldCandidate, type HoldFacts } from './pick-hold-counterpart';
import { holdWindowOf } from './reversal';

/** The notice the inbox shows for a pair that was dropped; the frontend owns the text. */
const NOTICE_KEY = 'chat.notices.holdReleased';

/** The `bulk_delete_transactions` card asks whether to drop a pair whose first payment the owner confirmed. */
const DROP_BOTH_TOOL = 'bulk_delete_transactions';

type HoldReleaseOutcome = 'none' | 'dropped' | 'asked';

const formatAmount = ({
  amount,
  currencyCode,
  decimals,
  locale,
}: {
  amount: number;
  currencyCode: string;
  decimals: number;
  locale: string;
}): string => {
  let formatted: string;

  try {
    formatted = new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    formatted = amount.toFixed(decimals);
  }

  return `${formatted} ${currencyCode}`;
};

const postDroppedNotice = async ({
  userId,
  amount,
  currencyCode,
  sourceId,
  payload,
}: {
  userId: number;
  amount: number;
  currencyCode: string;
  sourceId: RecordId | null;
  payload: Record<string, unknown>;
}): Promise<void> => {
  const locale = await readUserLocale({ userId });
  const source = sourceId ? await NotificationSources.findOne({ where: { id: sourceId } }) : null;
  const decimals = await getCurrencyDecimals({ userId, code: currencyCode });

  await createInboxNotice({
    userId,
    key: NOTICE_KEY,
    params: {
      amount: formatAmount({ amount, currencyCode, decimals, locale }),
      source: describeSource({ source, payload }),
    },
  });
};

/** Every request that told of a row: the one that made it and the ones that joined it as a source. */
const requestIdsOf = ({ tx }: { tx: Transactions }): RecordId[] => {
  const markers = ingestMarkersOf({ externalData: tx.externalData });
  const ids = new Set<RecordId>([
    ...(markers.requestId ? [markers.requestId] : []),
    ...(markers.sources ?? []).map((source) => source.requestId),
  ]);

  return [...ids];
};

const directionOf = ({ tx }: { tx: Transactions }): 'debit' | 'credit' =>
  tx.transactionType === TRANSACTION_TYPES.expense ? 'debit' : 'credit';

/**
 * The merchant each row's first source printed, by row id. A notification that named none has none:
 * the row's own marker would then hold the source's name, which is not a merchant.
 */
const loadMerchants = async ({ rows }: { rows: readonly Transactions[] }): Promise<Map<string, string | null>> => {
  const primaryOf = new Map(rows.map((row) => [row.id, ingestMarkersOf({ externalData: row.externalData }).requestId]));
  const requests = await IngestRequests.findAll({
    where: { id: { [Op.in]: [...primaryOf.values()].filter((id): id is RecordId => Boolean(id)) } },
    attributes: ['id', 'pipeline', 'parsed'],
  });
  const byId = new Map(requests.map((request) => [request.id, request]));

  return new Map(
    rows.map((row) => {
      const request = byId.get(primaryOf.get(row.id) ?? ('' as RecordId));
      const fromParse = (request?.parsed as { payment?: { merchant?: unknown } } | null)?.payment?.merchant;
      const fromTap = (row.externalData as { cardPayment?: { merchant?: unknown } } | null)?.cardPayment?.merchant;
      const merchant = request?.pipeline === 'cardPayment' ? fromTap : fromParse;

      return [row.id, typeof merchant === 'string' && merchant.trim() ? merchant : null];
    }),
  );
};

const factsOfRow = ({ tx, merchant }: { tx: Transactions; merchant: string | null }): HoldFacts => ({
  direction: directionOf({ tx }),
  amount: tx.amount,
  currencyCode: tx.currencyCode,
  time: tx.time,
  accountId: tx.accountId,
  sourceId: null,
  cardLastDigits: null,
  merchant,
});

/** Closes the requests of a pair: both end `dismissed` as `holdReleased`, each pointing at the other's primary request. */
const dismissRequests = async ({
  userId,
  requestIds,
  pairedRequestId,
}: {
  userId: number;
  requestIds: readonly RecordId[];
  pairedRequestId: RecordId;
}): Promise<void> => {
  const rows = await IngestRequests.findAll({
    where: { id: { [Op.in]: [...requestIds] }, userId },
    lock: true,
  });

  for (const row of rows) {
    await row.update({
      status: 'dismissed',
      reason: 'holdReleased',
      summary: null,
      transactionId: null,
      // A notification that is dropped is not read again, so its text goes with it.
      textEnc: null,
      pairedRequestId: row.id === pairedRequestId ? null : pairedRequestId,
    });
  }
  await resolveCardsElsewhere({
    proposalIds: rows.map((row) => row.proposalId),
  });
};

/**
 * A payment that was just logged cancels out the opposite one that came a moment before it (a card
 * hold and its release): both rows were only "logged now, confirm later", so both go, their requests
 * end `dismissed` as `holdReleased`, their cards close and the inbox gets one informational line.
 *
 * - Only unconfirmed ingest rows are dropped. When the nearest opposite payment is one the owner
 *   confirmed already, nothing is deleted: the inbox gets one card asking whether to drop both, and
 *   rejecting it keeps both as a refund.
 * - Runs inside the logging transaction, so the new row never gets a card or a push of its own when it
 *   is dropped, and under the inbox lock, so two halves of a pair processed together cannot both miss
 *   the other.
 */
export const dropHoldRelease = withTransaction(
  async ({
    userId,
    requestId,
    transactionId,
  }: {
    userId: number;
    requestId: RecordId;
    transactionId: RecordId;
  }): Promise<HoldReleaseOutcome> => {
    await lockInbox({ userId });

    const request = await IngestRequests.findOne({
      where: { id: requestId, userId },
      lock: true,
    });
    if (!request) return 'none';
    if (request.status === 'dismissed' && request.reason === 'holdReleased') return 'dropped';

    const tx = await findOneTransaction({
      where: { id: transactionId },
      planned: 'include',
      access: { accountOwner: userId },
      balanceAdjustments: 'exclude',
      lock: true,
    });
    if (!tx || tx.transferId || !isUnconfirmedIngest({ externalData: tx.externalData })) return 'none';

    const merchants = await loadMerchants({ rows: [tx] });
    const incoming = factsOfRow({ tx, merchant: merchants.get(tx.id) ?? null });
    const windowMs = holdWindowOf({ textEnc: request.textEnc });
    const rows = await findTransactions({
      planned: 'include',
      access: { accountOwner: userId },
      balanceAdjustments: 'exclude',
      transfers: 'exclude',
      completeness: 'all',
      where: {
        id: { [Op.ne]: tx.id },
        accountId: tx.accountId,
        transactionType: incoming.direction === 'debit' ? TRANSACTION_TYPES.income : TRANSACTION_TYPES.expense,
        time: {
          [Op.gte]: new Date(tx.time.getTime() - windowMs),
          [Op.lte]: new Date(tx.time.getTime() + windowMs),
        },
        [Op.and]: literal(`("Transactions"."externalData"->'ingest') IS NOT NULL`),
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const candidateMerchants = await loadMerchants({ rows });
    const toCandidates = (list: readonly Transactions[]): HoldCandidate[] =>
      list.map((row) => ({
        ...factsOfRow({ tx: row, merchant: candidateMerchants.get(row.id) ?? null }),
        id: row.id,
      }));

    const unconfirmed = pickHoldCounterpart({
      incoming,
      candidates: toCandidates(rows.filter((row) => isUnconfirmedIngest({ externalData: row.externalData }))),
      windowMs,
    });

    if (unconfirmed) {
      const hold = byId.get(unconfirmed.id as RecordId)!;
      const holdPrimary = ingestMarkersOf({ externalData: hold.externalData }).requestId ?? requestId;

      await dismissRequests({
        userId,
        requestIds: requestIdsOf({ tx }),
        pairedRequestId: holdPrimary,
      });
      await dismissRequests({
        userId,
        requestIds: requestIdsOf({ tx: hold }),
        pairedRequestId: requestId,
      });
      await deleteTransaction({ id: hold.id, userId });
      await deleteTransaction({ id: tx.id, userId });
      await postDroppedNotice({
        userId,
        amount: tx.amount.toNumber(),
        currencyCode: tx.currencyCode,
        sourceId: request.sourceId,
        payload: request.payload,
      });

      return 'dropped';
    }

    const confirmed = pickHoldCounterpart({
      incoming,
      candidates: toCandidates(rows),
      windowMs,
    });
    if (confirmed) {
      await createSystemProposal({
        userId,
        toolName: DROP_BOTH_TOOL,
        args: { transactionIds: [confirmed.id, tx.id] },
      });

      return 'asked';
    }

    return 'none';
  },
);

const factsOfParkedPayment = ({
  payment,
  sourceId,
  time,
}: {
  payment: StoredPayment;
  sourceId: RecordId | null;
  time: Date;
}): HoldFacts => ({
  direction: payment.kind === 'credit' ? 'credit' : 'debit',
  amount: Money.fromDecimal(payment.amount),
  currencyCode: payment.currencyCode,
  time,
  accountId: null,
  sourceId,
  cardLastDigits: payment.cardLastDigits,
  merchant: payment.merchant,
});

const timeOfRequest = ({ request }: { request: IngestRequests }): Date =>
  new Date(typeof request.payload.time === 'string' ? request.payload.time : request.createdAt);

/**
 * The same rule for payments that wait for an account: a notification about to be parked as
 * `unknownAccount` cancels out a parked one of the opposite direction from the same source (same card
 * digits, or the same currency when neither names digits). Both requests end `dismissed` as
 * `holdReleased` and their cards close. Called before the park, so the dropped notification never gets
 * a card.
 */
export const dropParkedHoldRelease = withTransaction(
  async ({
    userId,
    requestId,
    payment,
  }: {
    userId: number;
    requestId: RecordId;
    payment: StoredPayment;
  }): Promise<boolean> => {
    await lockInbox({ userId });

    const request = await IngestRequests.findOne({
      where: { id: requestId, userId },
      lock: true,
    });
    if (!request || request.status !== 'received' || !request.sourceId) return false;

    const incoming = factsOfParkedPayment({
      payment,
      sourceId: request.sourceId,
      time: timeOfRequest({ request }),
    });
    const parked = await IngestRequests.findAll({
      where: {
        userId,
        pipeline: 'notification',
        status: 'parked',
        reason: 'unknownAccount',
        sourceId: request.sourceId,
        id: { [Op.ne]: request.id },
      },
      lock: true,
    });

    const candidates: HoldCandidate[] = [];
    for (const row of parked) {
      const stored = readStoredParse({ value: row.parsed })?.payment;
      if (stored) {
        candidates.push({
          ...factsOfParkedPayment({
            payment: stored,
            sourceId: row.sourceId,
            time: timeOfRequest({ request: row }),
          }),
          id: row.id,
        });
      }
    }

    const match = pickHoldCounterpart({ incoming, candidates, windowMs: holdWindowOf({ textEnc: request.textEnc }) });
    if (!match) return false;

    await dismissRequests({
      userId,
      requestIds: [match.id as RecordId],
      pairedRequestId: request.id,
    });
    await dismissRequests({
      userId,
      requestIds: [request.id],
      pairedRequestId: match.id as RecordId,
    });
    await postDroppedNotice({
      userId,
      amount: Money.fromDecimal(payment.amount).toNumber(),
      currencyCode: payment.currencyCode ?? '',
      sourceId: request.sourceId,
      payload: request.payload,
    });

    return true;
  },
);
