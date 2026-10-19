import { monthOf, reportMonthEndAiUsage } from '@services/ai/ai-allowance';
import { withLock } from '@services/common/lock';
import { subDays } from 'date-fns';

import { createScheduledSync } from './lib/create-scheduled-sync';

/** Runs just after the reset and reports the month that ended, so no spend is missed. */
export const aiUsageMonthEndCron = createScheduledSync({
  name: 'AI usage month-end report',
  cronExpression: '5 0 1 * *',
  timeZone: 'UTC',
  scheduleDescription: 'runs at 00:05 UTC on the 1st of each month',
  errorCode: 'AI_USAGE_MONTH_END_CRON',
  run: withLock('lock:cron:ai-usage-month-end', () =>
    reportMonthEndAiUsage({ month: monthOf({ now: subDays(new Date(), 1) }) }),
  ),
});
