import { DataTypes, QueryInterface } from 'sequelize';

/**
 * "ChatThreads"."connectionId": the AI connection a thread's runs use. AI connections live in the
 * user's settings JSON, not in a table, so the column has no foreign key: a connection deleted in
 * Settings leaves its id behind and the next run settles on another one.
 *
 * Null is the included server model, or no choice yet. Existing threads stay null and settle on the
 * connection that answers at their next run.
 */
module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'ChatThreads',
        'connectionId',
        { type: DataTypes.UUID, allowNull: true },
        { transaction },
      );
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('ChatThreads', 'connectionId', { transaction });
    });
  },
};
