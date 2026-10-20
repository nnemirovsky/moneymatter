import type { DuplicateSuggestionTrigger, RecordId } from '@bt/shared/types';
import DuplicateSuggestions from '@models/duplicate-suggestions.model';
import { findTransactions } from '@models/transactions-query';
import { serializeTransaction } from '@root/serializers/transactions.serializer';
import { readTakenSlots } from '@services/ingest/dedup/source-slots';
import { Op } from 'sequelize';

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
        transactionSlots: readTakenSlots({ externalData: transaction.externalData }),
        candidateSlots: readTakenSlots({ externalData: candidate.externalData }),
      },
    ];
  });
};
