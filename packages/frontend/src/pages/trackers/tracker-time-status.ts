import { TRACKER_STATUSES, type TrackerModel } from '@bt/shared/types';
import { differenceInCalendarDays, endOfDay, format, isAfter, isSameYear, parseISO } from 'date-fns';

const ARCHIVE_PROMPT_AFTER_DAYS = 30;

type DateInput = Date | string | null | undefined;

export type TrackerTimeStatus =
  | { kind: 'active'; daysLeft: number | null }
  | { kind: 'upcoming'; daysUntil: number }
  | { kind: 'ended'; daysSinceEnd: number }
  | { kind: 'noDates' };

export type TrackerGroup = TrackerTimeStatus['kind'] | 'archived';

/** parseISO keeps date-only strings in local time; `new Date('yyyy-MM-dd')` is UTC midnight. */
export const parseTrackerDate = (value: DateInput): Date | null => {
  if (!value) return null;
  const date = typeof value === 'string' ? parseISO(value) : value;
  return isNaN(date.getTime()) ? null : date;
};

export const getTrackerTimeStatus = ({
  startDate,
  endDate,
  now = new Date(),
}: {
  startDate?: DateInput;
  endDate?: DateInput;
  now?: Date;
}): TrackerTimeStatus => {
  const start = parseTrackerDate(startDate);
  const end = parseTrackerDate(endDate);
  if (!start && !end) return { kind: 'noDates' };

  if (end && isAfter(now, endOfDay(end))) return { kind: 'ended', daysSinceEnd: differenceInCalendarDays(now, end) };
  if (start && isAfter(start, now)) return { kind: 'upcoming', daysUntil: differenceInCalendarDays(start, now) };
  return { kind: 'active', daysLeft: end ? differenceInCalendarDays(end, now) : null };
};

export const getTrackerGroup = ({
  tracker,
  now = new Date(),
}: {
  tracker: Pick<TrackerModel, 'status' | 'startDate' | 'endDate'>;
  now?: Date;
}): TrackerGroup => {
  if (tracker.status === TRACKER_STATUSES.archived) return 'archived';
  const status = getTrackerTimeStatus({ startDate: tracker.startDate, endDate: tracker.endDate, now });
  return status.kind;
};

export const TRACKER_GROUP_ORDER: TrackerGroup[] = ['active', 'upcoming', 'noDates', 'ended', 'archived'];

export const shouldSuggestArchive = ({
  tracker,
  now = new Date(),
}: {
  tracker: Pick<TrackerModel, 'status' | 'startDate' | 'endDate' | 'archivePromptDismissed'>;
  now?: Date;
}): boolean => {
  if (tracker.status === TRACKER_STATUSES.archived || tracker.archivePromptDismissed) return false;
  const status = getTrackerTimeStatus({ startDate: tracker.startDate, endDate: tracker.endDate, now });
  return status.kind === 'ended' && status.daysSinceEnd >= ARCHIVE_PROMPT_AFTER_DAYS;
};

interface TrackerStatusLabel {
  key: string;
  params?: Record<string, number>;
}

export const getTrackerStatusLabel = ({ status }: { status: TrackerTimeStatus }): TrackerStatusLabel | null => {
  if (status.kind === 'active') {
    if (status.daysLeft === null) return null;
    if (status.daysLeft <= 0) return { key: 'budgets.list.status.lastDay' };
    if (status.daysLeft === 1) return { key: 'budgets.list.status.oneDayLeft' };
    return { key: 'budgets.list.status.daysLeft', params: { count: status.daysLeft } };
  }
  if (status.kind === 'upcoming') {
    if (status.daysUntil <= 0) return { key: 'budgets.list.status.startsToday' };
    if (status.daysUntil === 1) return { key: 'budgets.list.status.startsTomorrow' };
    return { key: 'budgets.list.status.startsInDays', params: { count: status.daysUntil } };
  }
  if (status.kind === 'ended') return { key: 'budgets.list.status.ended' };
  return null;
};

export const formatDateRange = ({ from, to }: { from?: DateInput; to?: DateInput }): string | null => {
  const start = parseTrackerDate(from);
  const end = parseTrackerDate(to);
  if (start && end) {
    const startPattern = isSameYear(start, end) ? 'MMM d' : 'MMM d, yyyy';
    return `${format(start, startPattern)} → ${format(end, 'MMM d, yyyy')}`;
  }
  if (start) return `${format(start, 'MMM d, yyyy')} →`;
  if (end) return `→ ${format(end, 'MMM d, yyyy')}`;
  return null;
};
