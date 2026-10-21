import type { RecordId } from '@bt/shared/types';
import type { Money } from '@common/types/money';
import { normalizePayeeName } from '@services/payees/normalize-name';

import { holdReleaseConfig } from './constants';

/** A payment reduced to what the hold-and-release rule reads. */
export interface HoldFacts {
  direction: 'debit' | 'credit';
  amount: Money;
  currencyCode: string | null;
  time: Date;
  /** The account the payment sits on; `null` for a parked payment that has none yet. */
  accountId: string | null;
  /** The notification source (parked payments only). */
  sourceId: string | null;
  cardLastDigits: string | null;
  /** The merchant the payment printed; `null` when the text names none. */
  merchant: string | null;
}

export interface HoldCandidate extends HoldFacts {
  id: string;
}

/**
 * Whether two payments are about the same place: the same account, or, when either has none yet, the
 * same source and the same card digits (the same currency when neither names digits).
 */
const sameScope = ({ left, right }: { left: HoldFacts; right: HoldFacts }): boolean => {
  if (left.accountId && right.accountId) return left.accountId === right.accountId;
  if (left.accountId || right.accountId) return false;
  if (!left.sourceId || left.sourceId !== right.sourceId) return false;
  if (left.cardLastDigits || right.cardLastDigits) return left.cardLastDigits === right.cardLastDigits;

  return left.currencyCode !== null && left.currencyCode === right.currencyCode;
};

/**
 * Whether the two name different merchants. A text that names none (a release often does not) cannot
 * contradict the other, so only two named merchants that differ keep the payments apart: a transfer out
 * and a deposit of the same amount are not a hold and its release.
 */
const namesDifferentMerchants = ({ left, right }: { left: HoldFacts; right: HoldFacts }): boolean => {
  if (!left.merchant || !right.merchant) return false;

  return normalizePayeeName({ raw: left.merchant }) !== normalizePayeeName({ raw: right.merchant });
};

/**
 * The earlier payment an incoming one cancels out: the opposite direction, the same amount in the
 * same currency, the same scope, merchants that do not contradict each other and at most `holdReleaseConfig.windowMs` apart. Of several the
 * nearest in time wins, so pairing is one to one in whatever order the payments come.
 */
export const pickHoldCounterpart = ({
  incoming,
  candidates,
  windowMs = holdReleaseConfig.windowMs,
}: {
  incoming: HoldFacts;
  candidates: readonly HoldCandidate[];
  windowMs?: number;
}): HoldCandidate | null => {
  const distance = (candidate: HoldCandidate) => Math.abs(candidate.time.getTime() - incoming.time.getTime());

  return (
    candidates
      .filter(
        (candidate) =>
          candidate.direction !== incoming.direction &&
          candidate.currencyCode === incoming.currencyCode &&
          candidate.amount.equals(incoming.amount) &&
          distance(candidate) <= windowMs &&
          sameScope({ left: incoming, right: candidate }) &&
          !namesDifferentMerchants({ left: incoming, right: candidate }),
      )
      .toSorted((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id))[0] ?? null
  );
};
