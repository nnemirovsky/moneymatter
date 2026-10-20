import { DataTypes, QueryInterface } from 'sequelize';

/**
 * Notification ingest: the pipeline discriminator and the encrypted text of ingest requests, the
 * notification source list, the duplicate suggestions, the amount-gate level, card last digits, the
 * per-currency card links and the automation inbox columns of chat threads.
 *
 * A card link now serves one currency (`currencyCode`) or, with a null currency, is the card's
 * default. The unique indexes treat a null currency as the empty string, so a card holds at most one
 * default row and one row per currency. Existing links become defaults.
 *
 * `down` drops the new columns and tables with every row in them, deletes the automation inbox
 * threads first (they would otherwise turn into ordinary chats) and keeps one link per card label:
 * the currency-specific links are deleted.
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
        'NotificationSources',
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
          sourceKey: {
            type: DataTypes.STRING(255),
            allowNull: false,
            comment: 'buildSourceKey: the bundle id or app name, plus the sender for messaging and mail apps',
          },
          appName: {
            type: DataTypes.STRING(255),
            allowNull: true,
          },
          bundleId: {
            type: DataTypes.STRING(255),
            allowNull: true,
          },
          sender: {
            type: DataTypes.STRING(255),
            allowNull: true,
            comment: 'The notification title of a messaging or mail app; null for other apps',
          },
          conversational: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          mode: {
            type: DataTypes.STRING(16),
            allowNull: false,
            defaultValue: 'pending',
            comment: 'NotificationSourceMode: auto | pending | approved | muted',
          },
          defaultAccountId: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'Accounts', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          counters: {
            type: DataTypes.JSONB,
            allowNull: false,
            defaultValue: {},
            comment: 'Notifications dropped before anything was stored, by reason',
          },
          proposalId: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'ChatProposals', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
            comment: 'The inbox card that asks whether to treat the source as a payment source',
          },
          lastSeenAt: {
            type: DataTypes.DATE,
            allowNull: true,
          },
          ...timestamps,
        },
        { transaction },
      );

      await queryInterface.addIndex('NotificationSources', ['userId', 'sourceKey'], {
        unique: true,
        name: 'NotificationSources_userId_sourceKey_unique',
        transaction,
      });
      await queryInterface.addIndex('NotificationSources', ['defaultAccountId'], { transaction });
      await queryInterface.addIndex('NotificationSources', ['proposalId'], { transaction });

      await queryInterface.createTable(
        'DuplicateSuggestions',
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
          accountId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'Accounts', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          transactionId: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'Transactions', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
            comment: 'The smaller id of the pair; null once the transaction is hard-deleted',
          },
          candidateId: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'Transactions', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
            comment: 'The larger id of the pair; null once the transaction is hard-deleted',
          },
          confidence: {
            type: DataTypes.DECIMAL(4, 3),
            allowNull: false,
          },
          reason: {
            type: DataTypes.TEXT,
            allowNull: true,
          },
          trigger: {
            type: DataTypes.STRING(16),
            allowNull: false,
            comment: 'DuplicateSuggestionTrigger: ingest | scan',
          },
          status: {
            type: DataTypes.STRING(16),
            allowNull: false,
            defaultValue: 'open',
            comment: 'DuplicateSuggestionStatus: open | merged | dismissed | stale',
          },
          proposalId: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'ChatProposals', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          resolvedAt: {
            type: DataTypes.DATE,
            allowNull: true,
          },
          ...timestamps,
        },
        { transaction },
      );

      await queryInterface.addIndex('DuplicateSuggestions', ['transactionId', 'candidateId'], {
        unique: true,
        name: 'DuplicateSuggestions_pair_unique',
        transaction,
      });
      await queryInterface.addIndex('DuplicateSuggestions', ['userId', 'status'], { transaction });
      await queryInterface.addIndex('DuplicateSuggestions', ['accountId'], { transaction });
      await queryInterface.addIndex('DuplicateSuggestions', ['candidateId'], { transaction });
      await queryInterface.addIndex('DuplicateSuggestions', ['proposalId'], { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE "DuplicateSuggestions"
           ADD CONSTRAINT "DuplicateSuggestions_pair_ordered" CHECK ("transactionId" < "candidateId")`,
        { transaction },
      );

      await queryInterface.addColumn(
        'IngestRequests',
        'pipeline',
        {
          type: DataTypes.STRING(16),
          allowNull: false,
          defaultValue: 'cardPayment',
          comment: 'IngestPipeline: cardPayment | notification. Set by the server; source is the client label',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'IngestRequests',
        'textEnc',
        {
          type: DataTypes.TEXT,
          allowNull: true,
          comment: 'Notification title, subtitle, body and raw text, encryptToken output. Null once wiped',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'IngestRequests',
        'parsed',
        {
          type: DataTypes.JSONB,
          allowNull: true,
          comment: 'What the parser read from a notification',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'IngestRequests',
        'attempts',
        {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
          comment: 'How many times processing was enqueued; part of the job id',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'IngestRequests',
        'sourceId',
        {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'NotificationSources', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'IngestRequests',
        'proposalId',
        {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'ChatProposals', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        { transaction },
      );
      await queryInterface.addIndex('IngestRequests', ['sourceId'], { transaction });
      await queryInterface.addIndex('IngestRequests', ['proposalId'], { transaction });
      await queryInterface.addIndex('IngestRequests', ['userId', 'pipeline', 'status'], {
        name: 'IngestRequests_userId_pipeline_status',
        transaction,
      });
      await queryInterface.sequelize.query(
        `COMMENT ON COLUMN "IngestRequests"."status" IS 'IngestRequestStatus: received | logged | parked | rejected | dismissed | ignored'`,
        { transaction },
      );

      await queryInterface.addColumn(
        'IngestSettings',
        'gateStrictness',
        {
          type: DataTypes.STRING(16),
          allowNull: false,
          defaultValue: 'standard',
          comment: 'GateStrictness: strict | standard | loose',
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'CardAccountMappings',
        'lastDigits',
        {
          type: DataTypes.STRING(8),
          allowNull: true,
          comment: "The card's last digits, for a notification that names no Wallet card",
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'CardAccountMappings',
        'currencyCode',
        {
          // Wide enough for a custom currency code (CURRENCY_CODE_MAX_LENGTH).
          type: DataTypes.STRING(16),
          allowNull: true,
          comment: 'The currency this link serves; null is the default link of the card',
        },
        { transaction },
      );
      await queryInterface.removeIndex('CardAccountMappings', 'CardAccountMappings_userId_normalizedLabel_unique', {
        transaction,
      });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "CardAccountMappings_card_currency_unique"
         ON "CardAccountMappings" ("userId", "normalizedLabel", COALESCE("currencyCode", ''));`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "CardAccountMappings_lastDigits_currency_unique"
         ON "CardAccountMappings" ("userId", "lastDigits", COALESCE("currencyCode", ''))
         WHERE "lastDigits" IS NOT NULL;`,
        { transaction },
      );

      await queryInterface.addColumn(
        'ChatThreads',
        'kind',
        {
          type: DataTypes.STRING(24),
          allowNull: false,
          defaultValue: 'chat',
          comment: 'ChatThreadKind: chat | automationInbox',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'ChatThreads',
        'inboxState',
        {
          type: DataTypes.STRING(8),
          allowNull: true,
          comment: 'ChatInboxState: live | open | closed. Null on a chat thread',
        },
        { transaction },
      );
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "ChatThreads_userId_live_inbox_unique"
         ON "ChatThreads" ("userId") WHERE "inboxState" = 'live';`,
        { transaction },
      );
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`DELETE FROM "ChatThreads" WHERE "kind" = 'automationInbox'`, {
        transaction,
      });
      await queryInterface.sequelize.query(`DROP INDEX "ChatThreads_userId_live_inbox_unique";`, { transaction });
      await queryInterface.removeColumn('ChatThreads', 'inboxState', { transaction });
      await queryInterface.removeColumn('ChatThreads', 'kind', { transaction });

      await queryInterface.sequelize.query(`DELETE FROM "CardAccountMappings" WHERE "currencyCode" IS NOT NULL`, {
        transaction,
      });
      await queryInterface.sequelize.query(`DROP INDEX "CardAccountMappings_lastDigits_currency_unique";`, {
        transaction,
      });
      await queryInterface.sequelize.query(`DROP INDEX "CardAccountMappings_card_currency_unique";`, { transaction });
      await queryInterface.removeColumn('CardAccountMappings', 'currencyCode', { transaction });
      await queryInterface.addIndex('CardAccountMappings', ['userId', 'normalizedLabel'], {
        unique: true,
        name: 'CardAccountMappings_userId_normalizedLabel_unique',
        transaction,
      });
      await queryInterface.removeColumn('CardAccountMappings', 'lastDigits', { transaction });

      await queryInterface.removeColumn('IngestSettings', 'gateStrictness', { transaction });

      await queryInterface.sequelize.query(`DELETE FROM "IngestRequests" WHERE "pipeline" = 'notification'`, {
        transaction,
      });
      await queryInterface.sequelize.query(
        `COMMENT ON COLUMN "IngestRequests"."status" IS 'IngestRequestStatus: received | logged | parked | rejected | dismissed'`,
        { transaction },
      );
      await queryInterface.removeIndex('IngestRequests', 'IngestRequests_userId_pipeline_status', { transaction });
      await queryInterface.removeColumn('IngestRequests', 'proposalId', { transaction });
      await queryInterface.removeColumn('IngestRequests', 'sourceId', { transaction });
      await queryInterface.removeColumn('IngestRequests', 'attempts', { transaction });
      await queryInterface.removeColumn('IngestRequests', 'parsed', { transaction });
      await queryInterface.removeColumn('IngestRequests', 'textEnc', { transaction });
      await queryInterface.removeColumn('IngestRequests', 'pipeline', { transaction });

      await queryInterface.dropTable('DuplicateSuggestions', { transaction });
      await queryInterface.dropTable('NotificationSources', { transaction });
    });
  },
};
