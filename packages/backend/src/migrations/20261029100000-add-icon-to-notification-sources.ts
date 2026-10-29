import { DataTypes, QueryInterface } from 'sequelize';

/**
 * "NotificationSources": the app's icon as the App Store lists it, so a source is shown with its app's real icon.
 * `iconUrl` is the artwork URL, null when none was found; `resolvedBundleId` is the bundle id the lookup found
 * (the shortcut sends none); `iconCheckedAt` says when the lookup last ran, hit or miss, so a miss is not retried
 * on every render. Every existing source starts unchecked and is resolved in the background when it is listed.
 */
module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'NotificationSources',
        'iconUrl',
        { type: DataTypes.STRING(512), allowNull: true },
        { transaction },
      );
      await queryInterface.addColumn(
        'NotificationSources',
        'resolvedBundleId',
        { type: DataTypes.STRING(255), allowNull: true },
        { transaction },
      );
      await queryInterface.addColumn(
        'NotificationSources',
        'iconCheckedAt',
        { type: DataTypes.DATE, allowNull: true },
        { transaction },
      );
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const column of ['iconUrl', 'resolvedBundleId', 'iconCheckedAt']) {
        await queryInterface.removeColumn('NotificationSources', column, { transaction });
      }
    });
  },
};
