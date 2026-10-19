import accountsEn from '@/i18n/locales/chunks/en/pages/accounts.json';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';

import ApplePayConnectionRow from './apple-pay-connection-row.vue';

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock('vue-router', () => ({ useRouter: () => ({ push: mockPush }) }));
vi.mock('@/routes', () => ({ ROUTES_NAMES: { accountApplePay: 'account-apple-pay' } }));

const mountRow = ({ linkedCardsCount = 2, waitingCount = 0 } = {}) =>
  mount(ApplePayConnectionRow, {
    props: { linkedCardsCount, waitingCount },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en: accountsEn } })],
      stubs: { DesktopOnlyTooltip: { template: '<div><slot /></div>' } },
    },
  });

describe('ApplePayConnectionRow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names Apple Pay and counts the linked cards', () => {
    const text = mountRow({ linkedCardsCount: 1 }).text();

    expect(text).toContain('Apple Pay');
    expect(text).toContain('1 card linked');
    expect(mountRow({ linkedCardsCount: 3 }).text()).toContain('3 cards linked');
  });

  it('shows the waiting payments only when there are some', () => {
    expect(mountRow().find('[data-testid="apple-pay-waiting"]').exists()).toBe(false);
    expect(mountRow({ waitingCount: 2 }).get('[data-testid="apple-pay-waiting"]').text()).toBe('2 waiting');
  });

  it('opens the details page from the name and from the manage button', async () => {
    const wrapper = mountRow();

    await wrapper.get('button').trigger('click');
    await wrapper.findAll('button')[1]!.trigger('click');

    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(mockPush).toHaveBeenCalledWith({ name: 'account-apple-pay' });
  });
});
