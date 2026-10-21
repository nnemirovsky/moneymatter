import { DataTypes, QueryInterface } from 'sequelize';

/**
 * `"ChatThreads"."lastReadAt"`: when the user last viewed the thread; a reply that finished after it is
 * unread and counts on the thread's badge. Every existing thread starts read up to its last reply, so
 * nothing old turns up as new.
 */
module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'ChatThreads',
        'lastReadAt',
        { type: DataTypes.DATE, allowNull: true, comment: 'When the user last viewed the thread' },
        { transaction },
      );
      await queryInterface.sequelize.query(
        `UPDATE "ChatThreads" AS t
         SET "lastReadAt" = GREATEST(
           t."lastMessageAt",
           (SELECT MAX(m."updatedAt") FROM "ChatMessages" AS m WHERE m."threadId" = t.id)
         );`,
        { transaction },
      );
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('ChatThreads', 'lastReadAt', { transaction });
    });
  },
};
