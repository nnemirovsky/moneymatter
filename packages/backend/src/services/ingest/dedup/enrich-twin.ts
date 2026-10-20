import type { RecordId } from '@bt/shared/types';
import type { Money } from '@common/types/money';
import { connection } from '@models/connection';
import type Transactions from '@models/transactions.model';
import { DOMAIN_EVENTS, eventBus, type IngestPaymentLoggedPayload } from '@services/common/event-bus';
import { runAfterCommit } from '@services/common/run-after-commit';
import { updateTransaction } from '@services/transactions/update-transaction';
import { QueryTypes } from 'sequelize';

import { TAP_SLOT, type IngestSourceEntry } from './source-slots';
import { inferBankTime } from './twin-rule';

/** What the arriving source adds to the row it joins. */
interface TwinEnrichment {
  /** The source that arrived, as `externalData.ingest.sources[]` will keep it. */
  source: IngestSourceEntry;
  /** A bank states the account's own money; Wallet and a tap only relay what the card was charged. */
  fromBank: boolean;
  /** The amount and currency the source states, before any conversion of ours. */
  statedAmount: Money;
  statedCurrencyCode: string;
  originalAmount: Money | null;
  originalCurrencyCode: string | null;
  payeeId: string | null;
  /** The notification's own time: the reference that places the bank's wall-clock time. */
  time: Date;
  /** The wall-clock time the bank's text prints, read as UTC, when it prints one. */
  bankWallClock: Date | null;
  cardLastDigits: string | null;
}

interface IngestData {
  requestId?: RecordId;
  pipeline?: 'cardPayment' | 'notification';
  sources?: IngestSourceEntry[];
  cardLastDigits?: string;
}

const readIngestData = ({ transaction }: { transaction: Transactions }): IngestData =>
  (transaction.externalData?.ingest as IngestData | undefined) ?? {};

/**
 * The sources a row holds. A tap logged before the slots existed has none recorded, only its
 * `cardPayment` marker, and counts as one `tap` source.
 */
const readSources = ({ transaction }: { transaction: Transactions }): IngestSourceEntry[] => {
  const ingest = readIngestData({ transaction });
  if (Array.isArray(ingest.sources) && ingest.sources.length) return ingest.sources;

  const cardPayment = transaction.externalData?.cardPayment as { requestId?: RecordId } | undefined;
  if (!cardPayment) return [];

  return [
    {
      requestId: cardPayment.requestId ?? ingest.requestId ?? ('' as RecordId),
      pipeline: 'cardPayment',
      sourceKey: null,
      slot: TAP_SLOT,
    },
  ];
};

/**
 * Joins a payment to the row that already records it, and enriches that row with what the new source
 * knows. Runs inside the caller's transaction, under the user's `ingest-dedup` lock.
 *
 * - **Amount.** The bank's amount in the account's currency wins over our own conversion; the charged
 *   amount stays as `originalAmount` (a bank that states both fills it in when the row has none).
 *   Wallet and a tap never change an amount.
 * - **Payee.** A row with no payee takes the one the new source resolved.
 * - **Time.** A bank source that prints its own time places the row at it (the text prints no zone, so
 *   the offset is read off the notification's time), once.
 * - **Sources.** The source joins `externalData.ingest.sources[]` with its slot, its stated balance
 *   (informational) and the bank's time; the card's last digits are kept on the row.
 * - The row stays as unconfirmed as it was, and `INGEST_PAYMENT_LOGGED` is emitted again after the
 *   commit, so the one confirm card of the transaction is updated rather than a second one posted.
 */
export const enrichTwin = async ({
  userId,
  transaction,
  enrichment,
}: {
  userId: number;
  transaction: Transactions;
  enrichment: TwinEnrichment;
}): Promise<{ transactionId: RecordId }> => {
  const { source, fromBank } = enrichment;
  const ingest = readIngestData({ transaction });
  const sources = readSources({ transaction });
  const hasBankTime = sources.some((entry) => Boolean(entry.occurredAt));

  // The pipeline's own write: the row stays awaiting the owner, and its card is updated, not closed.
  const update: Parameters<typeof updateTransaction>[0] = { id: transaction.id, userId, keepIngestUnconfirmed: true };
  let changed = false;

  const statesAccountMoney = fromBank && enrichment.statedCurrencyCode === transaction.currencyCode;
  if (statesAccountMoney && !enrichment.statedAmount.equals(transaction.amount)) {
    update.amount = enrichment.statedAmount;
    changed = true;
  }
  if (
    statesAccountMoney &&
    !transaction.originalAmount &&
    enrichment.originalAmount &&
    enrichment.originalCurrencyCode
  ) {
    update.originalAmount = enrichment.originalAmount;
    update.originalCurrencyCode = enrichment.originalCurrencyCode;
    changed = true;
  }

  if (!transaction.payeeId && enrichment.payeeId) {
    update.payeeId = enrichment.payeeId;
    // The payee is the pipeline's reading, not an edit by the owner: a later sync may refine it.
    update.payeeLocked = false;
    changed = true;
  }

  const bankTime =
    fromBank && enrichment.bankWallClock && !hasBankTime
      ? inferBankTime({ wallClock: enrichment.bankWallClock, reference: enrichment.time })
      : null;
  if (bankTime && bankTime.getTime() !== transaction.time.getTime()) {
    update.time = bankTime;
    changed = true;
  }

  if (changed) await updateTransaction(update);

  const entry: IngestSourceEntry = { ...source, ...(bankTime && { occurredAt: bankTime.toISOString() }) };
  const nextSources = [...sources, entry];

  await connection.sequelize.query(
    `UPDATE "Transactions"
        SET "externalData" = jsonb_set(
              jsonb_set(
                COALESCE("externalData", '{}'::jsonb),
                '{ingest}',
                COALESCE("externalData"->'ingest', '{}'::jsonb)
              ),
              '{ingest,sources}',
              CAST(:sources AS jsonb)
            )
      WHERE "id" = :transactionId`,
    { replacements: { sources: JSON.stringify(nextSources), transactionId: transaction.id }, type: QueryTypes.UPDATE },
  );

  if (enrichment.cardLastDigits && !ingest.cardLastDigits) {
    await connection.sequelize.query(
      `UPDATE "Transactions"
          SET "externalData" = jsonb_set("externalData", '{ingest,cardLastDigits}', to_jsonb(CAST(:digits AS text)))
        WHERE "id" = :transactionId`,
      { replacements: { digits: enrichment.cardLastDigits, transactionId: transaction.id }, type: QueryTypes.UPDATE },
    );
  }

  const payload: IngestPaymentLoggedPayload = {
    userId,
    accountId: transaction.accountId,
    transactionId: transaction.id,
    requestId: ingest.requestId ?? source.requestId,
    pipeline: ingest.pipeline ?? source.pipeline,
  };
  await runAfterCommit({ fn: () => eventBus.emit(DOMAIN_EVENTS.INGEST_PAYMENT_LOGGED, payload) });

  return { transactionId: transaction.id };
};
