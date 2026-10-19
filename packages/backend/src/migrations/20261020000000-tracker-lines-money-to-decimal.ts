import { QueryInterface } from 'sequelize';

/**
 * Moves "TrackerLines"."limitAmount" from integer cents (BIGINT) to DECIMAL(36,18), like every other
 * money column (see `20261016000000-money-columns-to-decimal`). The table is created by
 * `20261017000000-tracker-lines` after that migration ran, so its column has to be converted here.
 * `up` divides by 100, which is lossless. `down` multiplies by 100 and rounds half away from zero.
 */
module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.query(
      `ALTER TABLE "TrackerLines" ALTER COLUMN "limitAmount" TYPE NUMERIC(36,18) USING "limitAmount"::numeric / 100;`,
    );
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.query(
      `ALTER TABLE "TrackerLines" ALTER COLUMN "limitAmount" TYPE BIGINT USING round("limitAmount" * 100)::bigint;`,
    );
  },
};
