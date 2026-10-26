import { DataTypes, QueryInterface } from 'sequelize';

/**
 * "ChatThreads"."effort": how hard the thread's model thinks on its next run (one of the levels the model
 * accepts). Null is the provider's own default, which every existing thread keeps. Plain text rather than a
 * database enum: the set of levels follows the providers and changes without a migration.
 */
module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'ChatThreads',
        'effort',
        { type: DataTypes.STRING(16), allowNull: true },
        { transaction },
      );
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('ChatThreads', 'effort', { transaction });
    });
  },
};
