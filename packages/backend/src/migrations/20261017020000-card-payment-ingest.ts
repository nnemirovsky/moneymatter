import { DataTypes, QueryInterface } from 'sequelize';

/**
 * Card-payment ingest: personal ingest tokens (and, in later parts of this file, card mappings,
 * the ingest request log and the Cloudflare Access header store).
 *
 * `down` drops the tables with every row in them.
 */
module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'IngestTokens',
        {
          id: {
            type: DataTypes.UUID,
            primaryKey: true,
            allowNull: false,
          },
          userId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'Users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          name: {
            type: DataTypes.STRING(100),
            allowNull: false,
          },
          purpose: {
            type: DataTypes.STRING(32),
            allowNull: false,
            defaultValue: 'general',
            comment: 'IngestTokenPurpose: general | card-payment-setup',
          },
          tokenHash: {
            type: DataTypes.STRING(64),
            allowNull: false,
            unique: true,
            comment: 'SHA-256 of the secret, base64url. The secret itself is never stored',
          },
          start: {
            type: DataTypes.STRING(16),
            allowNull: false,
            comment: 'First characters of the secret, for display',
          },
          scopes: {
            type: DataTypes.ARRAY(DataTypes.TEXT),
            allowNull: false,
          },
          lastUsedAt: {
            type: DataTypes.DATE,
            allowNull: true,
          },
          expiresAt: {
            type: DataTypes.DATE,
            allowNull: true,
          },
          createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
          },
          updatedAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
          },
        },
        { transaction },
      );

      await queryInterface.addIndex('IngestTokens', ['userId'], { transaction });
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('IngestTokens', { transaction });
    });
  },
};
