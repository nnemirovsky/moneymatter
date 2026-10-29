import { DataTypes, QueryInterface } from 'sequelize';

/**
 * "NotificationSources": `iconOverride` marks a source whose app the owner chose by hand. Its icon and bundle id
 * then belong to the owner, and the automatic icon lookup never replaces them.
 */
module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.addColumn('NotificationSources', 'iconOverride', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.removeColumn('NotificationSources', 'iconOverride');
  },
};
