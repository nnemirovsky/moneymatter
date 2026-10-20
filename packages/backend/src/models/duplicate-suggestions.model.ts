import type { DuplicateSuggestionStatus, DuplicateSuggestionTrigger, RecordId } from '@bt/shared/types';
import { IdColumn } from '@common/types/id-column';
import { Table, Column, Model, ForeignKey, BelongsTo, DataType } from 'sequelize-typescript';

import Accounts from './accounts.model';
import ChatProposals from './chat-proposals.model';
import Transactions from './transactions.model';
import Users from './users.model';

/**
 * A pair of transactions the AI judge thinks record one payment. It is a suggestion only: nothing is
 * merged until the user merges the pair through Reconciliation (or its inbox card).
 *
 * The pair is stored ordered (`transactionId` < `candidateId`), so one pair is one row. Either side
 * becomes null when its transaction is hard-deleted, and the sweep then marks the row `stale`.
 */
@Table({
  tableName: 'DuplicateSuggestions',
  timestamps: true,
  freezeTableName: true,
})
export default class DuplicateSuggestions extends Model {
  @Column(IdColumn())
  declare id: RecordId;

  @ForeignKey(() => Users)
  @Column({ type: DataType.INTEGER, allowNull: false })
  userId!: number;

  @ForeignKey(() => Accounts)
  @Column({ type: DataType.UUID, allowNull: false })
  accountId!: RecordId;

  @ForeignKey(() => Transactions)
  @Column({ type: DataType.UUID, allowNull: true })
  transactionId!: RecordId | null;

  @ForeignKey(() => Transactions)
  @Column({ type: DataType.UUID, allowNull: true })
  candidateId!: RecordId | null;

  /** The judge's confidence, 0 to 1. */
  @Column({ type: DataType.DECIMAL(4, 3), allowNull: false })
  confidence!: string | number;

  /** The judge's one-line reason. */
  @Column({ type: DataType.TEXT, allowNull: true })
  reason!: string | null;

  @Column({ type: DataType.STRING(16), allowNull: false })
  trigger!: DuplicateSuggestionTrigger;

  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'open' })
  status!: DuplicateSuggestionStatus;

  /** The inbox card for this suggestion. */
  @ForeignKey(() => ChatProposals)
  @Column({ type: DataType.UUID, allowNull: true })
  proposalId!: RecordId | null;

  @Column({ type: DataType.DATE, allowNull: true })
  resolvedAt!: Date | null;

  declare createdAt: Date;
  declare updatedAt: Date;

  @BelongsTo(() => Users)
  user!: Users;

  @BelongsTo(() => Accounts)
  account!: Accounts;

  @BelongsTo(() => Transactions, { foreignKey: 'transactionId', onDelete: 'SET NULL' })
  transaction!: Transactions | null;

  @BelongsTo(() => Transactions, { foreignKey: 'candidateId', onDelete: 'SET NULL' })
  candidate!: Transactions | null;
}
