import type { RecordId } from '@bt/shared/types';
import { CURRENCY_CODE_MAX_LENGTH } from '@common/lib/currency-code-columns';
import { IdColumn } from '@common/types/id-column';
import { Table, Column, Model, ForeignKey, BelongsTo, DataType } from 'sequelize-typescript';

import Accounts from './accounts.model';
import Users from './users.model';

/**
 * Links a card to the account its payments are logged on. A card is the rows that share a
 * `normalizedLabel` (and, when set, `lastDigits`); it holds one row per `currencyCode` plus at most
 * one default row (null `currencyCode`). `cardLabel` keeps the user's own spelling for display.
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

  /** `normalizeCardLabel` of `cardLabel`. Unique per user and currency. */
  @Column({ type: DataType.STRING(255), allowNull: false })
  normalizedLabel!: string;

  /** The card's last digits, for a notification that names no Wallet card. Shared by every row of the card. */
  @Column({ type: DataType.STRING(8), allowNull: true })
  lastDigits!: string | null;

  /** The currency of the payments this row serves; null makes the card's default row. */
  @Column({ type: DataType.STRING(CURRENCY_CODE_MAX_LENGTH), allowNull: true })
  currencyCode!: string | null;

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
