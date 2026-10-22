import { DEFAULT_SORTING, type TableSorting } from '@/components/transactions-table/columns';
import { viewingNow } from '@/js/helpers/time-zone';
import { type SavedTransactionView, TRANSACTION_DATE_PRESETS, type TransactionDatePreset } from '@bt/shared/types';
import { StorageSerializers, useSessionStorage } from '@vueuse/core';
import { endOfDay, isSameDay, startOfDay, startOfMonth, subMonths } from 'date-fns';

import { DEFAULT_FILTERS, type FiltersStruct } from './const';
import { parseStoredFilters } from './transactions-with-filters';

const PRESET_STARTS: Record<TransactionDatePreset, (params: { now: Date }) => Date> = {
  thisMonth: ({ now }) => startOfMonth(now),
  last3Months: ({ now }) => startOfDay(subMonths(now, 3)),
  last6Months: ({ now }) => startOfDay(subMonths(now, 6)),
  last12Months: ({ now }) => startOfDay(subMonths(now, 12)),
};

/**
 * `appliedOn` is the day the view's rolling range was resolved. Comparing against that day keeps
 * a day change from reading as an edit, without mistaking a hand-picked range for the rolling one.
 */
interface ActiveView {
  id: string;
  appliedOn: string;
}

export const useActiveView = () =>
  useSessionStorage<ActiveView | null>('records:active-view', null, { serializer: StorageSerializers.object });

export const resolveDatePreset = ({ preset, now = viewingNow() }: { preset: TransactionDatePreset; now?: Date }) => ({
  from: PRESET_STARTS[preset]({ now }),
  to: endOfDay(now),
});

export const detectDatePreset = ({
  start,
  end,
  now = viewingNow(),
}: {
  start: Date | undefined;
  end: Date | undefined;
  now?: Date;
}): TransactionDatePreset | undefined =>
  start && end && isSameDay(end, now)
    ? TRANSACTION_DATE_PRESETS.find((preset) => isSameDay(start, PRESET_STARTS[preset]({ now })))
    : undefined;

interface ViewState {
  filters: FiltersStruct;
  sorting: TableSorting;
}

export const buildViewConfig = ({
  filters,
  sorting,
}: ViewState): Pick<SavedTransactionView, 'filters' | 'sorting' | 'datePreset'> => ({
  // `batchId` only ever comes from an Import History deep link; a view must not stay scoped to one import.
  filters: JSON.parse(JSON.stringify({ ...filters, batchId: null })),
  sorting,
  datePreset: detectDatePreset({ start: filters.start, end: filters.end }),
});

export const resolveView = ({ view, now }: { view: SavedTransactionView; now?: Date }): ViewState => {
  const stored = parseStoredFilters({ raw: JSON.stringify({ filters: view.filters }) });
  const range = view.datePreset ? resolveDatePreset({ preset: view.datePreset, now }) : undefined;

  return {
    filters: { ...DEFAULT_FILTERS, ...stored?.filters, ...(range && { start: range.from, end: range.to }) },
    sorting: view.sorting ?? DEFAULT_SORTING,
  };
};

/** Whether `filters` still hold the view's rolling range exactly as it was resolved on `appliedOn`. */
export const holdsPresetRange = ({
  view,
  filters,
  appliedOn,
}: {
  view: SavedTransactionView;
  filters: FiltersStruct;
  appliedOn: Date;
}) => {
  if (!view.datePreset || !filters.start || !filters.end) return false;
  const { from, to } = resolveDatePreset({ preset: view.datePreset, now: appliedOn });

  return isSameDay(filters.start, from) && isSameDay(filters.end, to);
};
