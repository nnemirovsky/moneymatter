import { DataTypes, QueryInterface } from 'sequelize';

/**
 * Card-payment ingest: personal ingest tokens, card-to-account mappings, the ingest request log
 * and the encrypted Cloudflare Access header store.
 *
 * `down` drops the tables with every row in them.
 */

const timestamps = {
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
};

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
          ...timestamps,
        },
        { transaction },
      );

      await queryInterface.addIndex('IngestTokens', ['userId'], { transaction });

      await queryInterface.createTable(
        'CardAccountMappings',
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
          cardLabel: {
            type: DataTypes.STRING(100),
            allowNull: false,
            comment: 'The Wallet card name as the user typed it',
          },
          normalizedLabel: {
            type: DataTypes.STRING(255),
            allowNull: false,
            comment: 'normalizeCardLabel(cardLabel): the lookup key of an incoming payment',
          },
          accountId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'Accounts', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          ...timestamps,
        },
        { transaction },
      );

      await queryInterface.addIndex('CardAccountMappings', ['userId', 'normalizedLabel'], {
        unique: true,
        name: 'CardAccountMappings_userId_normalizedLabel_unique',
        transaction,
      });
      await queryInterface.addIndex('CardAccountMappings', ['accountId'], { transaction });

      await queryInterface.createTable(
        'IngestRequests',
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
          tokenId: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'IngestTokens', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          source: {
            type: DataTypes.STRING(32),
            allowNull: false,
          },
          idempotencyKey: {
            type: DataTypes.STRING(128),
            allowNull: false,
          },
          fingerprint: {
            type: DataTypes.STRING(64),
            allowNull: false,
            comment: 'SHA-256 over the normalized card, amount text, currency and merchant; time stays out',
          },
          status: {
            type: DataTypes.STRING(16),
            allowNull: false,
            defaultValue: 'received',
            comment: 'IngestRequestStatus: received | logged | parked | rejected | dismissed',
          },
          reason: {
            type: DataTypes.STRING(64),
            allowNull: true,
            comment: 'Why a request is parked or rejected',
          },
          payload: {
            type: DataTypes.JSONB,
            allowNull: false,
            comment: 'The request body as received',
          },
          cardLabel: {
            type: DataTypes.STRING(100),
            allowNull: true,
          },
          transactionId: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'Transactions', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          duplicateOfId: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'IngestRequests', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
            comment: 'The original request this one repeats within the repeat window',
          },
          summary: {
            type: DataTypes.TEXT,
            allowNull: true,
          },
          ...timestamps,
        },
        { transaction },
      );

      await queryInterface.addIndex('IngestRequests', ['userId', 'idempotencyKey'], {
        unique: true,
        name: 'IngestRequests_userId_idempotencyKey_unique',
        transaction,
      });
      await queryInterface.addIndex('IngestRequests', ['userId', 'fingerprint', 'createdAt'], {
        name: 'IngestRequests_userId_fingerprint_createdAt',
        transaction,
      });
      await queryInterface.addIndex('IngestRequests', ['tokenId'], { transaction });
      await queryInterface.addIndex('IngestRequests', ['transactionId'], { transaction });

      await queryInterface.createTable(
        'IngestSettings',
        {
          userId: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            allowNull: false,
            references: { model: 'Users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          accessClientIdEnc: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Cloudflare Access client id, encryptToken',
          },
          accessClientSecretEnc: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Cloudflare Access client secret, encryptToken. Never returned by the API',
          },
          ...timestamps,
        },
        { transaction },
      );
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('IngestSettings', { transaction });
      await queryInterface.dropTable('IngestRequests', { transaction });
      await queryInterface.dropTable('CardAccountMappings', { transaction });
      await queryInterface.dropTable('IngestTokens', { transaction });
    });
  },
};
