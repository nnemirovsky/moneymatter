import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createGlobalPlugins } from '../test-support';
import UnlinkedCards from './unlinked-cards.vue';

const { mockGetUnlinked } = vi.hoisted(() => ({ mockGetUnlinked: vi.fn() }));

vi.mock('@/api/ingest', () => ({ getUnlinkedCards: mockGetUnlinked }));

const mountUnlinked = async (cards: Array<{ cardLabel: string; count: number; lastDigits?: string | null }>) => {
  mockGetUnlinked.mockResolvedValue(cards);
  const wrapper = mount(UnlinkedCards, { global: { plugins: createGlobalPlugins().plugins } });
  await flushPromises();
  return wrapper;
};

describe('UnlinkedCards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists each card with how many payments wait on it', async () => {
    const wrapper = await mountUnlinked([
      { cardLabel: 'Example Visa', count: 3 },
      { cardLabel: 'Revolut', count: 1 },
    ]);

    const rows = wrapper.findAll('[data-testid="unlinked-card-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('Example Visa');
    expect(rows[0]!.get('[data-testid="unlinked-card-count"]').text()).toBe('3 payments waiting');
    expect(rows[1]!.get('[data-testid="unlinked-card-count"]').text()).toBe('1 payment waiting');
  });

  it('asks to link the card with its label and count', async () => {
    const wrapper = await mountUnlinked([{ cardLabel: 'Example Visa', count: 3 }]);

    await wrapper.get('[data-testid="unlinked-card-link"]').trigger('click');

    expect(wrapper.emitted('link')).toEqual([[{ cardLabel: 'Example Visa', count: 3, lastDigits: undefined }]]);
  });

  it('passes the digits of a card a notification names, to pre-fill the link', async () => {
    const wrapper = await mountUnlinked([{ cardLabel: 'Raiffeisen •1258', count: 1, lastDigits: '1258' }]);

    await wrapper.get('[data-testid="unlinked-card-link"]').trigger('click');

    expect(wrapper.emitted('link')).toEqual([[{ cardLabel: 'Raiffeisen •1258', count: 1, lastDigits: '1258' }]]);
  });

  it('renders nothing when no card is waiting', async () => {
    const wrapper = await mountUnlinked([]);

    expect(wrapper.find('[data-testid="unlinked-cards"]').exists()).toBe(false);
  });

  it('shows an error when the cards cannot be loaded', async () => {
    mockGetUnlinked.mockRejectedValue(new Error('boom'));
    const wrapper = mount(UnlinkedCards, { global: { plugins: createGlobalPlugins().plugins } });
    await flushPromises();

    expect(wrapper.find('[data-testid="unlinked-cards-error"]').exists()).toBe(true);
  });
});
