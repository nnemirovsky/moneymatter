import { zonedDayEnd, zonedDayStart } from '@bt/shared/time-zone';
import { endOfDay } from 'date-fns';

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * First instant of a report bound. A `yyyy-MM-dd` day starts at local midnight in `zone`; any
 * other string is an exact ISO time and is read as it is.
 */
export const dayBoundStart = ({ value, zone }: { value: string; zone: string }): Date =>
  DAY_ONLY.test(value) ? zonedDayStart({ date: value, zone }) : new Date(value);

/** Last instant of a report bound: the end of the local day for a `yyyy-MM-dd` day, else the end of the UTC-read day. */
export const dayBoundEnd = ({ value, zone }: { value: string; zone: string }): Date =>
  DAY_ONLY.test(value) ? zonedDayEnd({ date: value, zone }) : endOfDay(new Date(value));
