import type { NotificationSourceCounters, NotificationSourceMode, RecordId } from '@bt/shared/types';
import { IdColumn } from '@common/types/id-column';
import { Table, Column, Model, ForeignKey, BelongsTo, DataType } from 'sequelize-typescript';

import Accounts from './accounts.model';
import ChatProposals from './chat-proposals.model';
import Users from './users.model';

/**
 * One app (or, for messaging and mail apps, one sender in an app) that sends notifications to the
 * notification ingest. `mode` says whether its notifications may reach the AI: `auto` and `approved`
 * do, `pending` waits for the user and `muted` is dropped. `counters` tallies what was dropped before
 * anything was stored.
 */
@Table({
  tableName: 'NotificationSources',
  timestamps: true,
  freezeTableName: true,
})
export default class NotificationSources extends Model {
  @Column(IdColumn())
  declare id: RecordId;

  @ForeignKey(() => Users)
  @Column({ type: DataType.INTEGER, allowNull: false })
  userId!: number;

  /** `buildSourceKey` of the app and, for a conversational app, the sender. Unique per user. */
  @Column({ type: DataType.STRING(255), allowNull: false })
  sourceKey!: string;

  @Column({ type: DataType.STRING(255), allowNull: true })
  appName!: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  bundleId!: string | null;

  /** The title of a conversational app's notification; null for every other app. */
  @Column({ type: DataType.STRING(255), allowNull: true })
  sender!: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  conversational!: boolean;

  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'pending' })
  mode!: NotificationSourceMode;

  /** The account a payment from this source is logged on when the text names no card. */
  @ForeignKey(() => Accounts)
  @Column({ type: DataType.UUID, allowNull: true })
  defaultAccountId!: RecordId | null;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  counters!: NotificationSourceCounters;

  /** The inbox card asking whether to treat this source as a payment source. */
  @ForeignKey(() => ChatProposals)
  @Column({ type: DataType.UUID, allowNull: true })
  proposalId!: RecordId | null;

  @Column({ type: DataType.DATE, allowNull: true })
  lastSeenAt!: Date | null;

  declare createdAt: Date;
  declare updatedAt: Date;

  @BelongsTo(() => Users)
  user!: Users;

  @BelongsTo(() => Accounts)
  defaultAccount!: Accounts | null;
}
