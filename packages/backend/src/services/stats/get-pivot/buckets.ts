import type { PivotGranularity } from '@bt/shared/types';
import { tzOptions } from '@common/lib/time-zones/tz-options';
import { format, getQuarter, getYear, startOfWeek } from 'date-fns';

import { PeriodBucket, generatePeriodBuckets } from '../utils';

// Weeks start on Monday to match the cash-flow report and ISO conventions.
const WEEK_OPTS = { weekStartsOn: 1 } as const;

/**
 * Generates the time buckets (one per pivot column) for a granularity over [from, to]. Bucketing
 * and edge clamping are shared with the cash-flow report via `generatePeriodBuckets`.
 */
export const generatePivotBuckets = ({
  from,
  to,
  granularity,
  zone,
}: {
  from: string;
  to: string;
  granularity: PivotGranularity;
  zone: string;
}): PeriodBucket[] => generatePeriodBuckets({ from, to, granularity, zone });

/**
 * Stable, range-unique column key. The year is always present so keys never collide across
 * a multi-year range (e.g. Q1 2024 vs Q1 2025). Because edge clamping only ever moves the
 * first bucket's start forward within its own period, deriving the key from `periodStart` is
 * safe. The calendar fields are the ones of `zone`, the zone the buckets were cut in.
 */
export const getBucketKey = ({
  periodStart,
  granularity,
  zone,
}: {
  periodStart: Date;
  granularity: PivotGranularity;
  zone: string;
}): string => {
  const options = tzOptions({ zone });
  switch (granularity) {
    case 'yearly':
      return format(periodStart, 'yyyy', options);
    case 'quarterly':
      return `${getYear(periodStart, options)}-Q${getQuarter(periodStart, options)}`;
    case 'monthly':
      return format(periodStart, 'yyyy-MM', options);
    case 'weekly':
      return format(startOfWeek(periodStart, { ...WEEK_OPTS, ...options }), 'yyyy-MM-dd', options);
  }
};

/**
 * Non-localized default label for a column. The client may reformat/localize from the
 * column's `periodStart` + granularity.
 */
export const getBucketLabel = ({
  periodStart,
  granularity,
  zone,
}: {
  periodStart: Date;
  granularity: PivotGranularity;
  zone: string;
}): string => {
  const options = tzOptions({ zone });
  switch (granularity) {
    case 'yearly':
      return format(periodStart, 'yyyy', options);
    case 'quarterly':
      return `Q${getQuarter(periodStart, options)} ${getYear(periodStart, options)}`;
    case 'monthly':
      return format(periodStart, 'MMM yyyy', options);
    case 'weekly':
      return `Wk of ${format(startOfWeek(periodStart, { ...WEEK_OPTS, ...options }), 'yyyy-MM-dd', options)}`;
  }
};
