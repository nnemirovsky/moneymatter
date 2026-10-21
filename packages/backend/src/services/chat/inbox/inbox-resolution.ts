import ChatProposals from '@models/chat-proposals.model';
import { connection } from '@models/connection';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';
import { Op, QueryTypes } from 'sequelize';

import { notifyThreadUpdated } from '../threads/thread-events';
import {
  CONFIRM_TOOL,
  LINK_TRANSFER_TOOL,
  LOG_INGEST_REQUEST_TOOL,
  OPEN_CARD_STATUSES,
  SET_NOTIFICATION_SOURCE_TOOL,
} from './inbox-transitions';

/** Why the card was closed without the owner acting on it. */
const RESOLVED_ELSEWHERE = 'resolvedElsewhere';

/**
 * Closes the waiting cards among `proposalIds` because the record behind them was settled somewhere
 * else (a suggestion merged in Reconciliation, a request dismissed from the waiting list, a payment
 * edited in the ledger). The card ends `rejected` with `statusReason: 'resolvedElsewhere'`. A card
 * that is already decided is left as it is, so the call is safe from the card's own approve and reject.
 *
 * The thread is re-evaluated and the clients told once the surrounding transaction commits.
 */
export const resolveCardsElsewhere = withTransaction(
  async ({ proposalIds }: { proposalIds: ReadonlyArray<string | null | undefined> }): Promise<number> => {
    const ids = [...new Set(proposalIds.filter((id): id is string => Boolean(id)))];
    if (!ids.length) return 0;

    const [, rows] = await ChatProposals.update(
      { status: 'rejected', statusReason: RESOLVED_ELSEWHERE, decidedAt: new Date() },
      { where: { id: { [Op.in]: ids }, status: { [Op.in]: [...OPEN_CARD_STATUSES] } }, returning: true },
    );
    if (!rows.length) return 0;

    const threads = new Map(rows.map((row) => [row.threadId as string, row.userId]));
    await runAfterCommit({
      fn: async () => {
        // Loaded here, not at the top: this module is imported by the transaction services, and the
        // thread code pulls in the whole model registry.
        const { reevaluateInboxThreads } = await import('./inbox-thread');
        await reevaluateInboxThreads({ threadIds: [...threads.keys()] });
        for (const [threadId, userId] of threads) notifyThreadUpdated({ userId, threadId });
      },
    });

    return rows.length;
  },
);

/**
 * The ids of the waiting cards that are about these transactions: a confirm card names its payment
 * in `transactionId`, a "link as transfer" card the two legs in `baseTxId` and `oppositeTxId`.
 */
export const findCardsOfTransactions = async ({
  transactionIds,
  toolNames = [CONFIRM_TOOL, LINK_TRANSFER_TOOL],
}: {
  transactionIds: readonly string[];
  toolNames?: readonly string[];
}): Promise<string[]> => {
  if (!transactionIds.length) return [];

  const rows = (await connection.sequelize.query(
    `SELECT "id" FROM "ChatProposals"
      WHERE "status" IN (:statuses)
        AND "toolName" IN (:toolNames)
        AND (
          "args"->>'transactionId' IN (:ids)
          OR "args"->>'baseTxId' IN (:ids)
          OR "args"->>'oppositeTxId' IN (:ids)
        )`,
    {
      replacements: { statuses: [...OPEN_CARD_STATUSES], toolNames: [...toolNames], ids: [...transactionIds] },
      type: QueryTypes.SELECT,
    },
  )) as { id: string }[];

  return rows.map((row) => row.id);
};

/** Closes the "link as transfer?" card of exactly this pair; the pair was dismissed or answered elsewhere. */
export const resolveTransferPairCard = withTransaction(
  async ({ baseTxId, oppositeTxId }: { baseTxId: string; oppositeTxId: string }): Promise<void> => {
    const rows = (await connection.sequelize.query(
      `SELECT "id" FROM "ChatProposals"
        WHERE "status" IN (:statuses)
          AND "toolName" = :toolName
          AND "args"->>'baseTxId' = :baseTxId
          AND "args"->>'oppositeTxId' = :oppositeTxId`,
      {
        replacements: { statuses: [...OPEN_CARD_STATUSES], toolName: LINK_TRANSFER_TOOL, baseTxId, oppositeTxId },
        type: QueryTypes.SELECT,
      },
    )) as { id: string }[];

    await resolveCardsElsewhere({ proposalIds: rows.map((row) => row.id) });
  },
);

/**
 * Settles what the inbox holds about payments that were edited, linked, merged, hidden or deleted
 * outside the card: the waiting cards about them close (`resolvedElsewhere`), and with
 * `markConfirmed` the rows also stop being unconfirmed (an edit is the owner's word on the row).
 */
export const settleTransactionCards = withTransaction(
  async ({
    transactionIds,
    markConfirmed = false,
    toolNames,
  }: {
    transactionIds: readonly string[];
    markConfirmed?: boolean;
    toolNames?: readonly string[];
  }): Promise<void> => {
    if (!transactionIds.length) return;

    if (markConfirmed) await clearUnconfirmed({ transactionIds });
    await resolveCardsElsewhere({ proposalIds: await findCardsOfTransactions({ transactionIds, toolNames }) });
  },
);

/**
 * Removes `externalData.ingest.unconfirmed` from the rows that carry it. A raw statement on purpose:
 * it must reach plans and hidden rows, and it leaves `updatedAt` alone, since confirming is not an
 * edit anyone else needs to see.
 */
export const clearUnconfirmed = async ({ transactionIds }: { transactionIds: readonly string[] }): Promise<void> => {
  if (!transactionIds.length) return;

  await connection.sequelize.query(
    `-- planned-ok: the marker lives on plans and on hidden rows too, so the base table is written on purpose
    UPDATE "Transactions"
        SET "externalData" = "externalData" #- '{ingest,unconfirmed}'
      WHERE "id" IN (:ids) AND "externalData" #> '{ingest,unconfirmed}' = 'true'::jsonb`,
    { replacements: { ids: [...transactionIds] }, type: QueryTypes.UPDATE },
  );
};

/**
 * Closes the waiting inbox cards whose record is gone or settled by a path that did not close them
 * (a sync that hard-deleted a payment, an import rollback, a request that expired). The cleanup cron
 * runs it as the backstop to the hooks at each call site; it returns how many cards it closed.
 */
export const sweepOrphanedInboxCards = async (): Promise<number> => {
  const rows = (await connection.sequelize.query(
    `-- planned-ok: a card about a plan or a hidden row is about that row, so the base table is read on purpose
    SELECT p."id" FROM "ChatProposals" AS p
      WHERE p."status" IN (:statuses)
        AND (
          (p."toolName" = :confirmTool AND NOT EXISTS (
            SELECT 1 FROM "Transactions" AS t
             WHERE t."id"::text = p."args"->>'transactionId'
               AND t."deletedAt" IS NULL
               AND t."externalData" #> '{ingest,unconfirmed}' = 'true'::jsonb
          ))
          OR (p."toolName" = :linkTool AND (
            NOT EXISTS (SELECT 1 FROM "Transactions" AS t WHERE t."id"::text = p."args"->>'baseTxId' AND t."deletedAt" IS NULL AND t."transferId" IS NULL)
            OR NOT EXISTS (SELECT 1 FROM "Transactions" AS t WHERE t."id"::text = p."args"->>'oppositeTxId' AND t."deletedAt" IS NULL AND t."transferId" IS NULL)
          ))
          OR (p."toolName" = :requestTool AND NOT EXISTS (
            SELECT 1 FROM "IngestRequests" AS r WHERE r."id"::text = p."args"->>'requestId' AND r."status" = 'parked'
          ))
          OR (p."toolName" = :sourceTool AND NOT EXISTS (
            SELECT 1 FROM "NotificationSources" AS s WHERE s."id"::text = p."args"->>'sourceId' AND s."mode" = 'pending'
          ))
        )`,
    {
      replacements: {
        statuses: [...OPEN_CARD_STATUSES],
        confirmTool: CONFIRM_TOOL,
        linkTool: LINK_TRANSFER_TOOL,
        requestTool: LOG_INGEST_REQUEST_TOOL,
        sourceTool: SET_NOTIFICATION_SOURCE_TOOL,
      },
      type: QueryTypes.SELECT,
    },
  )) as { id: string }[];

  return resolveCardsElsewhere({ proposalIds: rows.map((row) => row.id) });
};
