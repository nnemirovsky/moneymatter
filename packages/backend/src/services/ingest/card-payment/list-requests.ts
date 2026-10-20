import {
  CARD_PAYMENT_RECENT_REQUESTS_LIMIT,
  PLANNED_MATCH_WINDOW_DAYS,
  type CardPaymentRequestDto,
  type CardPaymentRequestView,
  type IngestRequestReason,
  type UnconfirmedCardPaymentDto,
  type UnlinkedCardDto,
  normalizeCardLabel,
} from '@bt/shared/types';
import CardAccountMappings from '@models/card-account-mappings.model';
import IngestRequests from '@models/ingest-requests.model';
import { findTransactions } from '@models/transactions-query';
import { subDays } from 'date-fns';
import { Op, literal } from 'sequelize';

import { correctionOf, transferSuggestionOf } from '../corrections/read-ingest-suggestions';
import { notificationTimings } from '../event/constants';
import { readStoredParse } from '../event/stored-parse';
import { cardPaymentTimings } from './constants';
import { readPayloadTime } from './parse-payload';
import { isWaitingRequest } from './process-ingest-request';

/** The waiting list is bounded so a long-neglected backlog cannot grow the response without limit. */
const WAITING_REQUESTS_LIMIT = 200;
const UNCONFIRMED_PAYMENTS_LIMIT = 200;

const asText = ({ value }: { value: unknown }): string | null => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  return null;
};

/**
 * What the list shows of a request. A tap's payload holds what the shortcut sent; a notification's
 * holds no text, so its merchant and amount come from the payment that was read, when one was.
 */
const readShownPayment = ({ row }: { row: IngestRequests }): { merchant: string | null; amountText: string | null } => {
  if (row.pipeline !== 'notification') {
    return { merchant: asText({ value: row.payload.merchant }), amountText: asText({ value: row.payload.amount }) };
  }

  const payment = readStoredParse({ value: row.parsed })?.payment;
  if (!payment) return { merchant: null, amountText: null };

  return {
    merchant: payment.merchant,
    amountText: [payment.amount, payment.currencyCode].filter(Boolean).join(' '),
  };
};

const toRequestDto = ({ row, now }: { row: IngestRequests; now: Date }): CardPaymentRequestDto => {
  // A `received` request that outlived its processing pass reads as interrupted.
  const interrupted = row.status === 'received' && isWaitingRequest({ row, now });

  return {
    id: row.id,
    status: row.status,
    reason: interrupted ? 'interrupted' : ((row.reason as IngestRequestReason | null) ?? null),
    summary: row.summary,
    cardLabel: row.cardLabel,
    ...readShownPayment({ row }),
    time: readPayloadTime({ value: row.payload.time, fallback: row.createdAt }),
    transactionId: row.transactionId,
    createdAt: row.createdAt.toISOString(),
  };
};

/**
 * The user's card-payment requests.
 *
 * - `parked`: the payments waiting for the user, parked or left `received` by a lost pass;
 * - `recent`: the latest requests of every status.
 *
 * Newest first in both.
 */
export const listCardPaymentRequests = async ({
  userId,
  view,
}: {
  userId: number;
  view: CardPaymentRequestView;
}): Promise<CardPaymentRequestDto[]> => {
  const now = new Date();

  const rows = await IngestRequests.findAll({
    where:
      view === 'recent'
        ? { userId }
        : {
            userId,
            [Op.or]: [
              { status: 'parked' },
              {
                status: 'received',
                pipeline: 'cardPayment',
                createdAt: { [Op.lt]: new Date(now.getTime() - cardPaymentTimings.interruptedAfterMs) },
              },
              {
                status: 'received',
                pipeline: 'notification',
                updatedAt: { [Op.lt]: new Date(now.getTime() - notificationTimings.interruptedAfterMs) },
              },
            ],
          },
    order: [['createdAt', 'DESC']],
    limit: view === 'recent' ? CARD_PAYMENT_RECENT_REQUESTS_LIMIT : WAITING_REQUESTS_LIMIT,
  });

  return rows.map((row) => toRequestDto({ row, now }));
};

/**
 * Card labels payments are waiting on, with how many. Labels that differ only in case or spacing
 * count as one card, and a card that has been linked since is left out: its payments need a retry,
 * not a link. A card counts as linked once it has a default row; one with only currency rows still
 * needs a default for the payments in its other currencies.
 */
export const listUnlinkedCards = async ({ userId }: { userId: number }): Promise<UnlinkedCardDto[]> => {
  const [waiting, mappings] = await Promise.all([
    IngestRequests.findAll({
      where: { userId, status: 'parked', reason: 'unknownCard', cardLabel: { [Op.ne]: null } },
      attributes: ['cardLabel'],
      order: [['createdAt', 'DESC']],
    }),
    CardAccountMappings.findAll({ where: { userId, currencyCode: null }, attributes: ['normalizedLabel'] }),
  ]);
  const linked = new Set(mappings.map((mapping) => mapping.normalizedLabel));

  const cards = new Map<string, UnlinkedCardDto>();
  for (const { cardLabel } of waiting) {
    if (!cardLabel) continue;

    const key = normalizeCardLabel({ label: cardLabel });
    if (linked.has(key)) continue;

    // Newest first, so the label shown is the latest spelling.
    const card = cards.get(key);
    if (card) {
      card.count += 1;
    } else {
      cards.set(key, { cardLabel, count: 1 });
    }
  }

  return [...cards.values()].toSorted((a, b) => b.count - a.count || a.cardLabel.localeCompare(b.cardLabel));
};

/**
 * The rows the ingest logged that nobody confirmed yet:
 *
 * - `awaitingConfirmation`: every row an automated payment wrote and the owner has not confirmed in
 *   the Automation inbox (`externalData.ingest.unconfirmed`), whatever the account type or age;
 * - `bankUnconfirmed`: card-payment plans the bank did not confirm within the match window. A booking
 *   can no longer settle them, so the user decides whether to delete the plan (the booked row
 *   already exists) or keep it. Plans the user wrote never appear.
 *
 * A row in both groups is listed once, oldest first.
 */
export const listUnconfirmedCardPayments = async ({
  userId,
}: {
  userId: number;
}): Promise<UnconfirmedCardPaymentDto[]> => {
  const [awaiting, stalePlans] = await Promise.all([
    findTransactions({
      planned: 'include',
      access: { accountOwner: userId },
      balanceAdjustments: 'exclude',
      completeness: { cap: { limit: UNCONFIRMED_PAYMENTS_LIMIT, onTruncated: 'log', context: { userId } } },
      where: { [Op.and]: literal(`("Transactions"."externalData"->'ingest'->>'unconfirmed') = 'true'`) },
      order: [['time', 'ASC']],
    }),
    findTransactions({
      planned: 'only',
      access: { accountOwner: userId },
      balanceAdjustments: 'exclude',
      completeness: { cap: { limit: UNCONFIRMED_PAYMENTS_LIMIT, onTruncated: 'log', context: { userId } } },
      where: {
        time: { [Op.lt]: subDays(new Date(), PLANNED_MATCH_WINDOW_DAYS) },
        [Op.and]: literal(`("Transactions"."externalData"->'cardPayment') IS NOT NULL`),
      },
      order: [['time', 'ASC']],
    }),
  ]);

  const awaitingIds = new Set(awaiting.map((row) => row.id));
  const staleIds = new Set(stalePlans.map((row) => row.id));
  const rows = new Map([...stalePlans, ...awaiting].map((row) => [row.id, row]));

  return [...rows.values()]
    .toSorted((a, b) => a.time.getTime() - b.time.getTime())
    .map((row) => {
      const cardPayment = row.externalData?.cardPayment as { merchant?: unknown; card?: unknown } | undefined;

      return {
        transactionId: row.id,
        accountId: row.accountId,
        amount: row.amount.toNumber(),
        currencyCode: row.currencyCode,
        merchant: asText({ value: cardPayment?.merchant }),
        card: asText({ value: cardPayment?.card }),
        time: row.time.toISOString(),
        awaitingConfirmation: awaitingIds.has(row.id),
        bankUnconfirmed: staleIds.has(row.id),
        correction: correctionOf({ externalData: row.externalData }),
        transferSuggestion: transferSuggestionOf({ externalData: row.externalData }),
      };
    });
};
