import { QueryInterface, QueryTypes, Transaction } from 'sequelize';

type Pair = [string, string];

const TABLE_RENAMES: Pair[] = [
  ['Budgets', 'Trackers'],
  ['BudgetCategories', 'TrackerCategories'],
  ['BudgetTransactions', 'TrackerTransactions'],
];

const TRACKER_FK_TABLES = ['TrackerCategories', 'TrackerTransactions', 'TrackerLines', 'TrackerSuggestions'];
const TRACKER_TABLES = ['Trackers', ...TRACKER_FK_TABLES];

// Constraint/index/enum names differ between fresh and long-lived DBs, so they are
// introspected and rewritten token by token rather than listed by name.
const NAME_TOKEN_RENAMES: Pair[] = [
  ['BudgetCategories', 'TrackerCategories'],
  ['BudgetTransactions', 'TrackerTransactions'],
  ['budgetTransactions', 'trackerTransactions'],
  ['Budgets', 'Trackers'],
  ['budget_categories', 'tracker_categories'],
  ['budget_transactions', 'tracker_transactions'],
  ['budgets', 'trackers'],
  ['budgetId', 'trackerId'],
  ['budget_id', 'tracker_id'],
];

const renameName = ({ name, pairs }: { name: string; pairs: Pair[] }): string => {
  const map = new Map(pairs);
  return name.replace(new RegExp(pairs.map(([from]) => from).join('|'), 'g'), (token) => map.get(token)!);
};

const renameDbObjects = async ({
  queryInterface,
  transaction,
  pairs,
}: {
  queryInterface: QueryInterface;
  transaction: Transaction;
  pairs: Pair[];
}): Promise<void> => {
  const { sequelize } = queryInterface;
  const replacements = { tables: TRACKER_TABLES };

  const constraints = await sequelize.query<{
    tableName: string;
    name: string;
  }>(
    `SELECT c.relname AS "tableName", con.conname AS name
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname IN (:tables)`,
    { type: QueryTypes.SELECT, replacements, transaction },
  );
  for (const { tableName, name } of constraints) {
    const next = renameName({ name, pairs });
    if (next !== name) {
      await sequelize.query(`ALTER TABLE "${tableName}" RENAME CONSTRAINT "${name}" TO "${next}";`, { transaction });
    }
  }

  // Indexes backing PK/unique constraints were already renamed with their constraint.
  const indexes = await sequelize.query<{ name: string }>(
    `SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename IN (:tables)`,
    { type: QueryTypes.SELECT, replacements, transaction },
  );
  for (const { name } of indexes) {
    const next = renameName({ name, pairs });
    if (next !== name) {
      await sequelize.query(`ALTER INDEX "${name}" RENAME TO "${next}";`, {
        transaction,
      });
    }
  }

  const enums = await sequelize.query<{ name: string }>(
    `SELECT DISTINCT t.typname AS name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = current_schema() AND c.relname IN (:tables)
        AND t.typtype = 'e' AND NOT a.attisdropped`,
    { type: QueryTypes.SELECT, replacements, transaction },
  );
  for (const { name } of enums) {
    const next = renameName({ name, pairs });
    if (next !== name) {
      await sequelize.query(`ALTER TYPE "${name}" RENAME TO "${next}";`, {
        transaction,
      });
    }
  }
};

const flip = ({ pairs }: { pairs: Pair[] }): Pair[] => pairs.map(([from, to]) => [to, from]);

const SHARE_TABLE_CHECKS: Pair[] = [
  ['ResourceShares', 'chk_resource_shares_type_shape'],
  ['ShareInvitations', 'chk_share_invitations_type_shape'],
];

const UUID_REGEX = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

const resourceTypeShape = ({ trackerType }: { trackerType: string }): string => `
  ("resourceType" = 'account' AND "resourceId" ~* ${UUID_REGEX})
  OR
  ("resourceType" = 'household' AND "resourceId" ~ '^[0-9]+$' AND "resourceId" = "ownerUserId"::text)
  OR
  ("resourceType" = '${trackerType}' AND "resourceId" ~* ${UUID_REGEX})
`;

const RESOURCE_TYPE_RENAME: Pair = ['budget', 'tracker'];
const NOTIFICATION_TYPE_RENAMES: Pair[] = [
  ['budget_alert', 'tracker_alert'],
  ['share_owner_budget_deleted', 'share_owner_tracker_deleted'],
];
const NOTIFICATION_PAYLOAD_KEY_RENAMES: Pair[] = [
  ['budgetId', 'trackerId'],
  ['budgetName', 'trackerName'],
];
const NOTIFICATION_PREFERENCE_KEY_RENAMES: Pair[] = [['budget_alert', 'tracker_alert']];
const SAVED_VIEW_FILTER_KEY_RENAMES: Pair[] = [
  ['budgetIds', 'trackerIds'],
  ['excludedBudgetIds', 'excludedTrackerIds'],
];
const SETTINGS_ARRAY_VALUE_RENAMES: { path: string; pair: Pair }[] = [
  {
    path: '{ui,transactionsTable,extraFilters}',
    pair: ['budgets', 'trackers'],
  },
  {
    path: '{onboarding,completedTasks}',
    pair: ['create-budget', 'create-tracker'],
  },
];

const hasAnyKey = ({ source, pairs }: { source: string; pairs: Pair[] }): string =>
  `(${source}) ?| array[${pairs.map(([from]) => `'${from}'`).join(', ')}]`;

// Missing source keys become JSON null in jsonb_build_object and are stripped, so absent keys stay absent.
const renameKeys = ({ source, pairs }: { source: string; pairs: Pair[] }): string =>
  `((${source}) ${pairs.map(([from]) => `- '${from}'`).join(' ')}) || jsonb_strip_nulls(jsonb_build_object(${pairs
    .map(([from, to]) => `'${to}', (${source})->'${from}'`)
    .join(', ')}))`;

const renameStoredValues = async ({
  queryInterface,
  transaction,
  reverse,
}: {
  queryInterface: QueryInterface;
  transaction: Transaction;
  reverse: boolean;
}): Promise<void> => {
  const run = (sql: string) => queryInterface.sequelize.query(sql, { transaction });
  const orient = (pairs: Pair[]) => (reverse ? flip({ pairs }) : pairs);
  const orientPair = ([from, to]: Pair): Pair => (reverse ? [to, from] : [from, to]);
  const [fromResourceType, toResourceType] = orientPair(RESOURCE_TYPE_RENAME);

  for (const [table, constraint] of SHARE_TABLE_CHECKS) {
    await run(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}";`);
    await run(
      `UPDATE "${table}" SET "resourceType" = '${toResourceType}' WHERE "resourceType" = '${fromResourceType}';`,
    );
    await run(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" CHECK (${resourceTypeShape({ trackerType: toResourceType })});`,
    );
  }

  for (const [from, to] of orient(NOTIFICATION_TYPE_RENAMES)) {
    await run(`UPDATE "Notifications" SET "type" = '${to}' WHERE "type" = '${from}';`);
  }
  const payloadKeys = orient(NOTIFICATION_PAYLOAD_KEY_RENAMES);
  await run(
    `UPDATE "Notifications" SET payload = ${renameKeys({ source: 'payload', pairs: payloadKeys })}
      WHERE jsonb_typeof(payload) = 'object' AND ${hasAnyKey({ source: 'payload', pairs: payloadKeys })};`,
  );
  await run(
    `UPDATE "Notifications" SET payload = jsonb_set(payload, '{resourceType}', to_jsonb('${toResourceType}'::text))
      WHERE payload->>'resourceType' = '${fromResourceType}';`,
  );

  const typesPath = `settings #> '{notifications,types}'`;
  const preferenceKeys = orient(NOTIFICATION_PREFERENCE_KEY_RENAMES);
  await run(
    `UPDATE "UserSettings"
        SET settings = jsonb_set(settings, '{notifications,types}', ${renameKeys({ source: typesPath, pairs: preferenceKeys })})
      WHERE jsonb_typeof(${typesPath}) = 'object' AND ${hasAnyKey({ source: typesPath, pairs: preferenceKeys })};`,
  );

  const filterKeys = orient(SAVED_VIEW_FILTER_KEY_RENAMES);
  await run(
    `UPDATE "UserSettings"
        SET settings = jsonb_set(settings, '{savedTransactionViews}', (
          SELECT jsonb_agg(
                   CASE WHEN jsonb_typeof(v->'filters') = 'object'
                        THEN jsonb_set(v, '{filters}', ${renameKeys({ source: `v->'filters'`, pairs: filterKeys })})
                        ELSE v END
                   ORDER BY ord)
            FROM jsonb_array_elements(settings->'savedTransactionViews') WITH ORDINALITY AS e(v, ord)
        ))
      WHERE CASE WHEN jsonb_typeof(settings->'savedTransactionViews') = 'array'
                 THEN EXISTS (
                   SELECT 1 FROM jsonb_array_elements(settings->'savedTransactionViews') AS e(v)
                    WHERE jsonb_typeof(v->'filters') = 'object'
                      AND ${hasAnyKey({ source: `v->'filters'`, pairs: filterKeys })}
                 )
                 ELSE false END;`,
  );

  for (const { path, pair } of SETTINGS_ARRAY_VALUE_RENAMES) {
    const [from, to] = orientPair(pair);
    const value = `settings #> '${path}'`;
    await run(
      `UPDATE "UserSettings"
          SET settings = jsonb_set(settings, '${path}', (
            SELECT jsonb_agg(CASE WHEN el = to_jsonb('${from}'::text) THEN to_jsonb('${to}'::text) ELSE el END ORDER BY ord)
              FROM jsonb_array_elements(${value}) WITH ORDINALITY AS e(el, ord)
          ))
        WHERE CASE WHEN jsonb_typeof(${value}) = 'array' THEN (${value}) ? '${from}' ELSE false END;`,
    );
  }
};

module.exports = {
  up: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const [from, to] of TABLE_RENAMES) {
        await queryInterface.sequelize.query(`ALTER TABLE "${from}" RENAME TO "${to}";`, { transaction });
      }
      for (const table of TRACKER_FK_TABLES) {
        await queryInterface.sequelize.query(`ALTER TABLE "${table}" RENAME COLUMN "budgetId" TO "trackerId";`, {
          transaction,
        });
      }
      await renameDbObjects({
        queryInterface,
        transaction,
        pairs: NAME_TOKEN_RENAMES,
      });
      await renameStoredValues({ queryInterface, transaction, reverse: false });
    });
  },

  down: async (queryInterface: QueryInterface): Promise<void> => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await renameStoredValues({ queryInterface, transaction, reverse: true });
      await renameDbObjects({
        queryInterface,
        transaction,
        pairs: flip({ pairs: NAME_TOKEN_RENAMES }),
      });
      for (const table of TRACKER_FK_TABLES) {
        await queryInterface.sequelize.query(`ALTER TABLE "${table}" RENAME COLUMN "trackerId" TO "budgetId";`, {
          transaction,
        });
      }
      for (const [from, to] of TABLE_RENAMES) {
        await queryInterface.sequelize.query(`ALTER TABLE "${to}" RENAME TO "${from}";`, { transaction });
      }
    });
  },
};
