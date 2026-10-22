import { type RecordId, TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import Balances from '@models/balances.model';
import Transactions from '@models/transactions.model';
import * as helpers from '@tests/helpers';

import { type BackfillGroup } from './groups';
import { formatReport, runTimeZoneBackfill } from './run';

/**
 * The backfill is a one-off script with no HTTP surface, so this e2e runs it directly on rows
 * created through the API, as `crons/balance-revalue-sweep.e2e.ts` does for the sweep.
 */

const CUT = new Date('2026-06-01T00:00:00.000Z');
const GHOST_FROM = new Date('2030-01-01T00:00:00.000Z');

const groups = (expected: { early: number; late: number }): BackfillGroup[] => [
  { key: 'early', zone: 'Asia/Bangkok', windows: [{ from: null, to: CUT }], expectedRows: expected.early },
  { key: 'late', zone: 'Asia/Tbilisi', windows: [{ from: CUT, to: null }], expectedRows: expected.late },
];

const importWindow = () => ({
  importCreatedFrom: new Date(Date.now() - 3_600_000),
  importCreatedTo: new Date(Date.now() + 3_600_000),
});

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

const signed = (tx: Transactions) => (tx.transactionType === TRANSACTION_TYPES.income ? 1 : -1) * Number(tx.refAmount);

const create = async (overrides: Parameters<typeof helpers.buildTransactionPayload>[0]) => {
  const [tx, opposite] = await helpers.createTransaction({
    payload: helpers.buildTransactionPayload({ amount: 100, ...overrides }),
    raw: true,
  });
  return { tx: tx!, opposite };
};

const seed = async () => {
  const base = await helpers.createAccount({ raw: true });
  const { account: foreign } = await helpers.createAccountWithNewCurrency({ currency: 'UAH' });
  const other = await helpers.createAccount({ raw: true });

  // Early group: 01:00 sheet wall clock becomes 21:00Z the evening before, so the UTC day changes.
  const early = await create({ accountId: base.id, time: '2026-03-11T01:00:00.000Z' });
  const income = await create({
    accountId: base.id,
    time: '2026-03-12T10:00:00.000Z',
    transactionType: TRANSACTION_TYPES.income,
    amount: 50,
  });
  const transfer = await create({
    accountId: base.id,
    destinationAccountId: other.id,
    destinationAmount: 100,
    transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer,
    time: '2026-03-11T02:00:00.000Z',
  });
  const foreignExpense = await create({ accountId: foreign.id, time: '2026-03-13T03:00:00.000Z', amount: 30 });
  // Late group: 00:30Z is 03:30 on the sheet, 23:30Z the evening before in Tbilisi.
  const late = await create({ accountId: base.id, time: '2026-09-20T00:30:00.000Z' });
  // Already zoned: never touched.
  const zoned = await create({
    accountId: base.id,
    time: '2026-03-12T11:00:00.000Z',
    timeZone: 'Asia/Tbilisi',
  });

  return { base, foreign, other, early, income, transfer, foreignExpense, late, zoned };
};

const reload = async (...ids: RecordId[]) =>
  new Map((await Transactions.findAll({ where: { id: ids } })).map((tx) => [tx.id, tx]));

describe('time zone backfill', () => {
  it('reports a dry run and writes nothing', async () => {
    const data = await seed();
    const ids = [data.early.tx.id, data.income.tx.id, data.late.tx.id];
    const before = await reload(...ids);

    const report = await runTimeZoneBackfill({
      apply: false,
      groups: groups({ early: 5, late: 1 }),
      ...importWindow(),
    });

    expect(report.mode).toBe('dry-run');
    expect(report.problems).toEqual([]);
    expect(report.groups.map((group) => [group.key, group.rows])).toEqual([
      ['early', 5],
      ['late', 1],
    ]);
    expect(report.groups[0]!.transfers).toBe(1);
    expect(report.groups[0]!.utcDateChanges).toBeGreaterThanOrEqual(1);

    const after = await reload(...ids);
    for (const id of ids) {
      expect(after.get(id)!.time).toEqual(before.get(id)!.time);
      expect(after.get(id)!.timeZone).toBeNull();
    }
  });

  it('moves a wallet-transfer row like any other row', async () => {
    const base = await helpers.createAccount({ raw: true });
    await create({
      accountId: base.id,
      time: '2026-03-11T01:00:00.000Z',
      transferNature: TRANSACTION_TRANSFER_NATURE.transfer_out_wallet,
    });

    const report = await runTimeZoneBackfill({
      apply: true,
      groups: groups({ early: 1, late: 0 }),
      ...importWindow(),
    });

    expect(report.problems).toEqual([]);
    expect(report.groups[0]!.rows).toBe(1);
  });

  it('refuses to apply when a group count differs from the expectation', async () => {
    await seed();

    await expect(
      runTimeZoneBackfill({ apply: true, groups: groups({ early: 4, late: 1 }), ...importWindow() }),
    ).rejects.toThrow('found 5 rows, expected 4');
  });

  it('moves the instants into the zones, keeps amounts and transfer legs, and keeps the balances', async () => {
    const data = await seed();
    const ids = [
      data.early.tx.id,
      data.income.tx.id,
      data.transfer.tx.id,
      data.transfer.opposite!.id,
      data.foreignExpense.tx.id,
      data.late.tx.id,
      data.zoned.tx.id,
    ];
    const before = await reload(...ids);
    const baseBalanceBefore = await Balances.findAll({ where: { accountId: data.base.id }, order: [['date', 'ASC']] });

    const report = await runTimeZoneBackfill({ apply: true, groups: groups({ early: 5, late: 1 }), ...importWindow() });

    expect(report.mode).toBe('apply');
    expect(report.rebuiltAccounts.revalued).toEqual([data.foreign.id]);
    expect(report.rebuiltAccounts.incremental).toEqual(expect.arrayContaining([data.base.id, data.other.id]));

    const after = await reload(...ids);
    const time = (id: RecordId) => after.get(id)!.time.toISOString();

    // The sheet wall clock (instant + 3h) read in the zone.
    expect(time(data.early.tx.id)).toBe('2026-03-10T21:00:00.000Z');
    expect(time(data.income.tx.id)).toBe('2026-03-12T06:00:00.000Z');
    expect(time(data.late.tx.id)).toBe('2026-09-19T23:30:00.000Z');
    expect(after.get(data.early.tx.id)!.timeZone).toBe('Asia/Bangkok');
    expect(after.get(data.early.tx.id)!.utcOffsetMinutes).toBe(420);
    expect(after.get(data.late.tx.id)!.timeZone).toBe('Asia/Tbilisi');
    expect(after.get(data.late.tx.id)!.utcOffsetMinutes).toBe(240);

    // Both transfer legs carry the same instant and zone.
    const base = after.get(data.transfer.tx.id)!;
    const opposite = after.get(data.transfer.opposite!.id)!;
    expect(opposite.time).toEqual(base.time);
    expect(opposite.timeZone).toBe('Asia/Bangkok');
    expect(opposite.utcOffsetMinutes).toBe(base.utcOffsetMinutes);

    // Amounts untouched.
    for (const id of ids) {
      expect(String(after.get(id)!.amount)).toBe(String(before.get(id)!.amount));
      expect(String(after.get(id)!.refAmount)).toBe(String(before.get(id)!.refAmount));
    }

    // The row that already had a zone is left alone.
    expect(after.get(data.zoned.tx.id)!.time).toEqual(before.get(data.zoned.tx.id)!.time);
    expect(after.get(data.zoned.tx.id)!.timeZone).toBe('Asia/Tbilisi');

    // The base account's history is the running total with each row on its new UTC day.
    const baseTransactions = await Transactions.findAll({ where: { accountId: data.base.id } });
    const baseBalanceAfter = await Balances.findAll({ where: { accountId: data.base.id }, order: [['date', 'ASC']] });
    const initial = Number(data.base.refInitialBalance ?? 0);

    for (const row of baseBalanceAfter) {
      const day = String(row.date);
      const expected =
        initial + baseTransactions.filter((tx) => dayOf(tx.time) <= day).reduce((sum, tx) => sum + signed(tx), 0);
      expect(Number(row.amount)).toBeCloseTo(expected, 6);
    }
    expect(Number(baseBalanceAfter.at(-1)!.amount)).toBeCloseTo(Number(baseBalanceBefore.at(-1)!.amount), 6);
    expect(baseBalanceAfter.some((row) => String(row.date) === '2026-03-10')).toBe(true);

    // The foreign-currency history was rebuilt on the new days.
    const foreignRows = await Balances.findAll({ where: { accountId: data.foreign.id }, order: [['date', 'ASC']] });
    expect(foreignRows.length).toBeGreaterThan(0);
  });

  it('is a no-op the second time, because nothing zone-less is left in the import', async () => {
    await seed();
    await runTimeZoneBackfill({ apply: true, groups: groups({ early: 5, late: 1 }), ...importWindow() });

    const report = await runTimeZoneBackfill({
      apply: true,
      groups: groups({ early: 5, late: 1 }),
      ...importWindow(),
    });

    expect(report.totalRows).toBe(0);
    expect(report.nothingToDo).toBe(true);
    expect(report.problems).toEqual([]);
    expect(formatReport({ report })).toContain('Nothing to do');
  });

  it('still reports a mismatch when one group selects nothing and another does not', async () => {
    await seed();

    const report = await runTimeZoneBackfill({
      apply: false,
      groups: [
        { key: 'early', zone: 'Asia/Bangkok', windows: [{ from: null, to: CUT }], expectedRows: 5 },
        { key: 'late', zone: 'Asia/Tbilisi', windows: [{ from: CUT, to: GHOST_FROM }], expectedRows: 1 },
        { key: 'ghost', zone: 'Asia/Tbilisi', windows: [{ from: GHOST_FROM, to: null }], expectedRows: 1 },
      ],
      ...importWindow(),
    });

    expect(report.nothingToDo).toBe(false);
    expect(report.problems).toEqual(['Group ghost: found 0 rows, expected 1']);
  });

  it('treats an empty selection as a miss, not as done, when nothing was moved before', async () => {
    await seed();

    const report = await runTimeZoneBackfill({
      apply: false,
      groups: groups({ early: 5, late: 1 }),
      importCreatedFrom: new Date('2020-01-01'),
      importCreatedTo: new Date('2020-01-02'),
    });

    expect(report.nothingToDo).toBe(false);
    expect(report.problems.length).toBe(2);
    expect(formatReport({ report })).not.toContain('Nothing to do');
  });
});
