import { RecordId } from '@bt/shared/types';
import { Table, Column, Model, ForeignKey, DataType } from 'sequelize-typescript';

import Trackers from './trackers.model';
import Transactions from './transactions.model';

/**
 * Per-row metadata captured at attach-time. Owner-attached rows leave the column
 * `null` entirely; recipient-attached rows carry a populated `TrackerTransactionMetadata`
 * with `addedByUserId` set so the revoke/leave sweep and the detach-permission check
 * can identify rows the recipient is allowed to touch. `addedByUserId` is required
 * (not optional) — a present metadata object without it is meaningless and would be
 * indistinguishable from `null`; the model column carries the recipient/owner
 * discriminator, not the field's optionality. Kept as a JSONB blob (not a typed
 * column) so future attributes can land without another migration.
 */
export interface TrackerTransactionMetadata {
  addedByUserId: number;
}

/** Transactions hand-picked into a tracker. */
@Table({ tableName: 'TrackerTransactions', timestamps: false })
export default class TrackerTransactions extends Model {
  @ForeignKey(() => Trackers)
  @Column({ primaryKey: true, allowNull: false, type: DataType.UUID })
  trackerId!: RecordId;

  @ForeignKey(() => Transactions)
  @Column({ primaryKey: true, allowNull: false, type: DataType.UUID })
  transactionId!: RecordId;

  @Column({ allowNull: true, type: DataType.JSONB })
  metadata!: TrackerTransactionMetadata | null;
}
