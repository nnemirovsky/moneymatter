import type { IngestPipeline, IngestRequestStatus, RecordId } from '@bt/shared/types';
import { IdColumn } from '@common/types/id-column';
import { Table, Column, Model, ForeignKey, BelongsTo, DataType } from 'sequelize-typescript';

import ChatProposals from './chat-proposals.model';
import IngestTokens from './ingest-tokens.model';
import NotificationSources from './notification-sources.model';
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

  /** The pipeline that owns the request. Set by the server; `source` is the client's label and is never branched on. */
  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'cardPayment' })
  pipeline!: IngestPipeline;

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

  /** The request body as received. On a notification it holds metadata only; the text is in `textEnc`. */
  @Column({ type: DataType.JSONB, allowNull: false })
  payload!: Record<string, unknown>;

  /** A notification's title, subtitle, body and raw text, `encryptToken` output. Null once it is wiped. */
  @Column({ type: DataType.TEXT, allowNull: true })
  textEnc!: string | null;

  /** What the parser read from a notification; reduced to the parser, kind and confidence when it is not a payment. */
  @Column({ type: DataType.JSONB, allowNull: true })
  parsed!: Record<string, unknown> | null;

  /** How many times processing was enqueued. Part of the job id, so a retry always enqueues. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  attempts!: number;

  @ForeignKey(() => NotificationSources)
  @Column({ type: DataType.UUID, allowNull: true })
  sourceId!: RecordId | null;

  /** The inbox card that asks the user to settle this request. */
  @ForeignKey(() => ChatProposals)
  @Column({ type: DataType.UUID, allowNull: true })
  proposalId!: RecordId | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  cardLabel!: string | null;

  @ForeignKey(() => Transactions)
  @Column({ type: DataType.UUID, allowNull: true })
  transactionId!: RecordId | null;

  /** The original request this one repeats within the repeat window. */
  @ForeignKey(() => IngestRequests)
  @Column({ type: DataType.UUID, allowNull: true })
  duplicateOfId!: RecordId | null;

  /** The request this one cancelled out against: a hold and its release drop each other. */
  @ForeignKey(() => IngestRequests)
  @Column({ type: DataType.UUID, allowNull: true })
  pairedRequestId!: RecordId | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  summary!: string | null;

  declare createdAt: Date;
  declare updatedAt: Date;

  @BelongsTo(() => Users)
  user!: Users;
}
