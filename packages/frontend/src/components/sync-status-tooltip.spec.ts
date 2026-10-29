import layoutEn from '@/i18n/locales/chunks/en/layout.json';
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';

import SyncStatusTooltip from './sync-status-tooltip.vue';

vi.mock('@/components/common/ios-automation-icon.vue', () => ({
  default: { template: '<span data-testid="ios-automation-icon" />' },
}));

vi.mock('@/composable/use-ai-allowance', () => ({ useAiAllowance: () => ({ showBadge: () => false }) }));
vi.mock('@/routes/constants', () => ({
  ROUTES_NAMES: {
    accounts: 'accounts',
    accountIosAutomation: 'account-ios-automation',
    accountIntegrationDetails: 'details',
  },
}));

const mountTooltip = (props: Record<string, unknown> = {}) =>
  mount(SyncStatusTooltip, {
    props: {
      accountStatuses: [],
      connectionsNeedingReauth: [],
      syncProgress: { current: 0, total: 0, percentage: 0 },
      lastSyncTimestamp: null,
      ...props,
    },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en: layoutEn } })],
      stubs: {
        RouterLink: { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' },
        AiUsageBadge: true,
        ScrollArea: { template: '<div><slot /></div>' },
      },
    },
  });

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe('SyncStatusTooltip iOS Automation row', () => {
  it('shows the empty state and no iOS Automation row when nothing is connected', () => {
    const wrapper = mountTooltip();

    expect(wrapper.text()).toContain('No bank accounts connected');
    expect(wrapper.find('[data-testid="sync-apple-pay"]').exists()).toBe(false);
  });

  it('drops the empty-state text but keeps the Connect button when iOS Automation is the only connection', () => {
    const wrapper = mountTooltip({ applePay: { waitingCount: 0, lastPaymentAt: minutesAgo(5) } });

    expect(wrapper.text()).not.toContain('No bank accounts connected');
    expect(wrapper.text()).toContain('Connect');
    const links = wrapper.findAll('a').map((link) => JSON.parse(link.attributes('data-to')!));
    expect(links).toContainEqual({ name: 'accounts', query: { connect: 'bank' } });
  });

  it('shows the last payment as relative time and links to the iOS Automation page', () => {
    const wrapper = mountTooltip({ applePay: { waitingCount: 0, lastPaymentAt: minutesAgo(5) } });

    expect(wrapper.get('[data-testid="sync-apple-pay"]').text()).toContain('iOS Automation');
    expect(wrapper.get('[data-testid="sync-apple-pay-last"]').text()).toBe('Last payment 5 minutes ago');
    const links = wrapper.findAll('a').map((link) => JSON.parse(link.attributes('data-to')!));
    expect(links).toContainEqual({ name: 'account-ios-automation' });
  });

  it('says so when no payment has arrived yet', () => {
    const wrapper = mountTooltip({ applePay: { waitingCount: 0, lastPaymentAt: null } });

    expect(wrapper.get('[data-testid="sync-apple-pay-last"]').text()).toBe('No payments yet');
  });

  it('highlights the waiting payments only when there are some', () => {
    expect(
      mountTooltip({ applePay: { waitingCount: 0, lastPaymentAt: null } })
        .find('[data-testid="sync-apple-pay-waiting"]')
        .exists(),
    ).toBe(false);
    expect(
      mountTooltip({ applePay: { waitingCount: 3, lastPaymentAt: null } })
        .get('[data-testid="sync-apple-pay-waiting"]')
        .text(),
    ).toBe('3 waiting');
  });

  it('offers no sync now button for iOS Automation alone, and keeps the bank sync button for banks', () => {
    expect(mountTooltip({ applePay: { waitingCount: 0, lastPaymentAt: null } }).text()).not.toContain('Sync now');
  });
});
