import { type QueryInterface } from 'sequelize';

import { createRealTransactionsViewSql, dropRealTransactionsViewSql } from './utils/real-transactions-view';

/**
 * "Transactions"."timeZone" (IANA name) and "utcOffsetMinutes" (the offset at "time"): where a
 * payment happened or was entered. Both are nullable and nothing is backfilled, so every existing
 * row stays "unknown" and displays as before.
 *
 * `real_transactions` is `SELECT * FROM "Transactions"`, whose column list freezes at creation, so
 * the view is rebuilt to expose the new columns. It keeps both filters (planned and soft-deleted).
 */
module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

      await run(dropRealTransactionsViewSql);
      await run(`ALTER TABLE "Transactions" ADD COLUMN "timeZone" VARCHAR(64) NULL;`);
      await run(`ALTER TABLE "Transactions" ADD COLUMN "utcOffsetMinutes" SMALLINT NULL;`);
      await run(
        `ALTER TABLE "Transactions" ADD CONSTRAINT "Transactions_utcOffsetMinutes_range" CHECK ("utcOffsetMinutes" IS NULL OR "utcOffsetMinutes" BETWEEN -840 AND 840);`,
      );
      await run(createRealTransactionsViewSql);
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

      await run(dropRealTransactionsViewSql);
      await run(`ALTER TABLE "Transactions" DROP CONSTRAINT "Transactions_utcOffsetMinutes_range";`);
      await run(`ALTER TABLE "Transactions" DROP COLUMN "utcOffsetMinutes";`);
      await run(`ALTER TABLE "Transactions" DROP COLUMN "timeZone";`);
      await run(createRealTransactionsViewSql);
    });
  },
};
