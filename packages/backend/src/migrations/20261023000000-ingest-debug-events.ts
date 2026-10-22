import { DataTypes, QueryInterface } from 'sequelize';

/**
 * `"IngestDebugEvents"`: the operator's trace of what the ingest endpoints did with a request from a
 * token listed in `INGEST_DEBUG_TOKEN_IDS`. Empty unless the operator turns it on; rows are deleted after
 * seven days by the ingest cleanup. Additive.
 */
module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'IngestDebugEvents',
        {
          id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
          userId: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: { model: 'Users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          tokenId: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'IngestTokens', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          endpoint: { type: DataTypes.STRING(64), allowNull: false },
          kind: { type: DataTypes.STRING(32), allowNull: true },
          httpStatus: { type: DataTypes.INTEGER, allowNull: false },
          app: { type: DataTypes.STRING(255), allowNull: true },
          bundleId: { type: DataTypes.STRING(255), allowNull: true },
          sender: {
            type: DataTypes.STRING(255),
            allowNull: true,
            comment: 'The title of a sender probe',
          },
          outcome: { type: DataTypes.STRING(32), allowNull: true },
          reason: { type: DataTypes.STRING(64), allowNull: true },
          decision: { type: DataTypes.TEXT, allowNull: false, comment: 'The decision path, steps joined by " > "' },
          steps: { type: DataTypes.JSONB, allowNull: false },
          response: {
            type: DataTypes.JSONB,
            allowNull: true,
            comment: 'The answer sent to the shortcut, without its text',
          },
          latencyMs: { type: DataTypes.INTEGER, allowNull: false },
          requestId: { type: DataTypes.UUID, allowNull: true },
          requestStatus: { type: DataTypes.STRING(16), allowNull: true },
          proposalId: { type: DataTypes.UUID, allowNull: true },
          transactionId: { type: DataTypes.UUID, allowNull: true },
          textEnc: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'encryptToken output: the notification text and the summary shown; never plain',
          },
          createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: queryInterface.sequelize.literal('NOW()'),
          },
          updatedAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: queryInterface.sequelize.literal('NOW()'),
          },
        },
        { transaction },
      );
      await queryInterface.addIndex('IngestDebugEvents', ['createdAt'], { transaction });
      await queryInterface.addIndex('IngestDebugEvents', ['tokenId', 'createdAt'], { transaction });
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.dropTable('IngestDebugEvents');
  },
};
