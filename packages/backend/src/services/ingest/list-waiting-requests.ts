import type { RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import { Op } from 'sequelize';

import { sidesOf } from './conversion/conversion-rule';
import { findConversionPartner } from './conversion/find-conversion-partner';
import { readStoredParse } from './event/stored-parse';
import { TWIN_PARK_REASONS } from './twins/find-parked-twins';

/** The waiting list a chat reads is short: the newest few are what the owner means by "the notice in the inbox". */
export const WAITING_REQUESTS_FOR_CHAT_LIMIT = 20;

export interface WaitingIngestRequestView {
  requestId: RecordId;
  /** Why it waits: `unknownAccount`, `ownTransfer`, `lowConfidence`, `unverifiedParse`. */
  reason: string | null;
  /** The sender or app the notification came from, when it names one. */
  summary: string | null;
  /** When the payment happened: the time the notification states, else when it arrived. */
  time: string;
  /** `debit`: money left the account, `credit`: money arrived. */
  direction: 'debit' | 'credit' | null;
  amount: number | null;
  currencyCode: string | null;
  /** What the notice also states, such as the amount in the other currency of a conversion. */
  originalAmount: number | null;
  originalCurrencyCode: string | null;
  merchant: string | null;
  cardName: string | null;
  cardLastDigits: string | null;
  /** The two sides of a currency exchange when this notice is one side of one: what was sold and what was bought. */
  exchange: {
    sold: { amount: number; currencyCode: string | null };
    bought: { amount: number; currencyCode: string | null };
  } | null;
}

/**
 * The notification payments iOS Automation parked for the owner, newest first, with what was read from each:
 * amount, currency, direction, merchant and time. A chat that is asked to log or convert something reads this
 * first, so it uses the figures and the time of the notice instead of guessing them.
 */
export const listWaitingIngestRequests = async ({
  userId,
}: {
  userId: number;
}): Promise<WaitingIngestRequestView[]> => {
  const rows = await IngestRequests.findAll({
    where: { userId, pipeline: 'notification', status: 'parked', reason: { [Op.in]: TWIN_PARK_REASONS } },
    order: [['createdAt', 'DESC']],
    limit: WAITING_REQUESTS_FOR_CHAT_LIMIT,
  });

  const views: WaitingIngestRequestView[] = [];
  for (const request of rows) {
    const payment = readStoredParse({ value: request.parsed })?.payment;
    if (!payment) continue;

    const partner = await findConversionPartner({ request, payment });
    const partnerPayment = partner ? readStoredParse({ value: partner.request.parsed })?.payment : null;
    const sides =
      partner && partnerPayment
        ? sidesOf({
            left: { request, payment },
            right: { request: partner.request, payment: partnerPayment },
          })
        : null;

    views.push({
      requestId: request.id,
      reason: request.reason,
      summary: request.summary,
      time:
        typeof request.payload.time === 'string'
          ? request.payload.time
          : (payment.occurredAt ?? request.createdAt.toISOString()),
      direction: payment.kind,
      amount: Number(payment.amount),
      currencyCode: payment.currencyCode,
      originalAmount: payment.originalAmount === null ? null : Number(payment.originalAmount),
      originalCurrencyCode: payment.originalCurrencyCode,
      merchant: payment.merchant,
      cardName: payment.cardName,
      cardLastDigits: payment.cardLastDigits,
      exchange: sides
        ? {
            sold: { amount: Number(sides.debit.payment.amount), currencyCode: sides.debit.payment.currencyCode },
            bought: { amount: Number(sides.credit.payment.amount), currencyCode: sides.credit.payment.currencyCode },
          }
        : null,
    });
  }

  return views;
};
