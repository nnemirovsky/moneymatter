import { describe, expect, it } from '@jest/globals';
import { connection } from '@models/index';

import { BACKUP_EXCLUDED, BACKUP_TABLES, REFERENCE_TABLES } from './registry';

const tierOf = ({ modelName }: { modelName: string }) =>
  BACKUP_TABLES.find((e) => e.model === connection.sequelize.models[modelName])!.tier;

describe('backup registry drift guard', () => {
  it('every registered Sequelize model has an explicit backup decision', () => {
    // Compare by class reference: a model registered with Sequelize but absent
    // from BACKUP_TABLES / REFERENCE_TABLES / BACKUP_EXCLUDED shows up here, and
    // so does a registry entry whose model name resolved to `undefined`.
    const covered = new Set<unknown>([...BACKUP_TABLES, ...REFERENCE_TABLES, ...BACKUP_EXCLUDED].map((e) => e.model));

    const registered = Object.values(connection.sequelize.models) as { name: string }[];
    const uncovered = registered.filter((model) => !covered.has(model)).map((model) => model.name);

    expect(uncovered).toEqual([]);
  });

  it('file names are unique', () => {
    const names = BACKUP_TABLES.map((t) => t.fileName);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(['ChatThreads', 'ChatMessages', 'ChatProposals', 'ChatAttachments'])(
    '%s is excluded from backups with a reason',
    (modelName) => {
      const model = connection.sequelize.models[modelName];
      expect(model).toBeDefined();

      const entry = BACKUP_EXCLUDED.find((e) => e.model === model);
      expect(entry).toBeDefined();
      expect(entry!.reason.trim().length).toBeGreaterThan(0);

      const restored = [...BACKUP_TABLES, ...REFERENCE_TABLES].some((e) => e.model === model);
      expect(restored).toBe(false);
    },
  );

  it.each(['NotificationSources', 'DuplicateSuggestions'])(
    '%s is part of the backup, with its chat card reference nulled',
    (modelName) => {
      const model = connection.sequelize.models[modelName];
      expect(model).toBeDefined();

      const entry = BACKUP_TABLES.find((e) => e.model === model);
      expect(entry).toBeDefined();
      expect(entry!.restoreMode).toBe('insert');
      expect(entry!.scope).toEqual({ strategy: 'userColumn', column: 'userId' });
      expect(entry!.nullOnRestore).toEqual(['proposalId']);

      expect(BACKUP_EXCLUDED.some((e) => e.model === model)).toBe(false);
    },
  );

  it('restores the new tables after the tables their rows point at', () => {
    expect(tierOf({ modelName: 'NotificationSources' })).toBeGreaterThan(tierOf({ modelName: 'Accounts' }));
    expect(tierOf({ modelName: 'DuplicateSuggestions' })).toBeGreaterThan(tierOf({ modelName: 'Transactions' }));
    expect(tierOf({ modelName: 'DuplicateSuggestions' })).toBeGreaterThan(tierOf({ modelName: 'Accounts' }));
  });

  it('keeps the ingest request log out of the backup', () => {
    const model = connection.sequelize.models.IngestRequests;

    expect(BACKUP_EXCLUDED.some((e) => e.model === model)).toBe(true);
    expect(BACKUP_TABLES.some((e) => e.model === model)).toBe(false);
  });
});
