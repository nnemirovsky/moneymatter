import { DataTypes, QueryInterface } from 'sequelize';

/**
 * "ChatThreads"."modelId": a model of the thread connection's provider that the thread's runs use
 * instead of the connection's own model. Null is the connection's own model, which every existing
 * thread keeps. The column has no foreign key for the same reason `connectionId` has none: the
 * connection lives in the user's settings JSON.
 */
module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'ChatThreads',
        'modelId',
        { type: DataTypes.STRING(200), allowNull: true },
        { transaction },
      );
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('ChatThreads', 'modelId', { transaction });
    });
  },
};
