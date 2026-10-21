import { DataTypes, QueryInterface } from 'sequelize';

/**
 * "ChatThreads"."pageContext": the page the conversation is about, set when it starts and kept until
 * the user removes or replaces it. Its runs read it instead of a context per message. Null is no
 * context, which every existing thread keeps.
 */
module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'ChatThreads',
        'pageContext',
        { type: DataTypes.JSONB, allowNull: true },
        { transaction },
      );
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('ChatThreads', 'pageContext', { transaction });
    });
  },
};
