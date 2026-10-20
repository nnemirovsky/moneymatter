import type { DuplicateSuggestionTrigger, RecordId } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ConflictError, NotFoundError } from '@js/errors';
import { connection } from '@models/connection';
import DuplicateSuggestions from '@models/duplicate-suggestions.model';
import { findTransactions } from '@models/transactions-query';
import { serializeTransaction } from '@root/serializers/transactions.serializer';
import { withTransaction } from '@services/common/with-transaction';
import { chooseSurvivor } from '@services/ingest/dedup/choose-survivor';
import { dedupConfig } from '@services/ingest/dedup/constants';
import { readTakenSlots } from '@services/ingest/dedup/source-slots';
import { Op, QueryTypes } from 'sequelize';

/** Open suggestions returned by one list call; a user has a handful at a time. */
const LIST_LIMIT = 200;

interface NewDuplicateSuggestion {
  transactionId: RecordId;
  candidateId: RecordId;
  confidence: number;
  reason: string | null;
}

/**
 * The pair in the order the table stores it: the smaller id first, so one pair is one row whichever
 * side was judged first.
 */
const orderPair = ({ a, b }: { a: RecordId; b: RecordId }): { transactionId: RecordId; candidateId: RecordId } =>
  a < b ? { transactionId: a, candidateId: b } : { transactionId: b, candidateId: a };

/**
 * Stores the pairs a judge found as open suggestions. A pair that already has a row (open, merged,
 * dismissed or stale) is left alone: `INSERT … ON CONFLICT DO NOTHING` on the ordered pair, so a
 * dismissed suggestion is never raised again. Returns the rows this call created.
 */
export const insertDuplicateSuggestions = async ({
  userId,
  accountId,
  trigger,
  suggestions,
}: {
  userId: number;
  accountId: RecordId;
  trigger: DuplicateSuggestionTrigger;
  suggestions: readonly NewDuplicateSuggestion[];
}): Promise<DuplicateSuggestions[]> => {
  if (!suggestions.length) return [];

  const created = await DuplicateSuggestions.bulkCreate(
    suggestions.map((suggestion) => ({
      userId,
      accountId,
      trigger,
      status: 'open' as const,
      confidence: suggestion.confidence,
      reason: suggestion.reason,
      ...orderPair({ a: suggestion.transactionId, b: suggestion.candidateId }),
    })),
    { ignoreDuplicates: true, returning: true },
  );

  return created;
};

/**
 * The open suggestions of the user, newest first, each with both transactions. A suggestion whose
 * either side is gone (hard-deleted, so the id is null, or soft-deleted by a merge or removal) is not
 * listed.
 */
export const listDuplicateSuggestions = async ({ userId }: { userId: number }) => {
  const suggestions = await DuplicateSuggestions.findAll({
    where: { userId, status: 'open', transactionId: { [Op.ne]: null }, candidateId: { [Op.ne]: null } },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: LIST_LIMIT,
  });
  if (!suggestions.length) return [];

  const ids = [...new Set(suggestions.flatMap((suggestion) => [suggestion.transactionId!, suggestion.candidateId!]))];
  const rows = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: 'all',
    where: { id: { [Op.in]: ids } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  return suggestions.flatMap((suggestion) => {
    const transaction = byId.get(suggestion.transactionId!);
    const candidate = byId.get(suggestion.candidateId!);
    if (!transaction || !candidate) return [];

    return [
      {
        id: suggestion.id,
        accountId: suggestion.accountId,
        confidence: Number(suggestion.confidence),
        reason: suggestion.reason,
        trigger: suggestion.trigger,
        createdAt: suggestion.createdAt.toISOString(),
        transaction: serializeTransaction(transaction),
        candidate: serializeTransaction(candidate),
        suggestedSurvivorId: chooseSurvivor({ candidates: [transaction, candidate] }),
        transactionSlots: readTakenSlots({ externalData: transaction.externalData }),
        candidateSlots: readTakenSlots({ externalData: candidate.externalData }),
      },
    ];
  });
};

/** What a lifecycle change touched: enough for the inbox to resolve the card of each suggestion. */
interface ResolvedSuggestion {
  id: RecordId;
  userId: number;
  proposalId: RecordId | null;
}

const toResolved = ({ rows }: { rows: DuplicateSuggestions[] }): ResolvedSuggestion[] =>
  rows.map((row) => ({ id: row.id, userId: row.userId, proposalId: row.proposalId }));

/**
 * The owner says an open pair is not a duplicate. The pair stays stored as `dismissed`, so no later
 * judge or scan raises it again. Dismissing a dismissed suggestion is harmless; one that was merged
 * or went stale is already resolved and answers 409.
 */
export const dismissDuplicateSuggestion = withTransaction(
  async ({ userId, id }: { userId: number; id: RecordId }): Promise<ResolvedSuggestion & { status: 'dismissed' }> => {
    const suggestion = await DuplicateSuggestions.findOne({ where: { id, userId }, lock: true });
    if (!suggestion) {
      throw new NotFoundError({ message: t({ key: 'transactions.reconciliation.suggestionNotFound' }) });
    }

    if (suggestion.status === 'open') {
      await suggestion.update({ status: 'dismissed', resolvedAt: new Date() });
    } else if (suggestion.status !== 'dismissed') {
      throw new ConflictError({ message: t({ key: 'transactions.reconciliation.suggestionResolved' }) });
    }

    return { ...toResolved({ rows: [suggestion] })[0]!, status: 'dismissed' };
  },
);

/**
 * A merge of `transactionIds` settles every open suggestion whose two sides are both in the merged set:
 * the owner did what the suggestion proposed. Call it inside the merge's transaction. Any other
 * suggestion that touches a removed row is the caller's `markSuggestionsStale`.
 */
export const markSuggestionMerged = async ({
  userId,
  transactionIds,
}: {
  userId: number;
  transactionIds: readonly string[];
}): Promise<ResolvedSuggestion[]> => {
  if (transactionIds.length < 2) return [];

  const [, rows] = await DuplicateSuggestions.update(
    { status: 'merged', resolvedAt: new Date() },
    {
      where: {
        userId,
        status: 'open',
        transactionId: { [Op.in]: [...transactionIds] },
        candidateId: { [Op.in]: [...transactionIds] },
      },
      returning: true,
    },
  );

  return toResolved({ rows });
};

/**
 * Open suggestions that name one of `transactionIds` stop being actionable once that row is deleted
 * or hidden: they become `stale` and keep their row (the foreign key nulls the side of a hard
 * delete). Call it inside the transaction that deletes or hides the rows, so a rollback undoes it.
 */
export const markSuggestionsStale = async ({
  transactionIds,
}: {
  transactionIds: readonly string[];
}): Promise<ResolvedSuggestion[]> => {
  if (!transactionIds.length) return [];

  const ids = [...transactionIds];
  const [, rows] = await DuplicateSuggestions.update(
    { status: 'stale', resolvedAt: new Date() },
    {
      where: { status: 'open', [Op.or]: [{ transactionId: { [Op.in]: ids } }, { candidateId: { [Op.in]: ids } }] },
      returning: true,
    },
  );

  return toResolved({ rows });
};

/**
 * Marks `stale` the open suggestions whose transaction is gone by a path that did not mark them:
 * a side that is null (a hard delete such as a sync removal or an import rollback) or soft-deleted.
 * `userId` limits the sweep to one user's rows; the cleanup cron sweeps everyone.
 */
export const sweepOrphanedSuggestions = async ({ userId }: { userId?: number } = {}): Promise<ResolvedSuggestion[]> => {
  const rows = (await connection.sequelize.query(
    `-- planned-ok: a suggestion that names a plan or a hidden row is about that row, so the base table is read on purpose
    UPDATE "DuplicateSuggestions" AS s
        SET "status" = 'stale', "resolvedAt" = NOW(), "updatedAt" = NOW()
      WHERE s."status" = 'open'
        AND (:userId::int IS NULL OR s."userId" = :userId::int)
        AND (
          s."transactionId" IS NULL
          OR s."candidateId" IS NULL
          OR EXISTS (
            SELECT 1 FROM "Transactions" AS t
             WHERE t."id" IN (s."transactionId", s."candidateId") AND t."deletedAt" IS NOT NULL
          )
        )
    RETURNING s."id", s."userId", s."proposalId"`,
    { replacements: { userId: userId ?? null }, type: QueryTypes.SELECT },
  )) as ResolvedSuggestion[];

  return rows;
};

/**
 * Deletes the suggestions that were settled (`merged`, `stale`) more than
 * `dedupConfig.resolvedSuggestionRetentionDays` ago. A `dismissed` one is kept for good: it is the
 * record that stops the pair from being raised again. Returns the number deleted.
 */
export const purgeResolvedSuggestions = async (): Promise<number> =>
  DuplicateSuggestions.destroy({
    where: {
      status: { [Op.in]: ['merged', 'stale'] },
      resolvedAt: { [Op.lt]: new Date(Date.now() - dedupConfig.resolvedSuggestionRetentionDays * 24 * 60 * 60_000) },
    },
  });
