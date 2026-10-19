import type { IngestScope, IngestTokenPurpose, RecordId } from '@bt/shared/types';
import { IdColumn } from '@common/types/id-column';
import { Table, Column, Model, ForeignKey, BelongsTo, DataType } from 'sequelize-typescript';

import Users from './users.model';

/**
 * A personal credential for machine clients (an iOS Shortcut, a script). Only the SHA-256 hash of
 * the secret is stored; the secret itself is returned once, at creation.
 */
@Table({
  tableName: 'IngestTokens',
  timestamps: true,
  freezeTableName: true,
})
export default class IngestTokens extends Model {
  @Column(IdColumn())
  declare id: RecordId;

  @ForeignKey(() => Users)
  @Column({ type: DataType.INTEGER, allowNull: false })
  userId!: number;

  @Column({ type: DataType.STRING(100), allowNull: false })
  name!: string;

  @Column({ type: DataType.STRING(32), allowNull: false, defaultValue: 'general' })
  purpose!: IngestTokenPurpose;

  /** `hashToken` of the secret. Unique: the lookup key of every authenticated request. */
  @Column({ type: DataType.STRING(64), allowNull: false, unique: true })
  tokenHash!: string;

  @Column({ type: DataType.STRING(16), allowNull: false })
  start!: string;

  @Column({ type: DataType.ARRAY(DataType.TEXT), allowNull: false })
  scopes!: IngestScope[];

  @Column({ type: DataType.DATE, allowNull: true })
  lastUsedAt!: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  expiresAt!: Date | null;

  declare createdAt: Date;
  declare updatedAt: Date;

  @BelongsTo(() => Users)
  user!: Users;
}
