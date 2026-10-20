import type { BackupTableDef } from '../registry';
import type { TableColumnPlan } from './analyze-archive';

/**
 * The overrides that null a table's `nullOnRestore` columns, limited to the columns the archive
 * carries (a column the file lacks is not written and takes its default). Keyed by DB field, like
 * the other row overrides.
 */
export const buildNullOnRestoreOverrides = ({
  def,
  plan,
}: {
  def: Pick<BackupTableDef, 'nullOnRestore'>;
  plan: Pick<TableColumnPlan, 'columns'>;
}): Record<string, null> => {
  const overrides: Record<string, null> = {};

  for (const attrName of def.nullOnRestore ?? []) {
    const column = plan.columns.find((c) => c.attrName === attrName);
    if (column) overrides[column.field] = null;
  }

  return overrides;
};
