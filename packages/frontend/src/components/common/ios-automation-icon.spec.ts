import IosAutomationIcon from '@/components/common/ios-automation-icon.vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIcons } = vi.hoisted(() => ({ mockIcons: vi.fn() }));
vi.mock('@/api/ingest', () => ({ getIosAutomationIcons: mockIcons }));

const mountIcon = async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = mount(IosAutomationIcon, { global: { plugins: [[VueQueryPlugin, { queryClient }]] } });
  await flushPromises();

  return wrapper;
};

describe('IosAutomationIcon', () => {
  beforeEach(() => {
    mockIcons.mockReset();
  });

  it('splits the square diagonally: Shortcuts clipped to the top-left over a whole Wallet, with no line between', async () => {
    mockIcons.mockResolvedValue({
      shortcuts: 'https://cdn.example.com/s.jpg',
      wallet: 'https://cdn.example.com/w.jpg',
    });

    const wrapper = await mountIcon();

    const shortcuts = wrapper.get('[data-testid="ios-automation-shortcuts"]');
    const wallet = wrapper.get('[data-testid="ios-automation-wallet"]');
    expect(shortcuts.get('img').attributes('src')).toBe('https://cdn.example.com/s.jpg');
    expect(wallet.get('img').attributes('src')).toBe('https://cdn.example.com/w.jpg');
    expect(shortcuts.attributes('style')).toContain('polygon(0 0, 100% 0, 0 100%)');
    expect(wallet.attributes('style') ?? '').not.toContain('polygon');
    expect(wrapper.find('line').exists()).toBe(false);
  });

  it('draws its own icon for a half the server found none for', async () => {
    mockIcons.mockResolvedValue({ shortcuts: 'https://cdn.example.com/s.jpg', wallet: null });

    const wrapper = await mountIcon();

    expect(wrapper.find('[data-testid="ios-automation-shortcuts"] img').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ios-automation-wallet"] img').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ios-automation-wallet"] svg').exists()).toBe(true);
  });

  it('draws its own icon for a half whose image fails to load', async () => {
    mockIcons.mockResolvedValue({
      shortcuts: 'https://cdn.example.com/s.jpg',
      wallet: 'https://cdn.example.com/w.jpg',
    });

    const wrapper = await mountIcon();
    await wrapper.get('[data-testid="ios-automation-shortcuts"] img').trigger('error');

    expect(wrapper.find('[data-testid="ios-automation-shortcuts"] img').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ios-automation-shortcuts"] svg').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ios-automation-wallet"] img').exists()).toBe(true);
  });

  it('keeps the single wallet drawing when neither icon was found', async () => {
    mockIcons.mockResolvedValue({ shortcuts: null, wallet: null });

    expect((await mountIcon()).find('[data-testid="ios-automation-icon-fallback"]').exists()).toBe(true);
  });

  it('keeps the single wallet drawing when the request fails', async () => {
    mockIcons.mockRejectedValue(new Error('offline'));

    const wrapper = await mountIcon();

    expect(wrapper.find('[data-testid="ios-automation-icon-fallback"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ios-automation-icon"]').exists()).toBe(false);
  });
});
