import { DataTypes, QueryInterface } from 'sequelize';

/**
 * Hold and release: two ingest requests that cancelled each other out (a card hold and the release
 * of it) point at each other through `pairedRequestId`, and both end `dismissed` with the reason
 * `holdReleased`.
 */
module.exports = {
  async up(queryInterface: QueryInterface): Promise<void> {
    await queryInterface.addColumn('IngestRequests', 'pairedRequestId', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'IngestRequests', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
      comment: 'The request this one cancelled out against (a hold and its release)',
    });
  },

  async down(queryInterface: QueryInterface): Promise<void> {
    await queryInterface.removeColumn('IngestRequests', 'pairedRequestId');
  },
};
