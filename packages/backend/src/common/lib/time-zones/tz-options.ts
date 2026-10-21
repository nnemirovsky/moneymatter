import { tz } from '@date-fns/tz';
import { format } from 'date-fns';

/** date-fns `in` option that runs a calendar operation (start of day, week, month…) in `zone`. */
export const tzOptions = ({ zone }: { zone: string }) => ({ in: tz(zone) });

/** Drops the zone-aware wrapper date-fns returns, leaving a plain `Date` for the same instant. */
export const toInstant = ({ date }: { date: Date }): Date => new Date(date.getTime());

/** `yyyy-MM-dd` calendar day of `date` in `zone`. */
export const formatDayInZone = ({ date, zone }: { date: Date; zone: string }): string =>
  format(date, 'yyyy-MM-dd', tzOptions({ zone }));
