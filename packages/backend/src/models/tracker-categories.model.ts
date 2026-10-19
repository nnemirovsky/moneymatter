import { RecordId } from '@bt/shared/types';
import { Table, Column, Model, ForeignKey, DataType } from 'sequelize-typescript';

import Categories from './categories.model';
import Trackers from './trackers.model';

/**
 * Junction table between Trackers and Categories; the same category can be
 * tracked by multiple trackers independently.
 */
@Table({ tableName: 'TrackerCategories', timestamps: false })
export default class TrackerCategories extends Model {
  @ForeignKey(() => Trackers)
  @Column({ primaryKey: true, allowNull: false, type: DataType.UUID })
  trackerId!: RecordId;

  @ForeignKey(() => Categories)
  @Column({ primaryKey: true, allowNull: false, type: DataType.UUID })
  categoryId!: RecordId;
}
