import { zonedDayEnd, zonedDayStart } from '@bt/shared/time-zone';
import type { CashFlowGranularity, NetWorthHistoryGranularity, PivotGranularity } from '@bt/shared/types';
import { toInstant, tzOptions } from '@common/lib/time-zones/tz-options';
import {
  addDays,
  addMonths,
  addQuarters,
  addWeeks,
  addYears,
  endOfDay,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  endOfYear,
  isBefore,
  max,
  min,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
} from 'date-fns';
import { Op } from 'sequelize';

export { getScopedEnabledPortfolios } from './scoped-portfolios';
export { fetchSavingsTransactions } from './savings-transactions';

type ColumnName = 'time' | 'date';
interface DateQuery {
  // yyyy-mm-dd
  from?: string;
  // yyyy-mm-dd
  to?: string;
  columnName: ColumnName;
}

export const getWhereConditionForTime = ({ from, to, columnName }: DateQuery) => {
  const where: Partial<Record<ColumnName, Record<symbol, Date[] | Date>>> = {};

  if (from && to) {
    where[columnName] = {
      [Op.between]: [new Date(from), endOfDay(new Date(to))],
    };
  } else if (from) {
    where[columnName] = {
      [Op.gte]: new Date(from),
    };
  } else if (to) {
    where[columnName] = {
      [Op.lte]: new Date(to),
    };
  }

  return where;
};

/**
 * Minimal time-bucket shape shared by the stats reports. The per-report bucket generators
 * (cash-flow, pivot) produce richer buckets that structurally include these two fields.
 */
export interface PeriodBucket {
  periodStart: Date;
  periodEnd: Date;
}

// Weeks start on Monday (ISO), matching every stats report.
const WEEK_OPTS = { weekStartsOn: 1 } as const;

interface GranularitySpec {
  /** Snap a date back to the start of its period, in `zone`. */
  startOf: (date: Date, zone: string) => Date;
  /** End of the period that begins at `periodStart`, in `zone`. */
  endOf: (periodStart: Date, zone: string) => Date;
  /** Step to the next period's start, in `zone`. */
  advance: (periodStart: Date, zone: string) => Date;
}

type StatsGranularity = PivotGranularity | CashFlowGranularity | NetWorthHistoryGranularity;

// date-fns runs every calendar step in the zone and hands back a zone-aware date; each spec
// returns the plain instant so buckets compare and serialise like any other Date.
const inZone = ({ zone }: { zone: string }) => tzOptions({ zone });

// Every granularity used by any stats report. `biweekly` (cash-flow only) is a 2-week window, so
// its period end is the day before the start of the week two ahead.
const GRANULARITY_SPECS: Record<StatsGranularity, GranularitySpec> = {
  yearly: {
    startOf: (date, zone) => toInstant({ date: startOfYear(date, inZone({ zone })) }),
    endOf: (date, zone) => toInstant({ date: endOfYear(date, inZone({ zone })) }),
    advance: (date, zone) => toInstant({ date: addYears(date, 1, inZone({ zone })) }),
  },
  quarterly: {
    startOf: (date, zone) => toInstant({ date: startOfQuarter(date, inZone({ zone })) }),
    endOf: (date, zone) => toInstant({ date: endOfQuarter(date, inZone({ zone })) }),
    advance: (date, zone) => toInstant({ date: addQuarters(date, 1, inZone({ zone })) }),
  },
  monthly: {
    startOf: (date, zone) => toInstant({ date: startOfMonth(date, inZone({ zone })) }),
    endOf: (date, zone) => toInstant({ date: endOfMonth(date, inZone({ zone })) }),
    advance: (date, zone) => toInstant({ date: addMonths(date, 1, inZone({ zone })) }),
  },
  weekly: {
    startOf: (date, zone) => toInstant({ date: startOfWeek(date, { ...WEEK_OPTS, ...inZone({ zone }) }) }),
    endOf: (date, zone) => toInstant({ date: endOfWeek(date, { ...WEEK_OPTS, ...inZone({ zone }) }) }),
    advance: (date, zone) => toInstant({ date: addWeeks(date, 1, inZone({ zone })) }),
  },
  biweekly: {
    startOf: (date, zone) => toInstant({ date: startOfWeek(date, { ...WEEK_OPTS, ...inZone({ zone }) }) }),
    endOf: (date, zone) =>
      toInstant({
        date: endOfDay(addDays(addWeeks(date, 2, inZone({ zone })), -1, inZone({ zone })), inZone({ zone })),
      }),
    advance: (date, zone) => toInstant({ date: addWeeks(date, 2, inZone({ zone })) }),
  },
  daily: {
    startOf: (date, zone) => toInstant({ date: startOfDay(date, inZone({ zone })) }),
    endOf: (date, zone) => toInstant({ date: endOfDay(date, inZone({ zone })) }),
    advance: (date, zone) => toInstant({ date: addDays(date, 1, inZone({ zone })) }),
  },
};

/**
 * Generates the [from, to] time buckets (one per report column) for a granularity. Both edges are
 * clamped to the requested range exactly — the first bucket starts at the start of `from`, the
 * last ends at the end of `to` — so a transaction on the boundary day is still counted. Days,
 * weeks, months and years are the ones of `zone`, the viewing zone of the report's user (`'UTC'`
 * for reports that must stay on UTC days). Shared by the cash-flow, pivot and net-worth-history
 * reports.
 */
export const generatePeriodBuckets = ({
  from,
  to,
  granularity,
  zone,
}: {
  from: string;
  to: string;
  granularity: StatsGranularity;
  zone: string;
}): PeriodBucket[] => {
  const spec = GRANULARITY_SPECS[granularity];
  const buckets: PeriodBucket[] = [];
  const startDate = zonedDayStart({ date: from, zone });
  const endDate = zonedDayEnd({ date: to, zone });

  const withinRange = (date: Date): boolean => isBefore(date, endDate) || date.getTime() === endDate.getTime();

  let currentStart = spec.startOf(startDate, zone);
  while (withinRange(currentStart)) {
    buckets.push({
      periodStart: max([currentStart, startDate]),
      periodEnd: min([spec.endOf(currentStart, zone), endDate]),
    });
    currentStart = spec.advance(currentStart, zone);
  }

  return buckets;
};

/**
 * Index of the bucket a transaction time falls into, or -1 when it is outside every bucket.
 * Both edges are inclusive, so a time exactly on a `periodStart` or `periodEnd` counts.
 */
export const findBucketIndex = ({
  transactionTime,
  buckets,
}: {
  transactionTime: Date;
  buckets: PeriodBucket[];
}): number => {
  const txTime = transactionTime.getTime();
  return buckets.findIndex((bucket) => txTime >= bucket.periodStart.getTime() && txTime <= bucket.periodEnd.getTime());
};
