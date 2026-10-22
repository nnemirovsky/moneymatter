import type { RecordId } from '@bt/shared/types';
import { IdColumn } from '@common/types/id-column';
import { Table, Column, Model, DataType } from 'sequelize-typescript';

/**
 * One request an operator-chosen ingest token made to an `/ingest/*` endpoint, with what the server
 * decided. Written only for the tokens in `INGEST_DEBUG_TOKEN_IDS`, after the response, best effort.
 * Notification text is only ever in `textEnc`, encrypted.
 */
@Table({
  tableName: 'IngestDebugEvents',
  timestamps: true,
  freezeTableName: true,
})
export default class IngestDebugEvents extends Model {
  @Column(IdColumn())
  declare id: RecordId;

  @Column({ type: DataType.INTEGER, allowNull: true })
  userId!: number | null;

  @Column({ type: DataType.UUID, allowNull: true })
  tokenId!: RecordId | null;

  @Column({ type: DataType.STRING(64), allowNull: false })
  endpoint!: string;

  @Column({ type: DataType.STRING(32), allowNull: true })
  kind!: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false })
  httpStatus!: number;

  @Column({ type: DataType.STRING(255), allowNull: true })
  app!: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  bundleId!: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  sender!: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  outcome!: string | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  reason!: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  decision!: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  steps!: unknown[];

  @Column({ type: DataType.JSONB, allowNull: true })
  response!: Record<string, unknown> | null;

  @Column({ type: DataType.INTEGER, allowNull: false })
  latencyMs!: number;

  @Column({ type: DataType.UUID, allowNull: true })
  requestId!: RecordId | null;

  @Column({ type: DataType.STRING(16), allowNull: true })
  requestStatus!: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  proposalId!: RecordId | null;

  @Column({ type: DataType.UUID, allowNull: true })
  transactionId!: RecordId | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  textEnc!: string | null;

  declare createdAt: Date;
  declare updatedAt: Date;
}
