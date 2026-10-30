import { wallClockToInstant } from '@bt/shared/time-zone';
import type { RecordId } from '@bt/shared/types';
import type { Money } from '@common/types/money';
import { normalizePayeeName } from '@services/payees/normalize-name';

import { dedupConfig } from './constants';
import { bankSlot, type IngestSlot } from './source-slots';

/** An amount in a currency: what a payment states, or what a row holds. */
export interface Figure {
  amount: Money;
  currencyCode: string;
}

/** The rows' figures: its own amount, and the charged amount when it was converted. */
export const figuresOfRow = ({
  amount,
  currencyCode,
  originalAmount,
  originalCurrencyCode,
}: {
  amount: Money;
  currencyCode: string;
  originalAmount: Money | null;
  originalCurrencyCode: string | null;
}): Figure[] => [
  { amount, currencyCode },
  ...(originalAmount && originalCurrencyCode ? [{ amount: originalAmount, currencyCode: originalCurrencyCode }] : []),
];

/** Whether the two sides state the same amount in the same currency anywhere. */
export const sharesFigure = ({ left, right }: { left: readonly Figure[]; right: readonly Figure[] }): boolean =>
  left.some((a) => right.some((b) => a.currencyCode === b.currencyCode && a.amount.equals(b.amount)));

/** A logged row, reduced to what the rules read. */
export interface DedupCandidate {
  id: RecordId;
  time: Date;
  figures: readonly Figure[];
  takenSlots: readonly IngestSlot[];
  /** Every name the row answers to: the merchant its first source printed, its payee and the payee's aliases. */
  names: readonly string[];
  payeeId: string | null;
  /** The merchant text of the row's first source, as printed. */
  merchant: string | null;
}

/** A payment that has just arrived, reduced to what the rules read. */
export interface DedupIncoming {
  time: Date;
  slot: IngestSlot;
  sourceKey: string | null;
  stage: string | null;
  figures: readonly Figure[];
  merchant: string | null;
  payeeId: string | null;
}

/** Same-shop verdict for one candidate. `true` also when the incoming text names no merchant. */
type SameShopCheck = (args: { candidate: DedupCandidate }) => boolean;

const byTime = (a: DedupCandidate, b: DedupCandidate) => a.time.getTime() - b.time.getTime();

/** Whether two merchant texts are the same once case and punctuation are gone. Neither empty. */
export const sameMerchantText = ({ left, right }: { left: string | null; right: string | null }): boolean => {
  if (!left || !right) return false;

  const normalized = normalizePayeeName({ raw: left });

  return normalized !== '' && normalized === normalizePayeeName({ raw: right });
};

/**
 * Tier-1 exact twin: the row an incoming source of the same payment joins. All of these must hold:
 *
 * - a free slot (a row holds one request per slot, so a second Wallet notification is a second payment);
 * - the same amount and currency, or the same charged (original) amount and currency;
 * - within `dedupConfig.twinWindowMs`;
 * - the same shop: the merchant text both sources printed is the same, or `sameShop` agrees (the rows' names
 *   and payees), so two different shops with equal amounts stay apart. The text decides alone because the
 *   payee is a guess that may have resolved differently for each source.
 *
 * Several qualifying rows are interchangeable (same amount, no veto between them), so the earliest wins:
 * two coffees stay two rows in every arrival order.
 */
export const pickTwin = ({
  candidates,
  incoming,
  sameShop,
}: {
  candidates: readonly DedupCandidate[];
  incoming: DedupIncoming;
  sameShop: SameShopCheck;
}): DedupCandidate | null =>
  candidates
    .toSorted(byTime)
    .find(
      (candidate) =>
        !candidate.takenSlots.includes(incoming.slot) &&
        Math.abs(candidate.time.getTime() - incoming.time.getTime()) <= dedupConfig.twinWindowMs &&
        sharesFigure({ left: candidate.figures, right: incoming.figures }) &&
        (sameMerchantText({ left: candidate.merchant, right: incoming.merchant }) || sameShop({ candidate })),
    ) ?? null;

/**
 * The settlement rule: a `settlement` notification of a bank joins the earliest row that holds the
 * same source's `authorization` slot with its `settlement` slot free, at the same amount (or the same
 * charged amount), under the same merchant text, at most `dedupConfig.settlementWindowMs` old.
 * Anything looser is left to the AI judge, which only suggests.
 */
export const pickSettlementTarget = ({
  candidates,
  incoming,
}: {
  candidates: readonly DedupCandidate[];
  incoming: DedupIncoming;
}): DedupCandidate | null => {
  if (incoming.stage !== 'settlement' || !incoming.sourceKey) return null;

  const authorization = bankSlot({ sourceKey: incoming.sourceKey, stage: 'authorization' });

  return (
    candidates
      .toSorted(byTime)
      .find(
        (candidate) =>
          candidate.takenSlots.includes(authorization) &&
          !candidate.takenSlots.includes(incoming.slot) &&
          Math.abs(candidate.time.getTime() - incoming.time.getTime()) <= dedupConfig.settlementWindowMs &&
          sharesFigure({ left: candidate.figures, right: incoming.figures }) &&
          sameMerchantText({ left: candidate.merchant, right: incoming.merchant }),
      ) ?? null
  );
};

const FIFTEEN_MINUTES_MS = 15 * 60_000;
const MAX_OFFSET_MS = 14 * 60 * 60_000;
const MAX_RESIDUAL_MS = 5 * 60_000;

/**
 * The instant a bank's text states, when it can be placed. A text prints a wall-clock time with no zone
 * (`20/10/26 18:40`), so its offset is unknown. The time the notification arrived (`reference`) gives
 * it: the offset is the quarter-hour step that brings the wall clock within five minutes of the
 * reference. A wall clock that fits no offset that way is not trusted.
 */
export const inferBankTime = ({
  wallClock,
  reference,
}: {
  /** The text's wall-clock time as a UTC instant (year, month, day, hour and minute read as UTC). */
  wallClock: Date;
  reference: Date;
}): Date | null => {
  const delta = wallClock.getTime() - reference.getTime();
  const offset = Math.round(delta / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;

  if (Math.abs(offset) > MAX_OFFSET_MS) return null;
  if (Math.abs(delta - offset) > MAX_RESIDUAL_MS) return null;

  return new Date(wallClock.getTime() - offset);
};

/**
 * Places a bank's wall-clock text when the request named the device's zone: the wall clock read in
 * that zone is accepted when it lies within the same residual `inferBankTime` allows around the
 * notification time. Otherwise (no zone, or a clock the zone does not explain) the offset is inferred.
 */
export const placeBankTime = ({
  wallClock,
  reference,
  zone,
}: {
  wallClock: Date;
  reference: Date;
  zone: string | null;
}): Date | null => {
  if (zone) {
    const instant = wallClockToInstant({
      wall: {
        year: wallClock.getUTCFullYear(),
        month: wallClock.getUTCMonth() + 1,
        day: wallClock.getUTCDate(),
        hour: wallClock.getUTCHours(),
        minute: wallClock.getUTCMinutes(),
        second: 0,
        ms: 0,
      },
      zone,
    });
    if (Math.abs(instant.getTime() - reference.getTime()) <= MAX_RESIDUAL_MS) return instant;
  }

  return inferBankTime({ wallClock, reference });
};
