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

const toRequestDto = ({ row, now }: { row: IngestRequests; now: Date }): CardPaymentRequestDto => {
  // A `received` request that outlived its processing pass reads as interrupted.
  const interrupted = row.status === 'received' && isWaitingRequest({ row, now });

  return {
    id: row.id,
    status: row.status,
    reason: interrupted ? 'interrupted' : ((row.reason as IngestRequestReason | null) ?? null),
    summary: row.summary,
    cardLabel: row.cardLabel,
    merchant: asText({ value: row.payload.merchant }),
    amountText: asText({ value: row.payload.amount }),
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
                createdAt: { [Op.lt]: new Date(now.getTime() - cardPaymentTimings.interruptedAfterMs) },
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
 * not a link.
 */
export const listUnlinkedCards = async ({ userId }: { userId: number }): Promise<UnlinkedCardDto[]> => {
  const [waiting, mappings] = await Promise.all([
    IngestRequests.findAll({
      where: { userId, status: 'parked', reason: 'unknownCard', cardLabel: { [Op.ne]: null } },
      attributes: ['cardLabel'],
      order: [['createdAt', 'DESC']],
    }),
    CardAccountMappings.findAll({ where: { userId }, attributes: ['normalizedLabel'] }),
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
 * Card-payment plans the bank did not confirm within the match window: a booking can no longer
 * settle them, so the user decides whether to delete the plan (the booked row already exists) or
 * keep it. Plans the user wrote and payments on manual accounts, which are final, never appear.
 */
export const listUnconfirmedCardPayments = async ({
  userId,
}: {
  userId: number;
}): Promise<UnconfirmedCardPaymentDto[]> => {
  const plans = await findTransactions({
    planned: 'only',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: { cap: { limit: UNCONFIRMED_PAYMENTS_LIMIT, onTruncated: 'log', context: { userId } } },
    where: {
      time: { [Op.lt]: subDays(new Date(), PLANNED_MATCH_WINDOW_DAYS) },
      [Op.and]: literal(`("Transactions"."externalData"->'cardPayment') IS NOT NULL`),
    },
    order: [['time', 'ASC']],
  });

  return plans.map((plan) => {
    const cardPayment = plan.externalData?.cardPayment as { merchant?: unknown; card?: unknown } | undefined;

    return {
      transactionId: plan.id,
      accountId: plan.accountId,
      amount: plan.amount.toNumber(),
      currencyCode: plan.currencyCode,
      merchant: asText({ value: cardPayment?.merchant }),
      card: asText({ value: cardPayment?.card }),
      time: plan.time.toISOString(),
    };
  });
};
