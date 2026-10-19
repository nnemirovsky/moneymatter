import type { IngestRequestStatus, RecordId } from '@bt/shared/types';
import { IdColumn } from '@common/types/id-column';
import { Table, Column, Model, ForeignKey, BelongsTo, DataType } from 'sequelize-typescript';

import IngestTokens from './ingest-tokens.model';
import Transactions from './transactions.model';
import Users from './users.model';

/**
 * One request a machine client sent to the ingest endpoint. The row is committed before the
 * request is processed, so a payment the processing could not handle is still on record.
 */
@Table({
  tableName: 'IngestRequests',
  timestamps: true,
  freezeTableName: true,
})
export default class IngestRequests extends Model {
  @Column(IdColumn())
  declare id: RecordId;

  @ForeignKey(() => Users)
  @Column({ type: DataType.INTEGER, allowNull: false })
  userId!: number;

  @ForeignKey(() => IngestTokens)
  @Column({ type: DataType.UUID, allowNull: true })
  tokenId!: RecordId | null;

  @Column({ type: DataType.STRING(32), allowNull: false })
  source!: string;

  /** Unique per user. */
  @Column({ type: DataType.STRING(128), allowNull: false })
  idempotencyKey!: string;

  @Column({ type: DataType.STRING(64), allowNull: false })
  fingerprint!: string;

  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'received' })
  status!: IngestRequestStatus;

  @Column({ type: DataType.STRING(64), allowNull: true })
  reason!: string | null;

  /** The request body as received. */
  @Column({ type: DataType.JSONB, allowNull: false })
  payload!: Record<string, unknown>;

  @Column({ type: DataType.STRING(100), allowNull: true })
  cardLabel!: string | null;

  @ForeignKey(() => Transactions)
  @Column({ type: DataType.UUID, allowNull: true })
  transactionId!: RecordId | null;

  /** The original request this one repeats within the repeat window. */
  @ForeignKey(() => IngestRequests)
  @Column({ type: DataType.UUID, allowNull: true })
  duplicateOfId!: RecordId | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  summary!: string | null;

  declare createdAt: Date;
  declare updatedAt: Date;

  @BelongsTo(() => Users)
  user!: Users;
}
