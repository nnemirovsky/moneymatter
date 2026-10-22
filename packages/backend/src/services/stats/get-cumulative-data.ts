import {
  type CumulativeMetric,
  type CumulativeMonthData,
  type CumulativePeriodData,
  type GetCumulativeResponse,
  TRANSACTION_TYPES,
} from '@bt/shared/types';
import { formatDayInZone } from '@common/lib/time-zones/tz-options';
import { TZDate } from '@date-fns/tz';
import { expandCategoryIdsWithDescendants } from '@services/categories/category-hierarchy';
import { getAccessibleCategoryMap } from '@services/categories/get-accessible-category-map.service';
import { type StatsScopeFilters, buildStatsScopeWhere } from '@services/stats/stats-scope-filters';
import { statsTransactions } from '@services/stats/stats-transactions';
import { getUserTimeZone } from '@services/user-settings/get-user-time-zone';
import { differenceInMonths, endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns';
import { Op } from 'sequelize';

interface GetCumulativeDataParams extends StatsScopeFilters {
  userId: number;
  from: string;
  to: string;
  metric: CumulativeMetric;
  categoryIds?: string[];
  /** Expanded to descendants before the query, so hiding a parent hides its children. */
  excludedCategoryIds?: string[];
  /** Decimals of the base currency: the scale the returned amounts are summed at (minor units). */
  decimals: number;
}

/** Both category id lists are already expanded to descendants. */
interface PeriodDataParams extends Omit<GetCumulativeDataParams, 'categoryIds' | 'excludedCategoryIds'> {
  includeCategoryIds?: string[];
  excludeCategoryIds?: string[];
}

/** `year-monthIndex` (0-11) of the calendar month `time` falls in, in `zone`. */
const zoneMonthKey = ({ time, zone }: { time: Date | string; zone: string }) => {
  const inZone = new TZDate(new Date(time), zone);
  return `${inZone.getFullYear()}-${inZone.getMonth()}`;
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Fetches cumulative data for a date range, calculating running totals per month.
 * Returns data for both the requested period and the immediately preceding period for comparison.
 * (Period-over-Period comparison: e.g., Aug-Oct compared to May-Jul)
 */
export const getCumulativeData = async ({
  userId,
  from,
  to,
  metric,
  accountId,
  accountIds,
  payeeIds,
  excludedPayeeIds,
  tagIds,
  excludedTagIds,
  categoryIds,
  excludedCategoryIds,
  decimals,
}: GetCumulativeDataParams): Promise<GetCumulativeResponse> => {
  // Use parseISO for consistent date parsing (treats dates as local time, not UTC)
  const fromDate = parseISO(from);
  const toDate = parseISO(to);

  // Calculate period length in months (add 1 because both ends are inclusive)
  const periodLengthMonths = differenceInMonths(startOfMonth(toDate), startOfMonth(fromDate)) + 1;

  // Calculate the immediately preceding period of the same length
  // e.g., if selected Aug-Oct (3 months), previous period is May-Jul (3 months before)
  const prevFromDate = subMonths(fromDate, periodLengthMonths);
  const prevToDate = subMonths(toDate, periodLengthMonths);
  const prevFrom = format(prevFromDate, 'yyyy-MM-dd');
  const prevTo = format(prevToDate, 'yyyy-MM-dd');

  let includeCategoryIds: string[] | undefined;
  let excludeCategoryIds: string[] | undefined;

  if (categoryIds?.length || excludedCategoryIds?.length) {
    const { categories, byId } = await getAccessibleCategoryMap({ userId });

    if (categoryIds?.length) {
      includeCategoryIds = expandCategoryIdsWithDescendants({ categoryIds, categories, byId });
    }
    if (excludedCategoryIds?.length) {
      excludeCategoryIds = expandCategoryIdsWithDescendants({ categoryIds: excludedCategoryIds, categories, byId });
    }
  }

  const scope = {
    accountId,
    accountIds,
    payeeIds,
    excludedPayeeIds,
    tagIds,
    excludedTagIds,
    includeCategoryIds,
    excludeCategoryIds,
  };

  const currentPeriodData = await getPeriodData({ userId, from, to, metric, decimals, ...scope });

  const previousPeriodData = await getPeriodData({ userId, from: prevFrom, to: prevTo, metric, decimals, ...scope });

  // Calculate period-over-period percent change
  let percentChange = 0;
  if (previousPeriodData.total !== 0) {
    percentChange = Math.round(
      ((currentPeriodData.total - previousPeriodData.total) / Math.abs(previousPeriodData.total)) * 100,
    );
  } else if (currentPeriodData.total > 0) {
    percentChange = 100;
  } else if (currentPeriodData.total < 0) {
    percentChange = -100;
  }

  return {
    currentPeriod: currentPeriodData,
    previousPeriod: previousPeriodData,
    percentChange,
  };
};

async function getPeriodData({
  userId,
  from,
  to,
  metric,
  accountId,
  accountIds,
  payeeIds,
  excludedPayeeIds,
  tagIds,
  excludedTagIds,
  includeCategoryIds,
  excludeCategoryIds,
  decimals,
}: PeriodDataParams): Promise<CumulativePeriodData> {
  // The report's months are calendar months in the user's zone: `from`/`to` name zone days, and each
  // transaction is keyed by the month its instant falls in there. Month arithmetic runs on a
  // month index (year * 12 + month) so it does not depend on the server's zone.
  const zone = await getUserTimeZone({ userId });
  const monthIndexOf = ({ day }: { day: string }) => {
    const [year, month] = day.split('-').map(Number);
    return year! * 12 + (month! - 1);
  };
  const fromIndex = monthIndexOf({ day: from });
  const nowInZone = new TZDate(Date.now(), zone);
  const nowIndex = nowInZone.getFullYear() * 12 + nowInZone.getMonth();

  // Limit 'to' date to current month if it's in the future
  const toIsFuture = to > formatDayInZone({ date: nowInZone, zone });
  const effectiveToIndex = toIsFuture ? nowIndex : monthIndexOf({ day: to });
  const effectiveTo = toIsFuture ? format(endOfMonth(nowInZone), 'yyyy-MM-dd') : to;

  // Both directions are always loaded, whatever the metric: a refund pairs an expense with an
  // income, and netting one side needs the other side in scope.
  const { rows: transactions, refundPairs } = await statsTransactions({
    access: { accessibleTo: userId },
    planned: 'exclude',
    refunds: 'net',
    decimals,
    window: { from, to: effectiveTo, zone },
    // ponytail: query-level category filter ignores split legs; route through computeCategoryAllocations if totals must match cash-flow exactly
    where: {
      [Op.and]: [
        { transactionType: { [Op.in]: [TRANSACTION_TYPES.income, TRANSACTION_TYPES.expense] } },
        ...(includeCategoryIds?.length ? [{ categoryId: { [Op.in]: includeCategoryIds } }] : []),
        ...(excludeCategoryIds?.length
          ? [{ [Op.or]: [{ categoryId: null }, { categoryId: { [Op.notIn]: excludeCategoryIds } }] }]
          : []),
        ...buildStatsScopeWhere({ accountId, accountIds, payeeIds, excludedPayeeIds, tagIds, excludedTagIds }),
      ],
    },
    attributes: ['id', 'time', 'refAmount', 'transactionType', 'categoryId', 'refundLinked'],
  });

  // Build a map of year-month to aggregate values
  const monthlyDataMap = new Map<string, { income: number; expenses: number }>();

  // Aggregate transactions into months
  for (const tx of transactions) {
    // A row with no base-currency amount (custom currency, no rate yet) is left out of the totals.
    if (tx.refAmount === null) continue;

    const monthKey = zoneMonthKey({ time: tx.time, zone });

    if (!monthlyDataMap.has(monthKey)) {
      monthlyDataMap.set(monthKey, { income: 0, expenses: 0 });
    }

    const monthEntry = monthlyDataMap.get(monthKey)!;

    if (tx.transactionType === TRANSACTION_TYPES.income) {
      monthEntry.income += tx.refAmount.toMinorUnits({ decimals });
    } else if (tx.transactionType === TRANSACTION_TYPES.expense) {
      monthEntry.expenses += Math.abs(tx.refAmount.toMinorUnits({ decimals }));
    }
  }

  // Refunded money was neither spent nor earned: both halves leave in the month the money came
  // back, which keeps the savings metric (income - expenses) untouched. A pair with only one half
  // in scope stays gross — subtracting it alone would remove money the report never counted.
  for (const pair of refundPairs) {
    if (!pair.expenseInScope || !pair.incomeInScope) continue;

    const monthEntry = monthlyDataMap.get(zoneMonthKey({ time: pair.time, zone }));
    if (!monthEntry) continue;

    monthEntry.income -= pair.minor;
    monthEntry.expenses -= pair.minor;
  }

  // Build cumulative data based on metric
  const data: CumulativeMonthData[] = [];
  let cumulativeValue = 0;

  let monthCounter = 1;

  for (let monthIndex = fromIndex; monthIndex <= effectiveToIndex; monthIndex++) {
    // Don't include months in the future
    if (monthIndex > nowIndex) break;

    const month = monthIndex % 12;
    const monthData = monthlyDataMap.get(`${Math.floor(monthIndex / 12)}-${month}`) || { income: 0, expenses: 0 };
    // `month` is 0-11, which always maps to a valid MONTH_LABELS index
    const monthLabel = MONTH_LABELS[month]!;

    let periodValue = 0;

    switch (metric) {
      case 'income':
        periodValue = monthData.income;
        break;
      case 'expenses':
        periodValue = monthData.expenses;
        break;
      case 'savings':
        periodValue = monthData.income - monthData.expenses;
        break;
    }

    cumulativeValue += periodValue;

    data.push({
      month: monthCounter,
      monthLabel,
      value: cumulativeValue,
      periodValue,
    });

    monthCounter++;
  }

  // Use the year from the 'from' date as the period identifier
  return {
    year: Math.floor(fromIndex / 12),
    data,
    total: cumulativeValue,
  };
}
