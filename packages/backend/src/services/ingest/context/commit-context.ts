import { CATEGORIZATION_SOURCE, type RecordId } from '@bt/shared/types';
import { getCurrencyDecimals } from '@common/lib/currency-precision';
import { t } from '@i18n/index';
import Categories from '@models/categories.model';
import { connection } from '@models/connection';
import IngestRequests from '@models/ingest-requests.model';
import { findOneTransaction } from '@models/transactions-query';
import { DOMAIN_EVENTS, eventBus, type IngestPaymentUpdatedPayload } from '@services/common/event-bus';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';
import { updateTransaction } from '@services/transactions/update-transaction';
import { QueryTypes } from 'sequelize';

import { formatSummary } from '../card-payment/format-summary';
import type { StoredParse } from '../event/stored-parse';
import { ingestMarkersOf, isUnconfirmedIngest } from '../ingest-markers';
import { lockContext } from './context-lock';
import type { StoredContext } from './context-types';
import { findContextCandidates } from './find-context-payment';
import { isPipelineCategory } from './pick-context-category';

/** Why the request ends up where it does; the caller decides what to do with a refusal. */
type ApplyResult =
  | { kind: 'applied'; summary: string }
  /** The row was settled by the owner meanwhile. */
  | { kind: 'confirmed' }
  /** Another context claimed the row meanwhile: match again. */
  | { kind: 'conflict' }
  /** The row carries a note of the owner and no category changed: nothing was added. */
  | { kind: 'kept' }
  /** The request was settled by another pass. */
  | { kind: 'gone' };

/**
 * Whether the pipeline may write the context note: the row has no note, or the note on it is the one the
 * pipeline wrote itself (`ingest.systemNote`). A note the owner wrote is never replaced.
 */
export const isNoteReplaceable = ({
  note,
  systemNote,
}: {
  note: string | null;
  systemNote: string | undefined;
}): boolean => !note || (Boolean(systemNote) && note === systemNote);

const requestParsed = ({
  context,
  parser,
  confidence,
}: {
  context: StoredContext;
  parser: StoredParse['parser'];
  confidence: number;
}) => ({ parser, kind: 'context', confidence, context }) as unknown as Record<string, unknown>;

const setIngestPath = ({ transactionId, path, value }: { transactionId: RecordId; path: string; value: unknown }) =>
  connection.sequelize.query(
    `UPDATE "Transactions"
        SET "externalData" = jsonb_set("externalData", '{ingest,${path}}', CAST(:value AS jsonb))
      WHERE "id" = :transactionId`,
    { replacements: { value: JSON.stringify(value), transactionId }, type: QueryTypes.UPDATE },
  );

const applyContextImpl = async ({
  userId,
  requestId,
  transactionId,
  context,
  parser,
  confidence,
  categoryId,
  locale,
}: {
  userId: number;
  requestId: RecordId;
  transactionId: RecordId;
  context: StoredContext;
  parser: StoredParse['parser'];
  confidence: number;
  /** The store's category, picked before the lock; written only if the row still qualifies. */
  categoryId: RecordId | null;
  locale: string;
}): Promise<ApplyResult> => {
  await lockContext({ userId });

  const request = await IngestRequests.findOne({ where: { id: requestId }, lock: true });
  if (!request || (request.status !== 'received' && request.status !== 'held')) return { kind: 'gone' };

  const tx = await findOneTransaction({
    where: { id: transactionId },
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    lock: true,
  });
  // A deleted row is a payment that is gone: match again.
  if (!tx) return { kind: 'conflict' };
  if (!isUnconfirmedIngest({ externalData: tx.externalData })) return { kind: 'confirmed' };

  const markers = ingestMarkersOf({ externalData: tx.externalData });
  const claimedBy = await IngestRequests.findOne({
    where: { userId, status: 'enriched', transactionId },
    attributes: ['id'],
  });
  if ((markers.context && markers.context.requestId !== requestId) || (claimedBy && claimedBy.id !== requestId)) {
    return { kind: 'conflict' };
  }

  const noteEligible = isNoteReplaceable({ note: tx.note, systemNote: markers.systemNote });
  const note = noteEligible
    ? t({ key: 'ingest.contextNote', variables: { store: context.store, service: context.service }, locale })
    : null;
  const categoryEligible =
    Boolean(categoryId) &&
    categoryId !== tx.categoryId &&
    isPipelineCategory({ categorizationMeta: tx.categorizationMeta });
  const newCategoryId = categoryEligible ? categoryId : null;

  const stored = { ...context };
  if (note === null && newCategoryId === null) {
    await request.update({
      status: 'ignored',
      reason: 'contextNoteKept',
      textEnc: null,
      summary: null,
      parsed: requestParsed({ context: stored, parser, confidence }),
    });

    return { kind: 'kept' };
  }

  await updateTransaction({
    id: transactionId,
    userId,
    keepIngestUnconfirmed: true,
    ...(note !== null && { note }),
    ...(newCategoryId !== null && { categoryId: newCategoryId }),
  });
  if (note !== null) await setIngestPath({ transactionId, path: 'systemNote', value: note });
  if (newCategoryId !== null) {
    await setIngestPath({ transactionId, path: 'systemCategoryId', value: newCategoryId });
    // The category is the pipeline's own pick, not the owner's: stamped as an automatic one so a later
    // context or categorization run may still refine it.
    await connection.sequelize.query(
      `UPDATE "Transactions" SET "categorizationMeta" = CAST(:meta AS jsonb) WHERE "id" = :transactionId`,
      {
        replacements: {
          meta: JSON.stringify({ source: CATEGORIZATION_SOURCE.ai, categorizedAt: new Date().toISOString() }),
          transactionId,
        },
        type: QueryTypes.UPDATE,
      },
    );
  }
  await setIngestPath({
    transactionId,
    path: 'context',
    value: {
      requestId,
      service: context.service,
      store: context.store,
      status: context.status,
      noteApplied: note !== null,
      categoryApplied: newCategoryId !== null,
      guess: Boolean(context.guess),
    },
  });

  const category = newCategoryId
    ? await Categories.findOne({ where: { id: newCategoryId }, attributes: ['name'] })
    : null;
  const decimals = await getCurrencyDecimals({ userId, code: tx.currencyCode });
  const original =
    tx.originalAmount && tx.originalCurrencyCode
      ? {
          amount: tx.originalAmount.toNumber(),
          currencyCode: tx.originalCurrencyCode,
          decimals: await getCurrencyDecimals({ userId, code: tx.originalCurrencyCode }),
        }
      : null;
  const summary = formatSummary({
    summary: {
      type: 'contextAdded',
      payment: original ?? { amount: tx.amount.toNumber(), currencyCode: tx.currencyCode, decimals },
      merchant: (tx.externalData?.cardPayment as { merchant?: string } | undefined)?.merchant ?? context.service,
      store: context.store,
      categoryName: category?.name ?? null,
    },
    locale,
  });

  await request.update({
    status: 'enriched',
    reason: null,
    transactionId,
    textEnc: null,
    summary,
    parsed: requestParsed({ context: stored, parser, confidence }),
  });

  const payload: IngestPaymentUpdatedPayload = { userId, transactionId };
  await runAfterCommit({ fn: () => eventBus.emit(DOMAIN_EVENTS.INGEST_PAYMENT_UPDATED, payload) });

  return { kind: 'applied', summary };
};

/**
 * Writes a context notification onto the payment it was matched to, in one transaction under the
 * user's context lock: re-reads the row `FOR UPDATE` and re-checks what the match assumed (the row is
 * still unconfirmed, no other order claimed it), writes the note (when empty or the pipeline's own) and
 * the store's category (when the pipeline's own), stamps `ingest.context`, closes the request as
 * `enriched` (or `ignored` / `contextNoteKept` when nothing could be added) and refreshes the row's
 * confirm card. Anything the match no longer holds for comes back as a refusal and writes nothing.
 */
export const applyContext = withTransaction(applyContextImpl);

const holdContextImpl = async ({
  userId,
  requestId,
  context,
  parser,
  confidence,
  time,
  hints,
  excludes,
  locale,
}: {
  userId: number;
  requestId: RecordId;
  context: StoredContext;
  parser: StoredParse['parser'];
  confidence: number;
  time: Date;
  hints: readonly string[];
  excludes: readonly string[];
  locale: string;
}): Promise<'held' | 'retry' | 'gone'> => {
  await lockContext({ userId });

  const request = await IngestRequests.findOne({ where: { id: requestId }, lock: true });
  if (!request || request.status !== 'received') return request?.status === 'held' ? 'held' : 'gone';

  // A payment may have been logged while the match was being made: look once more under the lock.
  const { open } = await findContextCandidates({ userId, time, hints, excludes });
  if (open.length) return 'retry';

  await request.update({
    status: 'held',
    reason: null,
    textEnc: null,
    summary: formatSummary({
      summary: { type: 'contextHeld', store: context.store, service: context.service },
      locale,
    }),
    parsed: requestParsed({ context, parser, confidence }),
  });

  return 'held';
};

/** Keeps a context notification, with its text wiped, until a payment of its service is logged. */
export const holdContext = withTransaction(holdContextImpl);
