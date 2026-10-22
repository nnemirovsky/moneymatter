import { viewingTimeZone } from '@/js/helpers/time-zone';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { balanceAdjustment } from './accounts';
import { uploadOfxFile } from './import-ofx';
import { accountToPortfolioTransfer, portfolioToAccountTransfer } from './portfolios';
import { markSubscriptionPeriodPaid } from './subscriptions';

const post = vi.hoisted(() => vi.fn());
const postRaw = vi.hoisted(() => vi.fn());
vi.mock('@/api/_api', () => ({ api: { post, postRaw } }));

describe('request bodies that record a time zone', () => {
  beforeEach(() => {
    viewingTimeZone.value = 'Asia/Tbilisi';
    post.mockResolvedValue({});
  });

  afterEach(() => {
    viewingTimeZone.value = 'UTC';
    post.mockReset();
  });

  it('sends the viewing zone with a balance adjustment', async () => {
    await balanceAdjustment({ id: 'a1', targetBalance: 10, time: new Date('2026-10-21T12:00:00Z') });
    expect(post).toHaveBeenCalledWith(
      '/accounts/a1/balance-adjustment',
      expect.objectContaining({ timeZone: 'Asia/Tbilisi' }),
    );
  });

  it('sends the viewing zone when marking a period paid with a generated transaction', async () => {
    await markSubscriptionPeriodPaid({ id: 's1', periodId: 'p1', createTransaction: true, time: new Date() });
    expect(post).toHaveBeenCalledWith(
      '/subscriptions/s1/periods/p1/pay',
      expect.objectContaining({ timeZone: 'Asia/Tbilisi' }),
    );
  });

  it('sends the viewing zone with an account to portfolio transfer', async () => {
    await accountToPortfolioTransfer({ portfolioId: 'pf', accountId: 'a1', amount: '5', date: '2026-10-21' });
    expect(post).toHaveBeenCalledWith(
      '/investments/portfolios/pf/transfer/from-account',
      expect.objectContaining({ timeZone: 'Asia/Tbilisi' }),
    );
  });

  it('sends the viewing zone with a portfolio to account transfer', async () => {
    await portfolioToAccountTransfer({
      portfolioId: 'pf',
      accountId: 'a1',
      amount: '5',
      currencyCode: 'USD',
      date: '2026-10-21',
    });
    expect(post).toHaveBeenCalledWith(
      '/investments/portfolios/pf/transfer/to-account',
      expect.objectContaining({ timeZone: 'Asia/Tbilisi' }),
    );
  });

  it('sends the viewing zone with the OFX upload', async () => {
    postRaw.mockResolvedValue({});
    await uploadOfxFile({ file: new File(['x'], 'a.ofx') });
    expect(postRaw).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Timezone': 'Asia/Tbilisi' }) }),
    );
  });
});
