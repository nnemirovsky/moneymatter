import { TRANSACTION_TYPES, type IngestShortBalanceCorrection, type RecordId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import ChatProposals from '@models/chat-proposals.model';
import { connection } from '@models/connection';
import DuplicateSuggestions from '@models/duplicate-suggestions.model';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { findOneTransaction, findTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import { getDismissalsForUser } from '@models/transfer-suggestion-dismissals.model';
import { withTransaction } from '@services/common/with-transaction';
import { correctionOf, transferSuggestionOf } from '@services/ingest/corrections/read-ingest-suggestions';
import { chooseSurvivor } from '@services/ingest/dedup/choose-survivor';
import { readStoredParse } from '@services/ingest/event/stored-parse';
import { Op, QueryTypes } from 'sequelize';

import { createSystemProposal, refreshSystemProposal } from './create-system-proposal';
import { CONFIRM_TOOL, findCardsOfTransactions, LINK_TRANSFER_TOOL, resolveCardsElsewhere } from './inbox-resolution';
import { lockInbox } from './inbox-thread';
import { OPEN_CARD_STATUSES } from './inbox-transitions';

/** The tools the inbox posts cards for, besides the confirm card and the existing "link as transfer". */
export const LOG_INGEST_REQUEST_TOOL = 'log_ingest_request';
export const SET_NOTIFICATION_SOURCE_TOOL = 'set_notification_source';
export const MERGE_DUPLICATES_TOOL = 'merge_duplicate_transactions';

/** Park reasons whose request gets a card of its own; the others have no action the owner can take. */
const REQUEST_CARD_REASONS = ['unknownAccount', 'ownTransfer', 'lowConfidence'];

/**
 * Whether a parked notification request gets an inbox card for `reason`: its own card, or the card of
 * the source it waits on. A park without one (`ai*`, `rateUnavailable`, `processingFailed`) needs an
 * `ingestAttention` push instead.
 */
export const parkHasInboxCard = ({ reason }: { reason: string }): boolean =>
  reason === 'sourceNotApproved' || REQUEST_CARD_REASONS.includes(reason);

/** The values of a payment a confirm card offers for editing; also what the card was built from. */
interface ConfirmBaseline {
  accountId: string;
  amount: number;
  payeeId: string | null;
  categoryId: string;
}

const isUnconfirmed = ({ tx }: { tx: Transactions }): boolean =>
  (tx.externalData?.ingest as { unconfirmed?: unknown } | undefined)?.unconfirmed === true;

const openCorrectionOf = ({ tx }: { tx: Transactions }): IngestShortBalanceCorrection | null => {
  const correction = correctionOf({ externalData: tx.externalData });

  return correction && correction.status === 'open' ? correction : null;
};

/**
 * What the confirm card starts from: the row as it is, or, while a short-balance correction is open,
 * the account the correction suggests with its estimated amount (the card says it is an estimate).
 * The baseline is what the card showed untouched; the tool applies only what the owner changed.
 */
const buildConfirmArgs = ({
  tx,
}: {
  tx: Transactions;
}): { args: Record<string, unknown>; baseline: ConfirmBaseline } => {
  const correction = openCorrectionOf({ tx });
  const accountId = correction ? correction.suggestedAccountId : tx.accountId;
  const amount = correction ? correction.estimatedAmount.amount : tx.amount.toNumber();
  const baseline: ConfirmBaseline = { accountId, amount, payeeId: tx.payeeId ?? null, categoryId: tx.categoryId };

  return {
    args: {
      transactionId: tx.id,
      accountId: baseline.accountId,
      amount: baseline.amount,
      ...(baseline.payeeId && { payeeId: baseline.payeeId }),
      categoryId: baseline.categoryId,
    },
    baseline,
  };
};

/** Stores what the card was built from on the row, where the confirm tool reads it back. */
const storeBaseline = async ({
  transactionId,
  baseline,
}: {
  transactionId: RecordId;
  baseline: ConfirmBaseline;
}): Promise<void> => {
  await connection.sequelize.query(
    `-- planned-ok: the baseline belongs to the row whether it is a plan or not, so the base table is written on purpose
    UPDATE "Transactions"
        SET "externalData" = jsonb_set("externalData", '{ingest,confirmBaseline}', CAST(:baseline AS jsonb), true)
      WHERE "id" = :transactionId AND "externalData" #> '{ingest}' IS NOT NULL`,
    { replacements: { transactionId, baseline: JSON.stringify(baseline) }, type: QueryTypes.UPDATE },
  );
};

const loadTransaction = ({ userId, transactionId }: { userId: number; transactionId: RecordId }) =>
  findOneTransaction({
    where: { id: transactionId },
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
  });

const findOpenCard = async ({ toolName, transactionId }: { toolName: string; transactionId: RecordId }) => {
  const [id] = await findCardsOfTransactions({ transactionIds: [transactionId], toolNames: [toolName] });

  return id ? ChatProposals.findByPk(id) : null;
};

/**
 * Keeps the one confirm card of an automated payment in step with the row: posts it the first time,
 * updates it when a later source changed the row (a twin, a correction), and closes it when the row
 * is confirmed, edited or gone. Idempotent per transaction, and safe to call for every event: it
 * runs under the inbox lock, so two events for one payment cannot post two cards.
 */
export const syncConfirmCard = withTransaction(
  async ({ userId, transactionId }: { userId: number; transactionId: RecordId }): Promise<void> => {
    await lockInbox({ userId });

    const tx = await loadTransaction({ userId, transactionId });
    const card = await findOpenCard({ toolName: CONFIRM_TOOL, transactionId });

    if (!tx || !isUnconfirmed({ tx }) || tx.transferId) {
      if (card) await resolveCardsElsewhere({ proposalIds: [card.id] });
      return;
    }

    const { args, baseline } = buildConfirmArgs({ tx });

    if (card) {
      await refreshSystemProposal({ userId, proposalId: card.id, args });
    } else {
      await createSystemProposal({ userId, toolName: CONFIRM_TOOL, args });
    }

    // Last, so the row lock this write takes is held only until the commit: the AI categorization of the
    // same row, which the shortcut's banner waits a moment for, must not queue behind the card.
    await storeBaseline({ transactionId, baseline });
  },
);

/**
 * Posts the "link as transfer?" card of a currency-conversion pair once, whichever leg's event comes
 * first. A pair that was dismissed, linked, or whose legs are gone gets none.
 */
export const syncTransferCard = withTransaction(
  async ({ userId, transactionId }: { userId: number; transactionId: RecordId }): Promise<void> => {
    const tx = await loadTransaction({ userId, transactionId });
    const suggestion = tx ? transferSuggestionOf({ externalData: tx.externalData }) : null;
    if (!tx || !suggestion) return;

    await lockInbox({ userId });

    const { expenseTransactionId, incomeTransactionId } = suggestion;
    if (await findOpenCard({ toolName: LINK_TRANSFER_TOOL, transactionId: expenseTransactionId })) return;

    const [expense, income] = await Promise.all([
      loadTransaction({ userId, transactionId: expenseTransactionId }),
      loadTransaction({ userId, transactionId: incomeTransactionId }),
    ]);
    if (!expense || !income || expense.transferId || income.transferId) return;

    const dismissed = (await getDismissalsForUser({ userId })).some(
      (entry) =>
        entry.expenseTransactionId === expenseTransactionId && entry.incomeTransactionId === incomeTransactionId,
    );
    if (dismissed) return;

    await createSystemProposal({
      userId,
      toolName: LINK_TRANSFER_TOOL,
      args: { baseTxId: expenseTransactionId, oppositeTxId: incomeTransactionId },
    });
  },
);

/** The card of a source that waits for approval; one per source. */
const postSourceCard = async ({ userId, sourceId }: { userId: number; sourceId: RecordId }): Promise<void> => {
  const source = await NotificationSources.findOne({ where: { id: sourceId, userId }, lock: true });
  if (!source || source.mode !== 'pending') return;

  if (source.proposalId) {
    const existing = await ChatProposals.findOne({
      where: { id: source.proposalId, status: { [Op.in]: [...OPEN_CARD_STATUSES] } },
      attributes: ['id'],
    });
    if (existing) return;
  }

  const proposal = await createSystemProposal({
    userId,
    toolName: SET_NOTIFICATION_SOURCE_TOOL,
    args: { sourceId: source.id, mode: 'approved' },
  });
  if (proposal) await source.update({ proposalId: proposal.proposalId });
};

/** The card of a parked request that needs the owner's word; one per request. */
const postRequestCardInTransaction = async ({
  userId,
  requestId,
}: {
  userId: number;
  requestId: RecordId;
}): Promise<void> => {
  const request = await IngestRequests.findOne({
    where: { id: requestId, userId, pipeline: 'notification' },
    lock: true,
  });
  if (!request || request.status !== 'parked' || !request.reason) return;

  if (request.reason === 'sourceNotApproved') {
    if (request.sourceId) await postSourceCard({ userId, sourceId: request.sourceId });
    return;
  }
  if (!REQUEST_CARD_REASONS.includes(request.reason)) return;

  if (request.proposalId) {
    const existing = await ChatProposals.findOne({
      where: { id: request.proposalId, status: { [Op.in]: [...OPEN_CARD_STATUSES] } },
      attributes: ['id'],
    });
    if (existing) return;
  }

  const stored = readStoredParse({ value: request.parsed });
  const direction = stored?.payment?.kind;
  const proposal = await createSystemProposal({
    userId,
    toolName: LOG_INGEST_REQUEST_TOOL,
    args: {
      requestId: request.id,
      ...(stored?.accountGuessId && { accountId: stored.accountGuessId }),
      ...((direction === 'debit' || direction === 'credit') && { direction }),
    },
  });
  if (proposal) await request.update({ proposalId: proposal.proposalId });
};

/**
 * Posts the card a parked notification request calls for: a source to approve, or a payment whose
 * account is unknown, that looks like a transfer between the owner's accounts, or that was read with
 * doubt. Other park reasons (`ai*`, `rateUnavailable`, `processingFailed`) have no card.
 */
export const postRequestCard = withTransaction(
  async ({ userId, requestId }: { userId: number; requestId: RecordId }): Promise<void> => {
    await lockInbox({ userId });
    await postRequestCardInTransaction({ userId, requestId });
  },
);

/**
 * Posts one merge card for each new duplicate suggestion, with the survivor the dedup rules choose
 * (the owner can edit it on the card). A suggestion whose pair cannot be merged (a transfer leg, a
 * refund-linked row) gets no card and stays in Reconciliation. Nothing is merged here.
 */
export const postDuplicateSuggestionCards = withTransaction(
  async ({ userId, suggestions }: { userId: number; suggestions: readonly DuplicateSuggestions[] }): Promise<void> => {
    if (!suggestions.length) return;
    await lockInbox({ userId });

    for (const suggestion of suggestions) {
      if (!suggestion.transactionId || !suggestion.candidateId) continue;

      const rows = await findTransactions({
        planned: 'include',
        access: { accountOwner: userId },
        balanceAdjustments: 'exclude',
        completeness: 'all',
        where: {
          id: { [Op.in]: [suggestion.transactionId, suggestion.candidateId] },
          transactionType: { [Op.in]: [TRANSACTION_TYPES.expense, TRANSACTION_TYPES.income] },
        },
      });
      if (rows.length !== 2) continue;

      const proposal = await createSystemProposal({
        userId,
        toolName: MERGE_DUPLICATES_TOOL,
        args: {
          transactionIds: [suggestion.transactionId, suggestion.candidateId],
          survivorId: chooseSurvivor({ candidates: rows }),
        },
      });
      // `bulkCreate` hands back instances that still count as new, so the link is written by id.
      if (proposal) {
        await DuplicateSuggestions.update({ proposalId: proposal.proposalId }, { where: { id: suggestion.id } });
      }
    }
  },
);

/** Runs a posting step for an event or a job: a failure is logged and never reaches the payment. */
export const safely = async ({ what, fn }: { what: string; fn: () => Promise<unknown> }): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    logger.error({ message: `Failed to ${what} in the automation inbox`, error: error as Error });
  }
};
