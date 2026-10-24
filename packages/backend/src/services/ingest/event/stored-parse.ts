import type { NotificationParkReason, RecordId } from '@bt/shared/types';

import type { StoredContext } from '../context/context-types';
import type { StoredBalanceAfter } from './balance-authority';
import type { ParsedPayment } from './classify-notification';

/** A payment read from a notification, as it sits in `IngestRequests.parsed` (a JSON column, so no `Date`). */
export type StoredPayment = Omit<ParsedPayment, 'occurredAt'> & { occurredAt: string | null };

/**
 * `IngestRequests.parsed` of a notification:
 *
 * - a notification that is not a payment keeps `{ parser, kind, confidence }` and nothing else, so no
 *   merchant, card digits or balance stays in plain JSON;
 * - a payment that was read keeps the payment, so a retry of a request that parked on the account
 *   (or that the owner forces through) does not call the AI again;
 * - a logged payment also keeps the balance it stated, with whether it is authoritative.
 */
export interface StoredParse {
  parser: 'wallet' | 'ai' | 'rules';
  kind: string;
  confidence: number;
  payment?: StoredPayment;
  /** A currency symbol the amount text carried (`$`), which only the user's own currencies can settle. */
  symbol?: string | null;
  balanceAfter?: StoredBalanceAfter | null;
  /** The payment joined a transaction that was already logged (a twin or a settlement) instead of making a row. */
  attached?: boolean;
  /** For a payment parked on `unknownAccount`: the only account in its currency, to pre-fill the inbox card. */
  accountGuessId?: RecordId | null;
  /** The account the owner chose on the inbox card of a parked payment; the job logs the payment there. */
  accountOverrideId?: RecordId;
  /** The direction the owner chose on that card, when it differs from what the text said. */
  directionOverride?: 'debit' | 'credit';
  /** The note the owner wrote on that card; an empty one is no note. Absent, the pipeline picks the note. */
  noteOverride?: string;
  /** The other side of a currency exchange this payment is one side of; the two are linked as a transfer once logged. */
  conversion?: { partnerRequestId: RecordId };
  /** For a request that joined another as the other side of an exchange: the reason it was parked with, restored if it waits again. */
  conversionParkReason?: string;
  /** The note a business sender's message gave the currency exchange that waits on this request's card. */
  exchangeNote?: string;
  /** A context notification of a merchant app: what it said about an order, kept after its text is wiped. */
  context?: StoredContext;
}

/** The reasons a park leaves the notification unread: nothing was parsed, so the text stays. */
export const UNCLASSIFIED_PARK_REASONS: readonly NotificationParkReason[] = [
  'sourceNotApproved',
  'aiUnavailable',
  'aiCapReached',
  'aiLimitReached',
];

/** The reasons that need the owner's word before the payment is logged, so a retry must say `force`. */
export const FORCE_PARK_REASONS: readonly string[] = ['ownTransfer', 'lowConfidence', 'unverifiedParse'];

export const toStoredPayment = ({ payment }: { payment: ParsedPayment }): StoredPayment => ({
  ...payment,
  occurredAt: payment.occurredAt ? payment.occurredAt.toISOString() : null,
});

export const fromStoredPayment = ({ payment }: { payment: StoredPayment }): ParsedPayment => ({
  ...payment,
  occurredAt: payment.occurredAt ? new Date(payment.occurredAt) : null,
});

/** Reads `parsed` back as far as it can be trusted: a malformed value reads as nothing. */
export const readStoredParse = ({ value }: { value: Record<string, unknown> | null }): StoredParse | null => {
  if (!value || typeof value !== 'object') return null;

  const { parser, kind, confidence } = value;
  if (
    (parser !== 'wallet' && parser !== 'ai' && parser !== 'rules') ||
    typeof kind !== 'string' ||
    typeof confidence !== 'number'
  ) {
    return null;
  }

  return value as unknown as StoredParse;
};
