import type { GateStrictness } from '@bt/shared/types';
import { Table, Column, Model, ForeignKey, BelongsTo, DataType } from 'sequelize-typescript';

import Users from './users.model';

/**
 * Per-user ingest settings. Holds the Cloudflare Access service-token headers the setup code
 * carries to the shortcut. Both values are `encryptToken` output and are never serialized
 * into an API response.
 */
@Table({
  tableName: 'IngestSettings',
  timestamps: true,
  freezeTableName: true,
})
export default class IngestSettings extends Model {
  @ForeignKey(() => Users)
  @Column({ type: DataType.INTEGER, primaryKey: true, allowNull: false })
  userId!: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  accessClientIdEnc!: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  accessClientSecretEnc!: string | null;

  /** How strict the amount gate is, on the device and on the server. */
  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'standard' })
  gateStrictness!: GateStrictness;

  declare createdAt: Date;
  declare updatedAt: Date;

  @BelongsTo(() => Users)
  user!: Users;
}
