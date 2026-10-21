import { QueryInterface } from 'sequelize';

import { mergeInboxThreads } from './utils/merge-inbox-threads-20261022';

/**
 * One permanent Automation inbox per user. A user who has several inbox threads (one live, older ones open
 * or closed) keeps one: the live one, else the latest. The messages, cards and attachments of the others
 * move into it, and the emptied threads are deleted. The kept thread is pinned, never expires and stays
 * `live`. The partial unique index moves from "one live inbox per user" to "one inbox per user".
 *
 * `down` restores the old index. The merged threads are not split again: the one inbox per user that is
 * left also satisfies the old index.
 */
module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await mergeInboxThreads({ queryInterface, transaction });

      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "ChatThreads_userId_live_inbox_unique";`, {
        transaction,
      });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "ChatThreads_userId_inbox_unique"
         ON "ChatThreads" ("userId") WHERE kind = 'automationInbox';`,
        { transaction },
      );
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "ChatThreads_userId_inbox_unique";`, {
        transaction,
      });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "ChatThreads_userId_live_inbox_unique"
         ON "ChatThreads" ("userId") WHERE "inboxState" = 'live';`,
        { transaction },
      );
    });
  },
};
