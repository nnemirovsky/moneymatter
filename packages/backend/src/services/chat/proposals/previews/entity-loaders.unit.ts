import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import Accounts from '@models/accounts.model';
import BudgetLineGoals from '@models/budget-line-goals.model';
import BudgetLines from '@models/budget-lines.model';
import BudgetPlans from '@models/budget-plans.model';
import Categories from '@models/categories.model';
import Currencies from '@models/currencies.model';
import Holdings from '@models/investments/holdings.model';
import InvestmentTransactions from '@models/investments/investment-transaction.model';
import Portfolios from '@models/investments/portfolios.model';
import PayeeAliases from '@models/payee-aliases.model';
import Payees from '@models/payees.model';
import TagReminders from '@models/tag-reminders.model';
import Tags from '@models/tags.model';
import TransactionTags from '@models/transaction-tags.model';
import UsersCurrencies from '@models/users-currencies.model';
import VentureEventLinks from '@models/venture/venture-event-links.model';
import VentureEvents from '@models/venture/venture-events.model';

import { ENTITY_LOADER_KINDS } from '../../policies/explicit';

jest.mock('@models/transactions-query', () => ({
  ...(jest.requireActual('@models/transactions-query') as object),
  findOneTransaction: jest.fn(),
  countTransactions: jest.fn(),
}));

import * as transactionsQuery from '@models/transactions-query';

import { ENTITY_LOADERS } from './entity-loaders';

const USER = 7;
const ID = '3f1b9c2e-8d4a-4b6e-9c1d-2a7e5f0b8c11';
const OTHER = '9a7c5e31-2b84-4d0f-8e66-1c3a5b7d9f20';
const UPDATED = new Date('2026-10-18T09:00:00.000Z');

const record = (values: Record<string, unknown>) => ({
  updatedAt: UPDATED,
  ...values,
  toJSON: () => ({ updatedAt: UPDATED, ...values }),
});

const load = ({ kind, targets }: { kind: string; targets: string[] }) =>
  (ENTITY_LOADERS as Record<string, NonNullable<(typeof ENTITY_LOADERS)[keyof typeof ENTITY_LOADERS]>>)[kind]!({
    userId: USER,
    targets,
  });

const whereOf = (spy: unknown) =>
  (jest.mocked(spy as never) as jest.Mock<(...args: unknown[]) => unknown>).mock.calls[0]![0] as {
    where: Record<string, unknown>;
  };

describe('entity loaders', () => {
  beforeEach(() => {
    jest.mocked(transactionsQuery.countTransactions).mockResolvedValue(0);
    jest.mocked(transactionsQuery.findOneTransaction).mockResolvedValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('has a loader for every entity the policies send to the entity resolver, and for no other', () => {
    expect(Object.keys(ENTITY_LOADERS).toSorted()).toEqual([...ENTITY_LOADER_KINDS].toSorted());
  });

  it('loads a transaction through the transactions boundary, scoped to the user', async () => {
    jest.mocked(transactionsQuery.findOneTransaction).mockResolvedValue(record({ id: ID, note: 'Coffee' }) as never);

    const loaded = await load({ kind: 'transaction', targets: [ID] });

    expect(loaded).toMatchObject({ row: { id: ID, note: 'Coffee' }, updatedAt: UPDATED, removes: 0 });
    expect(jest.mocked(transactionsQuery.findOneTransaction).mock.calls[0]![0]).toMatchObject({
      access: { creator: USER },
      where: { id: ID },
    });
  });

  it('counts the transactions of an account and reports them as the rows a delete removes', async () => {
    const find = jest.spyOn(Accounts, 'findOne').mockResolvedValue(record({ id: ID, name: 'Cash' }) as never);
    jest.mocked(transactionsQuery.countTransactions).mockResolvedValue(12);

    const loaded = await load({ kind: 'account', targets: [ID] });

    expect(whereOf(find).where).toEqual({ id: ID, userId: USER });
    expect(loaded).toMatchObject({ row: { name: 'Cash' }, counts: { transactionCount: 12 }, removes: 12 });
    expect(jest.mocked(transactionsQuery.countTransactions).mock.calls[0]![0]).toMatchObject({
      where: { accountId: ID },
    });
  });

  it('answers null for an entity that is not there', async () => {
    jest.spyOn(Accounts, 'findOne').mockResolvedValue(null);

    expect(await load({ kind: 'account', targets: [ID] })).toBeNull();
  });

  it('counts the transactions and subcategories of a category', async () => {
    const find = jest.spyOn(Categories, 'findOne').mockResolvedValue(record({ id: ID }) as never);
    const count = jest.spyOn(Categories, 'count').mockResolvedValue(3);
    jest.mocked(transactionsQuery.countTransactions).mockResolvedValue(40);

    const loaded = await load({ kind: 'category', targets: [ID] });

    expect(whereOf(find).where).toEqual({ id: ID, userId: USER });
    expect(whereOf(count).where).toEqual({ parentId: ID, userId: USER });
    expect(loaded).toMatchObject({ counts: { transactionCount: 40, subcategoryCount: 3 }, removes: 0 });
  });

  it('counts the transactions a tag is on', async () => {
    jest.spyOn(Tags, 'findOne').mockResolvedValue(record({ id: ID }) as never);
    const count = jest.spyOn(TransactionTags, 'count').mockResolvedValue(9);

    const loaded = await load({ kind: 'tag', targets: [ID] });

    expect(whereOf(count).where).toEqual({ tagId: ID });
    expect(loaded?.counts).toEqual({ transactionCount: 9 });
  });

  it('counts the transactions and aliases of a payee', async () => {
    jest.spyOn(Payees, 'findOne').mockResolvedValue(record({ id: ID }) as never);
    const aliases = jest.spyOn(PayeeAliases, 'count').mockResolvedValue(2);
    jest.mocked(transactionsQuery.countTransactions).mockResolvedValue(5);

    const loaded = await load({ kind: 'payee', targets: [ID] });

    expect(whereOf(aliases).where).toEqual({ payeeId: ID });
    expect(loaded?.counts).toEqual({ transactionCount: 5, aliasCount: 2 });
  });

  it('finds a payee alias only through a payee of the user', async () => {
    const payee = jest.spyOn(Payees, 'findOne').mockResolvedValue(null);
    const alias = jest.spyOn(PayeeAliases, 'findOne').mockResolvedValue(record({ id: OTHER }) as never);

    expect(await load({ kind: 'payeeAlias', targets: [ID, OTHER] })).toBeNull();
    expect(whereOf(payee).where).toMatchObject({ id: ID, userId: USER });
    expect(alias).not.toHaveBeenCalled();

    payee.mockResolvedValue(record({ id: ID }) as never);
    const loaded = await load({ kind: 'payeeAlias', targets: [ID, OTHER] });

    expect(loaded?.row).toMatchObject({ id: OTHER });
    expect(jest.mocked(alias).mock.calls[0]![0]).toMatchObject({ where: { id: OTHER, payeeId: ID } });
  });

  it('finds a tag reminder by its tag and the user', async () => {
    const find = jest.spyOn(TagReminders, 'findOne').mockResolvedValue(record({ id: OTHER }) as never);

    await load({ kind: 'tagReminder', targets: [ID, OTHER] });

    expect(whereOf(find).where).toEqual({ id: OTHER, tagId: ID, userId: USER });
  });

  it('finds a budget plan line only inside a plan of the user', async () => {
    const plan = jest.spyOn(BudgetPlans, 'findOne').mockResolvedValue(null);
    const line = jest.spyOn(BudgetLines, 'findOne').mockResolvedValue(record({ id: OTHER, name: 'Food' }) as never);

    expect(await load({ kind: 'budgetPlanLine', targets: [ID, OTHER] })).toBeNull();
    expect(whereOf(plan).where).toEqual({ id: ID, userId: USER });
    expect(line).not.toHaveBeenCalled();

    plan.mockResolvedValue(record({ id: ID }) as never);
    const loaded = await load({ kind: 'budgetPlanLine', targets: [ID, OTHER] });

    expect(loaded?.row).toMatchObject({ name: 'Food' });
    expect(jest.mocked(line).mock.calls[0]![0]).toMatchObject({ where: { id: OTHER, planId: ID } });
  });

  it('loads a budget plan line goal that does not exist yet as an empty row, and refuses a line that is not there', async () => {
    jest.spyOn(BudgetPlans, 'findOne').mockResolvedValue(record({ id: ID }) as never);
    const line = jest.spyOn(BudgetLines, 'findOne').mockResolvedValue(record({ id: OTHER }) as never);
    const goal = jest.spyOn(BudgetLineGoals, 'findOne').mockResolvedValue(null);

    const loaded = await load({ kind: 'budgetPlanLineGoal', targets: [ID, OTHER] });

    expect(loaded).toMatchObject({ row: null, updatedAt: null });
    expect(whereOf(goal).where).toEqual({ lineId: OTHER });

    line.mockResolvedValue(null);
    expect(await load({ kind: 'budgetPlanLineGoal', targets: [ID, OTHER] })).toBeNull();
  });

  it('finds a custom currency by the user who defined it', async () => {
    const find = jest.spyOn(Currencies, 'findOne').mockResolvedValue(record({ code: 'PTS' }) as never);

    await load({ kind: 'customCurrency', targets: ['PTS'] });

    expect(whereOf(find).where).toEqual({ code: 'PTS', isCustom: true, userId: USER });
  });

  it('finds a user currency by code, and counts the accounts in it', async () => {
    const find = jest.spyOn(UsersCurrencies, 'findOne').mockResolvedValue(record({ currencyCode: 'EUR' }) as never);
    const accounts = jest.spyOn(Accounts, 'count').mockResolvedValue(2);

    const loaded = await load({ kind: 'userCurrency', targets: ['EUR'] });

    expect(whereOf(find).where).toEqual({ currencyCode: 'EUR', userId: USER });
    expect(whereOf(accounts).where).toEqual({ currencyCode: 'EUR', userId: USER });
    expect(loaded?.counts).toEqual({ accountCount: 2 });
  });

  it('finds a holding inside a portfolio of the user', async () => {
    jest.spyOn(Portfolios, 'findOne').mockResolvedValue(record({ id: ID }) as never);
    const holding = jest.spyOn(Holdings, 'findOne').mockResolvedValue(record({ quantity: 3 }) as never);

    const loaded = await load({ kind: 'holding', targets: [ID, OTHER] });

    expect(loaded?.row).toMatchObject({ quantity: 3 });
    expect(whereOf(holding).where).toEqual({ portfolioId: ID, securityId: OTHER });
  });

  it('finds an investment transaction only when its portfolio belongs to the user', async () => {
    jest.spyOn(InvestmentTransactions, 'findOne').mockResolvedValue(record({ id: ID, portfolioId: OTHER }) as never);
    const portfolio = jest.spyOn(Portfolios, 'findOne').mockResolvedValue(null);

    expect(await load({ kind: 'investmentTransaction', targets: [ID] })).toBeNull();
    expect(whereOf(portfolio).where).toEqual({ id: OTHER, userId: USER });

    portfolio.mockResolvedValue(record({ id: OTHER }) as never);
    expect((await load({ kind: 'investmentTransaction', targets: [ID] }))?.row).toMatchObject({ id: ID });
  });

  it('finds a venture event link inside an event of the user', async () => {
    const event = jest.spyOn(VentureEvents, 'findOne').mockResolvedValue(record({ id: ID }) as never);
    const link = jest.spyOn(VentureEventLinks, 'findOne').mockResolvedValue(record({ id: OTHER }) as never);

    const loaded = await load({ kind: 'ventureEventLink', targets: [ID, OTHER] });

    expect(loaded?.row).toMatchObject({ id: OTHER });
    expect(whereOf(event).where).toEqual({ id: ID, userId: USER });
    expect(whereOf(link).where).toEqual({ id: OTHER, ventureEventId: ID });
  });

  it('leaves out the internal columns of a row', async () => {
    jest
      .spyOn(Accounts, 'findOne')
      .mockResolvedValue(record({ id: ID, externalData: { secret: 1 }, metaData: { a: 1 }, name: 'Cash' }) as never);

    const loaded = await load({ kind: 'account', targets: [ID] });

    expect(Object.keys(loaded!.row!)).not.toContain('externalData');
    expect(Object.keys(loaded!.row!)).not.toContain('metaData');
    expect(loaded!.row!.name).toBe('Cash');
  });
});
