import type { RecordId } from '@bt/shared/types';
import { IdColumn } from '@common/types/id-column';
import { Table, Column, Model, ForeignKey, BelongsTo, DataType } from 'sequelize-typescript';

import Accounts from './accounts.model';
import Users from './users.model';

/**
 * Links a Wallet card name to the account its payments are logged on. A payment is matched by
 * `normalizedLabel`; `cardLabel` keeps the user's own spelling for display.
 */
@Table({
  tableName: 'CardAccountMappings',
  timestamps: true,
  freezeTableName: true,
})
export default class CardAccountMappings extends Model {
  @Column(IdColumn())
  declare id: RecordId;

  @ForeignKey(() => Users)
  @Column({ type: DataType.INTEGER, allowNull: false })
  userId!: number;

  @Column({ type: DataType.STRING(100), allowNull: false })
  cardLabel!: string;

  /** `normalizeCardLabel` of `cardLabel`. Unique per user. */
  @Column({ type: DataType.STRING(255), allowNull: false })
  normalizedLabel!: string;

  /** The card's last digits, for a notification that names no Wallet card. Unique per user when set. */
  @Column({ type: DataType.STRING(8), allowNull: true })
  lastDigits!: string | null;

  @ForeignKey(() => Accounts)
  @Column({ type: DataType.UUID, allowNull: false })
  accountId!: RecordId;

  declare createdAt: Date;
  declare updatedAt: Date;

  @BelongsTo(() => Users)
  user!: Users;

  @BelongsTo(() => Accounts)
  account!: Accounts;
}
