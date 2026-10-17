/**
 * Budget Serializers
 *
 * Serializes budget model instances for API responses.
 * Money fields auto-convert via .toNumber().
 * Deserializers convert API decimal inputs to Money.
 */
import { BUDGET_TYPES, ResourceShareInfo } from '@bt/shared/types';
import { Money, minorUnitsToApiDecimal, moneyToApiDecimalOrNull } from '@common/types/money';
import type Budgets from '@models/budget.model';
import type { BudgetShareContext } from '@services/sharing/get-shared-budgets.service';

// ============================================================================
// Response Types
// ============================================================================

interface BudgetCategoryResponse {
  id: string;
  name: string;
  color: string;
  parentId: string | null;
}

interface BudgetApiResponse {
  id: string;
  userId: number;
  name: string;
  status: string;
  type: BUDGET_TYPES;
  startDate: Date | null;
  endDate: Date | null;
  autoInclude: boolean;
  limitAmount: number | null;
  categories: BudgetCategoryResponse[];
  /** Present on user-facing list/detail responses when share context is attached. */
  share?: ResourceShareInfo;
}

// ============================================================================
// Serializers (DB → API)
// ============================================================================

/**
 * Serialize a budget from DB format to API response
 */
export function serializeBudget(budget: Budgets & { _shareContext?: BudgetShareContext }): BudgetApiResponse {
  const categories: BudgetCategoryResponse[] = (budget.categories || []).map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    parentId: c.parentId,
  }));

  const response: BudgetApiResponse = {
    id: budget.id,
    userId: budget.userId,
    name: budget.name,
    status: budget.status,
    type: budget.type,
    startDate: budget.startDate,
    endDate: budget.endDate,
    autoInclude: budget.autoInclude,
    limitAmount: moneyToApiDecimalOrNull(budget.limitAmount),
    categories,
  };

  if (budget._shareContext) {
    response.share = {
      isOwner: budget._shareContext.isOwner,
      owner: budget._shareContext.owner,
      permission: budget._shareContext.permission,
      policy: budget._shareContext.policy,
      accessSource: budget._shareContext.accessSource,
    };
  }

  return response;
}

/**
 * Serialize multiple budgets
 */
export function serializeBudgets(
  budgets: Array<Budgets & { _shareContext?: BudgetShareContext }>,
): BudgetApiResponse[] {
  return budgets.map(serializeBudget);
}

// ============================================================================
// Budget Stats Serializer
// ============================================================================

interface BudgetStatsApiResponse {
  summary: {
    actualIncome: number;
    actualExpense: number;
    balance: number;
    utilizationRate: number | null;
    transactionsCount: number;
    firstTransactionDate: string | null;
    lastTransactionDate: string | null;
  };
}

interface BudgetStatsInternal {
  summary: {
    actualIncome: number | Money;
    actualExpense: number | Money;
    balance: number | Money;
    utilizationRate: number | null;
    transactionsCount: number;
    firstTransactionDate: string | null;
    lastTransactionDate: string | null;
  };
}

/**
 * Serialize budget stats to API decimal format. The sums are minor units at `decimals`.
 */
export function serializeBudgetStats({
  stats,
  decimals,
}: {
  stats: BudgetStatsInternal;
  decimals: number;
}): BudgetStatsApiResponse {
  return {
    summary: {
      actualIncome: minorUnitsToApiDecimal({ value: stats.summary.actualIncome, decimals }),
      actualExpense: minorUnitsToApiDecimal({ value: stats.summary.actualExpense, decimals }),
      balance: minorUnitsToApiDecimal({ value: stats.summary.balance, decimals }),
      utilizationRate: stats.summary.utilizationRate,
      transactionsCount: stats.summary.transactionsCount,
      firstTransactionDate: stats.summary.firstTransactionDate,
      lastTransactionDate: stats.summary.lastTransactionDate,
    },
  };
}

// ============================================================================
// Budget Spending Stats Serializer
// ============================================================================

interface SpendingCategoryInternal {
  categoryId: string;
  name: string;
  color: string;
  amount: number; // minor units
  children?: SpendingCategoryInternal[];
}

interface SpendingStatsInternal {
  spendingsByCategory: SpendingCategoryInternal[];
  spendingOverTime: {
    granularity: 'monthly' | 'weekly';
    periods: {
      periodStart: string;
      periodEnd: string;
      expense: number; // minor units
      income: number; // minor units
    }[];
  };
}

interface BudgetSpendingCategoryApiResponse {
  categoryId: string;
  name: string;
  color: string;
  amount: number;
  children?: BudgetSpendingCategoryApiResponse[];
}

function serializeSpendingCategory({
  item,
  decimals,
}: {
  item: SpendingCategoryInternal;
  decimals: number;
}): BudgetSpendingCategoryApiResponse {
  return {
    categoryId: item.categoryId,
    name: item.name,
    color: item.color,
    amount: minorUnitsToApiDecimal({ value: item.amount, decimals }),
    ...(item.children?.length && {
      children: item.children.map((child) => serializeSpendingCategory({ item: child, decimals })),
    }),
  };
}

export function serializeBudgetSpendingStats({ stats, decimals }: { stats: SpendingStatsInternal; decimals: number }) {
  return {
    spendingsByCategory: stats.spendingsByCategory.map((item) => serializeSpendingCategory({ item, decimals })),
    spendingOverTime: {
      granularity: stats.spendingOverTime.granularity,
      periods: stats.spendingOverTime.periods.map((period) => ({
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        expense: minorUnitsToApiDecimal({ value: period.expense, decimals }),
        income: minorUnitsToApiDecimal({ value: period.income, decimals }),
      })),
    },
  };
}
