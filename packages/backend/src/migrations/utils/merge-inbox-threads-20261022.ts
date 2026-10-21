import type { QueryInterface, Transaction } from 'sequelize';

/**
 * Leaves each user one Automation inbox thread: the live one, else the latest. The messages, cards and
 * attachments of the others move into it, it takes their latest activity, and the emptied threads are
 * deleted. The kept thread is pinned, never expires and is `live`.
 *
 * Written for migration 20261022000000 and frozen with it: it reads the tables as they were then.
 */
export async function mergeInboxThreads({
  queryInterface,
  transaction,
}: {
  queryInterface: QueryInterface;
  transaction: Transaction;
}): Promise<void> {
  await queryInterface.sequelize.query(
    `CREATE TEMPORARY TABLE "InboxMerge" ON COMMIT DROP AS
     WITH ranked AS (
       SELECT id, "userId",
              ROW_NUMBER() OVER (
                PARTITION BY "userId"
                ORDER BY ("inboxState" = 'live') DESC NULLS LAST, "lastMessageAt" DESC, "createdAt" DESC, id DESC
              ) AS rank
       FROM "ChatThreads"
       WHERE kind = 'automationInbox'
     )
     SELECT merged.id AS "fromId", kept.id AS "toId"
     FROM ranked AS merged
     JOIN ranked AS kept ON kept."userId" = merged."userId" AND kept.rank = 1
     WHERE merged.rank > 1;`,
    { transaction },
  );

  for (const table of ['ChatMessages', 'ChatProposals', 'ChatAttachments']) {
    await queryInterface.sequelize.query(
      `UPDATE "${table}" AS row SET "threadId" = merge."toId"
       FROM "InboxMerge" AS merge
       WHERE row."threadId" = merge."fromId";`,
      { transaction },
    );
  }

  await queryInterface.sequelize.query(
    `UPDATE "ChatThreads" AS kept
     SET "lastMessageAt" = GREATEST(kept."lastMessageAt", merged."lastMessageAt")
     FROM (
       SELECT merge."toId", MAX(thread."lastMessageAt") AS "lastMessageAt"
       FROM "InboxMerge" AS merge
       JOIN "ChatThreads" AS thread ON thread.id = merge."fromId"
       GROUP BY merge."toId"
     ) AS merged
     WHERE kept.id = merged."toId";`,
    { transaction },
  );
  await queryInterface.sequelize.query(`DELETE FROM "ChatThreads" WHERE id IN (SELECT "fromId" FROM "InboxMerge");`, {
    transaction,
  });
  await queryInterface.sequelize.query(
    `UPDATE "ChatThreads" SET "inboxState" = 'live', pinned = TRUE, "expiresAt" = NULL
     WHERE kind = 'automationInbox';`,
    { transaction },
  );
  await queryInterface.sequelize.query(`DROP TABLE "InboxMerge";`, { transaction });
}
