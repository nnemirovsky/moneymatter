import type { IngestPipeline, RecordId } from '@bt/shared/types';
import type { Money } from '@common/types/money';
import { connection } from '@models/connection';

import type { StoredBalanceAfter } from '../event/balance-authority';
import { enrichTwin } from './enrich-twin';
import { findDedupTarget } from './find-dedup-target';
import type { IngestSlot } from './source-slots';
import type { Figure } from './twin-rule';

/**
 * Serializes the twin and settlement lookup of one user across both pipelines, so two sources of one
 * payment that arrive together cannot both pass the lookup and each log a row. Held until the
 * caller's transaction ends.
 */
const lockIngestDedup = async ({ userId }: { userId: number }): Promise<void> => {
  await connection.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {
    replacements: { key: `ingest-dedup:${userId}` },
  });
};

interface IncomingPayment {
  requestId: RecordId;
  pipeline: IngestPipeline;
  account: { id: RecordId };
  direction: 'debit' | 'credit';
  /** The payment's time: the notification's own date, or the run time of a tap. */
  time: Date;
  slot: IngestSlot;
  /** The stage of a bank notification (`authorization`, `settlement`, `payment`); `null` for a tap or Wallet. */
  stage: string | null;
  sourceKey: string | null;
  /** A bank's notification states the account's own money; Wallet and a tap relay the card's charge. */
  fromBank: boolean;
  statedAmount: Money;
  statedCurrencyCode: string;
  originalAmount: Money | null;
  originalCurrencyCode: string | null;
  merchant: string | null;
  payeeId: string | null;
  cardLabel: string | null;
  cardLastDigits: string | null;
  balanceAfter: StoredBalanceAfter | null;
  /** The wall-clock time the bank's text prints, read as UTC, when it prints one. */
  bankWallClock: Date | null;
  /** The zone the request named (`timeZone`), when it did. */
  requestTimeZone: string | null;
}

/**
 * Tier 1 of the dedup: joins an arriving payment to the row that already records it, or returns
 * `null` for the caller to log a new row. Only deterministic rules attach (the exact twin, and a
 * bank's settlement onto its own authorization); everything fuzzier is left to the AI judge, which
 * only suggests.
 *
 * Takes the user's `ingest-dedup` lock, so it must run inside the caller's transaction, after the
 * payee is resolved and before anything is logged.
 */
export const attachToExistingPayment = async ({
  userId,
  payment,
}: {
  userId: number;
  payment: IncomingPayment;
}): Promise<{ transactionId: RecordId } | null> => {
  await lockIngestDedup({ userId });

  const figures: Figure[] = [
    { amount: payment.statedAmount, currencyCode: payment.statedCurrencyCode },
    ...(payment.originalAmount && payment.originalCurrencyCode
      ? [{ amount: payment.originalAmount, currencyCode: payment.originalCurrencyCode }]
      : []),
  ];

  const target = await findDedupTarget({
    userId,
    accountId: payment.account.id,
    cardLabel: payment.cardLabel,
    cardLastDigits: payment.cardLastDigits,
    direction: payment.direction,
    incoming: {
      time: payment.time,
      slot: payment.slot,
      sourceKey: payment.sourceKey,
      stage: payment.stage,
      figures,
      merchant: payment.merchant,
      payeeId: payment.payeeId,
    },
  });
  if (!target) return null;

  return enrichTwin({
    userId,
    transaction: target.transaction,
    enrichment: {
      source: {
        requestId: payment.requestId,
        pipeline: payment.pipeline,
        sourceKey: payment.sourceKey,
        slot: payment.slot,
        balanceAfter: payment.balanceAfter,
        ...(payment.cardLastDigits && { cardLastDigits: payment.cardLastDigits }),
      },
      fromBank: payment.fromBank,
      statedAmount: payment.statedAmount,
      statedCurrencyCode: payment.statedCurrencyCode,
      originalAmount: payment.originalAmount,
      originalCurrencyCode: payment.originalCurrencyCode,
      payeeId: payment.payeeId,
      time: payment.time,
      bankWallClock: payment.bankWallClock,
      requestTimeZone: payment.requestTimeZone,
      cardLastDigits: payment.cardLastDigits,
    },
  });
};
