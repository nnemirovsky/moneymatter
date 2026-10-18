import type { ChatEntityKind } from '@bt/shared/types';
import AccountGrouping from '@models/accounts-groups/account-grouping.model';
import AccountGroups from '@models/accounts-groups/account-groups.model';
import Accounts from '@models/accounts.model';
import BudgetLineGoals from '@models/budget-line-goals.model';
import BudgetLineGroups from '@models/budget-line-groups.model';
import BudgetLines from '@models/budget-lines.model';
import BudgetPlans from '@models/budget-plans.model';
import BudgetTransactions from '@models/budget-transactions.model';
import Budgets from '@models/budget.model';
import Categories from '@models/categories.model';
import Currencies from '@models/currencies.model';
import Holdings from '@models/investments/holdings.model';
import InvestmentTransactions from '@models/investments/investment-transaction.model';
import PortfolioTransfers from '@models/investments/portfolio-transfers.model';
import Portfolios from '@models/investments/portfolios.model';
import LoanDetails from '@models/loan-details.model';
import PayeeAliases from '@models/payee-aliases.model';
import Payees from '@models/payees.model';
import Subscriptions from '@models/subscriptions.model';
import TagReminders from '@models/tag-reminders.model';
import Tags from '@models/tags.model';
import TransactionAttachments from '@models/transaction-attachments.model';
import TransactionAutomations from '@models/transaction-automations.model';
import TransactionGroupItems from '@models/transaction-group-items.model';
import TransactionGroups from '@models/transaction-groups.model';
import TransactionSplits from '@models/transaction-splits.model';
import TransactionTags from '@models/transaction-tags.model';
import TransactionTemplates from '@models/transaction-templates.model';
import { countTransactions, findOneTransaction } from '@models/transactions-query';
import UsersCurrencies from '@models/users-currencies.model';
import Vehicles from '@models/vehicles.model';
import VentureDeals from '@models/venture/venture-deals.model';
import VentureEventLinks from '@models/venture/venture-event-links.model';
import VentureEvents from '@models/venture/venture-events.model';
import VenturePlatforms from '@models/venture/venture-platforms.model';
import type { Model, ModelStatic, WhereOptions } from 'sequelize';

import { serializeRow } from './preview-helpers';

/** An entity a card targets, read for its preview. */
export interface LoadedEntity {
  /** The row as JSON; `null` when the entity does not exist yet (a goal a `set_` call creates). */
  row: Record<string, unknown> | null;
  updatedAt: Date | null;
  /** Related counts, such as the transactions an account holds. */
  counts: Record<string, number>;
  /** Rows that go when the entity is deleted, on top of itself (an account's transactions). */
  removes: number;
}

/**
 * Reads the entity the targets name, scoped to the user. The targets come in the order the policy's
 * `targetFields` list them: a parent id first where the entity lives under one. `null` is a target
 * that is not there (or not the user's).
 */
type EntityLoader = (params: { userId: number; targets: string[] }) => Promise<LoadedEntity | null>;

type AnyModel = ModelStatic<Model>;
type Where = WhereOptions;

interface Related {
  counts?: Record<string, number>;
  removes?: number;
}

const updatedAtOf = ({ record }: { record: Model }): Date | null =>
  (record as unknown as { updatedAt?: Date | null }).updatedAt ?? null;

const loaded = ({ record, related }: { record: Model; related?: Related }): LoadedEntity => ({
  row: serializeRow({ row: record }),
  updatedAt: updatedAtOf({ record }),
  counts: related?.counts ?? {},
  removes: related?.removes ?? 0,
});

/** Transactions the user wrote that match, counted at the transactions boundary. */
const transactionsWhere = ({ userId, where }: { userId: number; where: Record<string, unknown> }) =>
  countTransactions({
    planned: 'include',
    access: { creator: userId },
    balanceAdjustments: 'include',
    where: where as never,
  });

/** An entity with a `userId` column, found by one id; `related` reads its counts. */
const owned =
  ({
    model,
    key = 'id',
    related,
  }: {
    model: AnyModel;
    key?: string;
    related?: (params: { userId: number; id: string }) => Promise<Related>;
  }): EntityLoader =>
  async ({ userId, targets }) => {
    const id = targets[0]!;
    const record = await model.findOne({ where: { [key]: id, userId } as Where });
    if (!record) return null;

    return loaded({ record, related: await related?.({ userId, id }) });
  };

/** An entity that belongs to the user through a parent: the parent is checked first. */
const under =
  ({
    parent,
    model,
    where,
    optional = false,
  }: {
    parent: (params: { userId: number; targets: string[] }) => Promise<Model | null>;
    model: AnyModel;
    where: (targets: string[]) => Where;
    optional?: boolean;
  }): EntityLoader =>
  async ({ userId, targets }) => {
    if (!(await parent({ userId, targets }))) return null;

    const record = await model.findOne({ where: where(targets) });
    if (!record) return optional ? { row: null, updatedAt: null, counts: {}, removes: 0 } : null;

    return loaded({ record });
  };

const planOf = ({ userId, targets }: { userId: number; targets: string[] }) =>
  BudgetPlans.findOne({ where: { id: targets[0]!, userId } });

const portfolioOf = ({ userId, targets }: { userId: number; targets: string[] }) =>
  Portfolios.findOne({ where: { id: targets[0]!, userId } });

const lineOf = ({ targets }: { targets: string[] }) =>
  BudgetLines.findOne({ where: { id: targets[1]!, planId: targets[0]! } });

export const ENTITY_LOADERS: Partial<Record<ChatEntityKind, EntityLoader>> = {
  transaction: async ({ userId, targets }) => {
    const record = await findOneTransaction({
      planned: 'include',
      access: { creator: userId },
      balanceAdjustments: 'include',
      where: { id: targets[0]! },
    });
    return record ? loaded({ record }) : null;
  },

  account: owned({
    model: Accounts,
    related: async ({ userId, id }) => {
      const transactionCount = await transactionsWhere({ userId, where: { accountId: id } });
      return { counts: { transactionCount }, removes: transactionCount };
    },
  }),

  accountGroup: owned({
    model: AccountGroups,
    related: async ({ userId, id }) => ({
      counts: {
        accountCount: await AccountGrouping.count({ where: { groupId: id } }),
        subgroupCount: await AccountGroups.count({ where: { parentGroupId: id, userId } }),
      },
    }),
  }),

  category: owned({
    model: Categories,
    related: async ({ userId, id }) => ({
      counts: {
        transactionCount: await transactionsWhere({ userId, where: { categoryId: id } }),
        subcategoryCount: await Categories.count({ where: { parentId: id, userId } }),
      },
    }),
  }),

  tag: owned({
    model: Tags,
    related: async ({ id }) => ({
      counts: { transactionCount: await TransactionTags.count({ where: { tagId: id } }) },
    }),
  }),

  tagReminder: async ({ userId, targets }) => {
    const record = await TagReminders.findOne({ where: { id: targets[1]!, tagId: targets[0]!, userId } });
    return record ? loaded({ record }) : null;
  },

  payee: owned({
    model: Payees,
    related: async ({ userId, id }) => ({
      counts: {
        transactionCount: await transactionsWhere({ userId, where: { payeeId: id } }),
        aliasCount: await PayeeAliases.count({ where: { payeeId: id } }),
      },
    }),
  }),

  payeeAlias: under({
    parent: ({ userId, targets }) => Payees.findOne({ where: { id: targets[0]!, userId } }),
    model: PayeeAliases,
    where: (targets) => ({ id: targets[1]!, payeeId: targets[0]! }),
  }),

  budget: owned({
    model: Budgets,
    related: async ({ id }) => ({
      counts: { transactionCount: await BudgetTransactions.count({ where: { budgetId: id } }) },
    }),
  }),

  budgetPlan: owned({
    model: BudgetPlans,
    related: async ({ id }) => ({ counts: { lineCount: await BudgetLines.count({ where: { planId: id } }) } }),
  }),

  budgetPlanGroup: under({
    parent: planOf,
    model: BudgetLineGroups,
    where: (targets) => ({ id: targets[1]!, planId: targets[0]! }),
  }),

  budgetPlanLine: under({
    parent: planOf,
    model: BudgetLines,
    where: (targets) => ({ id: targets[1]!, planId: targets[0]! }),
  }),

  budgetPlanLineGoal: under({
    parent: async ({ userId, targets }) => ((await planOf({ userId, targets })) ? lineOf({ targets }) : null),
    model: BudgetLineGoals,
    where: (targets) => ({ lineId: targets[1]! }),
    optional: true,
  }),

  subscription: owned({ model: Subscriptions }),

  loan: owned({ model: LoanDetails, key: 'accountId' }),

  vehicle: owned({ model: Vehicles }),

  portfolio: owned({
    model: Portfolios,
    related: async ({ id }) => ({
      counts: {
        holdingCount: await Holdings.count({ where: { portfolioId: id } }),
        investmentTransactionCount: await InvestmentTransactions.count({ where: { portfolioId: id } }),
      },
    }),
  }),

  holding: under({
    parent: portfolioOf,
    model: Holdings,
    where: (targets) => ({ portfolioId: targets[0]!, securityId: targets[1]! }),
  }),

  investmentTransaction: async ({ userId, targets }) => {
    const record = await InvestmentTransactions.findOne({ where: { id: targets[0]! } });
    if (!record) return null;

    const portfolio = await Portfolios.findOne({ where: { id: record.portfolioId, userId } });
    return portfolio ? loaded({ record }) : null;
  },

  transactionGroup: owned({
    model: TransactionGroups,
    related: async ({ id }) => ({
      counts: { transactionCount: await TransactionGroupItems.count({ where: { groupId: id } }) },
    }),
  }),

  transactionAutomation: owned({ model: TransactionAutomations }),

  transactionTemplate: owned({ model: TransactionTemplates }),

  customCurrency: async ({ userId, targets }) => {
    const record = await Currencies.findOne({ where: { code: targets[0]!, isCustom: true, createdByUserId: userId } });
    return record ? loaded({ record }) : null;
  },

  userCurrency: owned({
    model: UsersCurrencies,
    key: 'currencyCode',
    related: async ({ userId, id }) => ({
      counts: { accountCount: await Accounts.count({ where: { currencyCode: id, userId } }) },
    }),
  }),

  venturePlatform: owned({
    model: VenturePlatforms,
    related: async ({ userId, id }) => ({
      counts: { dealCount: await VentureDeals.count({ where: { platformId: id, userId } }) },
    }),
  }),

  ventureDeal: owned({
    model: VentureDeals,
    related: async ({ userId, id }) => ({
      counts: { eventCount: await VentureEvents.count({ where: { dealId: id, userId } }) },
    }),
  }),

  ventureEvent: owned({
    model: VentureEvents,
    related: async ({ id }) => ({
      counts: { linkCount: await VentureEventLinks.count({ where: { ventureEventId: id } }) },
    }),
  }),

  ventureEventLink: under({
    parent: ({ userId, targets }) => VentureEvents.findOne({ where: { id: targets[0]!, userId } }),
    model: VentureEventLinks,
    where: (targets) => ({ id: targets[1]!, ventureEventId: targets[0]! }),
  }),

  split: owned({ model: TransactionSplits }),

  portfolioTransfer: owned({ model: PortfolioTransfers }),

  attachment: owned({ model: TransactionAttachments }),
};
