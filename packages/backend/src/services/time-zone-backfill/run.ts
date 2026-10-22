import { ACCOUNT_CATEGORIES, ACCOUNT_TYPES, TRANSACTION_TRANSFER_NATURE } from '@bt/shared/types';
import { Money } from '@common/types/money';
import Balances from '@models/balances.model';
import { connection } from '@models/connection';
import type Transactions from '@models/transactions.model';
import { getBaseCurrency } from '@models/users-currencies.model';
import { isRevaluedAccount, revalueBalanceHistory } from '@services/balances/revalue-balance-history.service';
import { QueryTypes } from 'sequelize';

import { type BackfillGroup, DEFAULT_GROUPS, DEFAULT_IMPORT_CREATED_FROM, DEFAULT_IMPORT_CREATED_TO } from './groups';
import { assertGroupsPartitionTimeline, changesDayIn, findGroup, planMove, type PlannedMove } from './plan';

const UPDATE_CHUNK_SIZE = 500;
const SAMPLES_PER_GROUP = 5;
const DEFAULT_DISPLAY_ZONE = 'Asia/Tbilisi';

interface SelectedRow {
  id: string;
  accountId: string;
  userId: number;
  time: Date;
  transferId: string | null;
  transferNature: string;
  transactionType: string;
  refAmount: string | null;
  accountType: ACCOUNT_TYPES;
  currencyCode: string;
  refCurrencyCode: string;
}

interface MovedRow extends SelectedRow {
  group: BackfillGroup;
  move: PlannedMove;
  utcDayChanges: boolean;
  localDayChanges: boolean;
}

interface GroupReport {
  key: string;
  zone: string;
  expectedRows: number;
  rows: number;
  localDateChanges: number;
  utcDateChanges: number;
  transfers: number;
  samples: { id: string; accountId: string; before: string; after: string; zone: string; utcOffsetMinutes: number }[];
}

interface BackfillReport {
  mode: 'dry-run' | 'apply';
  importCreatedFrom: string;
  importCreatedTo: string;
  displayZone: string;
  groups: GroupReport[];
  totalRows: number;
  /** Everything that stops an apply: count mismatches and rows the plan cannot place safely. */
  problems: string[];
  /** Accounts whose Balances history is rebuilt (foreign currency) or shifted day by day (base currency). */
  rebuiltAccounts: { revalued: string[]; incremental: string[] };
  /** Latest stored balance per account before and after an apply, for accounts whose figure must not move. */
  balanceCheck: { accountId: string; before: string | null; after: string | null; mustMatch: boolean }[];
}

interface BackfillOptions {
  apply: boolean;
  groups?: BackfillGroup[];
  importCreatedFrom?: Date;
  importCreatedTo?: Date;
  displayZone?: string;
}

const selectRows = async ({ createdFrom, createdTo }: { createdFrom: Date; createdTo: Date }) =>
  (await connection.sequelize.query(
    `SELECT t."id", t."accountId", t."userId", t."time", t."transferId", t."transferNature", t."transactionType",
            t."refAmount"::text AS "refAmount", t."accountType", t."currencyCode", t."refCurrencyCode"
       FROM real_transactions t
      WHERE t."timeZone" IS NULL
        AND t."utcOffsetMinutes" IS NULL
        AND t."createdAt" >= :createdFrom AND t."createdAt" < :createdTo
      ORDER BY t."time", t."id"`,
    { type: QueryTypes.SELECT, replacements: { createdFrom, createdTo } },
  )) as SelectedRow[];

const findTransferProblems = async ({ rows }: { rows: MovedRow[] }): Promise<string[]> => {
  const transferIds = [...new Set(rows.map((row) => row.transferId).filter((id): id is string => id !== null))];
  if (!transferIds.length) return [];

  const legs = (await connection.sequelize.query(
    `SELECT "id", "transferId" FROM real_transactions WHERE "transferId" IN (:transferIds)`,
    { type: QueryTypes.SELECT, replacements: { transferIds } },
  )) as { id: string; transferId: string }[];

  const groupOfRow = new Map(rows.map((row) => [row.id, row.group.key]));
  const problems: string[] = [];

  for (const transferId of transferIds) {
    const legGroups = legs.filter((leg) => leg.transferId === transferId).map((leg) => groupOfRow.get(leg.id));
    const first = legGroups[0];

    if (legGroups.length < 2 || legGroups.some((key) => key === undefined || key !== first)) {
      problems.push(`Transfer ${transferId} has legs outside the selection or in different groups`);
    }
  }

  return problems;
};

const pickSamples = <T>({ items }: { items: T[] }): T[] => {
  if (items.length <= SAMPLES_PER_GROUP) return items;

  return Array.from(
    { length: SAMPLES_PER_GROUP },
    (_, index) => items[Math.round((index * (items.length - 1)) / (SAMPLES_PER_GROUP - 1))]!,
  );
};

const buildGroupReports = ({ groups, moved }: { groups: BackfillGroup[]; moved: MovedRow[] }): GroupReport[] =>
  groups.map((group) => {
    const rows = moved.filter((row) => row.group.key === group.key);

    return {
      key: group.key,
      zone: group.zone,
      expectedRows: group.expectedRows,
      rows: rows.length,
      localDateChanges: rows.filter((row) => row.localDayChanges).length,
      utcDateChanges: rows.filter((row) => row.utcDayChanges).length,
      transfers: new Set(rows.map((row) => row.transferId).filter(Boolean)).size,
      samples: pickSamples({ items: rows }).map((row) => ({
        id: row.id,
        accountId: row.accountId,
        before: row.time.toISOString(),
        after: row.move.newTime.toISOString(),
        zone: row.move.zone,
        utcOffsetMinutes: row.move.utcOffsetMinutes,
      })),
    };
  });

const latestBalances = async ({ accountIds }: { accountIds: string[] }) => {
  if (!accountIds.length) return new Map<string, string>();

  const rows = (await connection.sequelize.query(
    `SELECT DISTINCT ON ("accountId") "accountId", "amount"::text AS "amount"
       FROM "Balances" WHERE "accountId" IN (:accountIds)
      ORDER BY "accountId", "date" DESC`,
    { type: QueryTypes.SELECT, replacements: { accountIds } },
  )) as { accountId: string; amount: string }[];

  return new Map(rows.map((row) => [row.accountId, row.amount]));
};

const writeMoves = async ({ rows }: { rows: MovedRow[] }) => {
  for (let start = 0; start < rows.length; start += UPDATE_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + UPDATE_CHUNK_SIZE);
    const replacements: Record<string, unknown> = {};
    const values = chunk.map((row, index) => {
      replacements[`id${index}`] = row.id;
      replacements[`time${index}`] = row.move.newTime;
      replacements[`zone${index}`] = row.move.zone;
      replacements[`offset${index}`] = row.move.utcOffsetMinutes;
      return `(:id${index}::uuid, :time${index}::timestamptz, :zone${index}::varchar, :offset${index}::smallint)`;
    });

    // Raw SQL on purpose: the model's update hooks would re-value the reference amounts at the new
    // day's rate, while this backfill leaves every amount exactly as it is.
    await connection.sequelize.query(
      `UPDATE "Transactions" AS t
          SET "time" = v."time", "timeZone" = v."zone", "utcOffsetMinutes" = v."offset", "updatedAt" = NOW()
         FROM (VALUES ${values.join(', ')}) AS v("id", "time", "zone", "offset")
        WHERE t."id" = v."id" AND t."timeZone" IS NULL AND t."utcOffsetMinutes" IS NULL`,
      { replacements },
    );
  }
};

const shiftBalanceDays = async ({ rows }: { rows: MovedRow[] }) => {
  for (const row of rows) {
    const shared = {
      accountId: row.accountId,
      accountType: row.accountType,
      transactionType: row.transactionType,
      transferNature: row.transferNature,
      refAmount: row.refAmount === null ? Money.zero() : Money.fromDecimal(row.refAmount),
      refCurrencyCode: row.refCurrencyCode,
      currencyCode: row.currencyCode,
      userId: row.userId,
    };

    // The same call the model's own update hook makes for an edit that moves a row to another day.
    await Balances.handleTransactionChange({
      data: { ...shared, time: row.move.newTime } as unknown as Transactions,
      prevData: { ...shared, time: row.time } as unknown as Transactions,
    });
  }
};

/**
 * Gives every imported, zone-less row the zone of the period it falls in and moves its stored instant
 * from the sheet's Istanbul anchoring to the real wall clock in that zone. Amounts stay as they are.
 * A dry run reads only; an apply runs in one transaction and rolls back on any problem.
 */
export async function runTimeZoneBackfill({
  apply,
  groups = DEFAULT_GROUPS,
  importCreatedFrom = DEFAULT_IMPORT_CREATED_FROM,
  importCreatedTo = DEFAULT_IMPORT_CREATED_TO,
  displayZone = DEFAULT_DISPLAY_ZONE,
}: BackfillOptions): Promise<BackfillReport> {
  assertGroupsPartitionTimeline({ groups });

  // Balances are cut into days in the server's zone; the backfill's day arithmetic assumes UTC.
  if (new Date(2026, 0, 1, 12).getTimezoneOffset() !== 0 || new Date(2026, 6, 1, 12).getTimezoneOffset() !== 0) {
    throw new Error('The backfill must run in a UTC process (unset TZ)');
  }

  const work = async (): Promise<BackfillReport> => {
    const selected = await selectRows({ createdFrom: importCreatedFrom, createdTo: importCreatedTo });
    const problems: string[] = [];

    const moved: MovedRow[] = [];
    for (const row of selected) {
      const time = new Date(row.time);
      const group = findGroup({ instant: time, groups });
      if (!group) {
        problems.push(`Row ${row.id} at ${time.toISOString()} falls in no group`);
        continue;
      }

      const move = planMove({ time, group });
      moved.push({
        ...row,
        time,
        group,
        move,
        utcDayChanges: changesDayIn({ before: time, after: move.newTime, zone: 'UTC' }),
        localDayChanges: changesDayIn({ before: time, after: move.newTime, zone: displayZone }),
      });
    }

    const groupReports = buildGroupReports({ groups, moved });
    for (const report of groupReports) {
      if (report.rows !== report.expectedRows) {
        problems.push(`Group ${report.key}: found ${report.rows} rows, expected ${report.expectedRows}`);
      }
    }

    problems.push(...(await findTransferProblems({ rows: moved })));

    const accountIds = [...new Set(moved.map((row) => row.accountId))];
    const accounts = accountIds.length
      ? ((await connection.sequelize.query(
          `SELECT "id", "type", "accountCategory", "currencyCode", "userId" FROM "Accounts" WHERE "id" IN (:accountIds)`,
          { type: QueryTypes.SELECT, replacements: { accountIds } },
        )) as {
          id: string;
          type: ACCOUNT_TYPES;
          accountCategory: ACCOUNT_CATEGORIES;
          currencyCode: string;
          userId: number;
        }[])
      : [];
    const accountById = new Map(accounts.map((account) => [account.id, account]));

    const revalued: string[] = [];
    const incremental: string[] = [];

    for (const accountId of accountIds) {
      const account = accountById.get(accountId);
      if (!account || account.type !== ACCOUNT_TYPES.system) {
        problems.push(`Account ${accountId} is not a system account; its balances are written by its provider`);
        continue;
      }

      const baseCurrencyCode = (await getBaseCurrency({ userId: account.userId }))?.currencyCode;
      if (!baseCurrencyCode) {
        problems.push(`Account ${accountId}: owner has no base currency`);
        continue;
      }

      (isRevaluedAccount({ account, baseCurrencyCode }) ? revalued : incremental).push(accountId);
    }

    const loanRows = moved.filter(
      (row) =>
        row.transferNature === TRANSACTION_TRANSFER_NATURE.transfer_to_loan ||
        row.transferNature === TRANSACTION_TRANSFER_NATURE.transfer_out_wallet,
    );
    if (loanRows.length)
      problems.push(`${loanRows.length} rows are loan or wallet transfer legs, which this run does not handle`);

    const before = await latestBalances({ accountIds });
    const report: BackfillReport = {
      mode: apply ? 'apply' : 'dry-run',
      importCreatedFrom: importCreatedFrom.toISOString(),
      importCreatedTo: importCreatedTo.toISOString(),
      displayZone,
      groups: groupReports,
      totalRows: moved.length,
      problems,
      rebuiltAccounts: { revalued, incremental },
      balanceCheck: accountIds.map((accountId) => ({
        accountId,
        before: before.get(accountId) ?? null,
        after: null,
        mustMatch: incremental.includes(accountId),
      })),
    };

    if (!apply) return report;
    if (problems.length) throw new Error(`Refusing to apply:\n${problems.join('\n')}`);

    await writeMoves({ rows: moved });
    await shiftBalanceDays({ rows: moved.filter((row) => row.utcDayChanges && incremental.includes(row.accountId)) });
    for (const accountId of revalued) await revalueBalanceHistory({ accountId });

    const after = await latestBalances({ accountIds });
    for (const check of report.balanceCheck) {
      check.after = after.get(check.accountId) ?? null;

      if (check.mustMatch && !Money.fromDecimal(check.before ?? '0').equals(Money.fromDecimal(check.after ?? '0'))) {
        throw new Error(`Account ${check.accountId}: latest balance moved from ${check.before} to ${check.after}`);
      }
    }

    return report;
  };

  // A dry run opens no transaction; an apply is all or nothing.
  return apply ? connection.sequelize.transaction(work) : work();
}

export const formatReport = ({ report }: { report: BackfillReport }): string => {
  const lines = [
    `Time zone backfill, ${report.mode}`,
    `Imported rows: created ${report.importCreatedFrom} to ${report.importCreatedTo}; local dates in ${report.displayZone}`,
    '',
  ];

  for (const group of report.groups) {
    lines.push(
      `${group.key} (${group.zone}): ${group.rows} rows (expected ${group.expectedRows}), ` +
        `local date changes ${group.localDateChanges}, UTC date changes ${group.utcDateChanges}, transfers ${group.transfers}`,
    );
    for (const sample of group.samples) {
      lines.push(
        `    ${sample.id} account ${sample.accountId}: ${sample.before} -> ${sample.after} (${sample.zone}, ${sample.utcOffsetMinutes} min)`,
      );
    }
  }

  lines.push(
    '',
    `Total rows: ${report.totalRows}`,
    `Accounts shifted day by day: ${report.rebuiltAccounts.incremental.length}; history rebuilt from rates: ${report.rebuiltAccounts.revalued.length}`,
  );

  const moves = report.balanceCheck.filter((check) => check.after !== null && check.after !== check.before);
  if (report.mode === 'apply') lines.push(`Latest balance rows that changed: ${moves.length}`);

  lines.push(
    report.problems.length
      ? `PROBLEMS (apply refuses):\n${report.problems.map((p) => `  ${p}`).join('\n')}`
      : 'No problems found.',
  );

  return lines.join('\n');
};
