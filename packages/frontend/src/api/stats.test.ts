import { viewingNow, viewingTimeZone } from '@/js/helpers/time-zone';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getExpensesAmountForPeriod } from './stats';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/_api', () => ({ api: { get } }));

describe('stats requests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    get.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    viewingTimeZone.value = 'UTC';
    get.mockReset();
  });

  it('sends the calendar day of the viewing zone, which is a day ahead of UTC for a Tbilisi viewer', async () => {
    vi.setSystemTime(new Date('2026-10-20T21:30:00.000Z'));
    viewingTimeZone.value = 'Asia/Tbilisi';

    await getExpensesAmountForPeriod({ from: viewingNow(), to: viewingNow() });

    expect(get).toHaveBeenCalledWith(
      '/stats/expenses-amount-for-period',
      expect.objectContaining({ from: '2026-10-21', to: '2026-10-21' }),
    );
  });
});
