import type { NotificationSourceDto, RecordId } from '@bt/shared/types';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { createGlobalPlugins } from '../test-support';
import ChooseAppDialog from './choose-app-dialog.vue';

const { mockSearch, mockChoose, mockReset } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockChoose: vi.fn(),
  mockReset: vi.fn(),
}));

vi.mock('@/api/ingest', () => ({
  searchSourceApps: mockSearch,
  chooseSourceApp: mockChoose,
  resetSourceApp: mockReset,
}));
vi.mock('@/components/notification-center', () => ({
  NotificationType: { error: 'error' },
  useNotificationCenter: () => ({
    addSuccessNotification: vi.fn(),
    addErrorNotification: vi.fn(),
    addNotification: vi.fn(),
  }),
}));
vi.mock('@/components/common/responsive-dialog.vue', async () => ({
  default: (await import('../test-support')).createResponsiveDialogStub(),
}));
// The country picker is a searchable select; here only the value it holds and what it emits matter.
vi.mock('@/components/fields/select-field.vue', () => ({
  default: defineComponent({
    props: { modelValue: { type: Object, default: null }, values: { type: Array, default: () => [] } },
    emits: ['update:modelValue'],
    setup:
      (props, { emit }) =>
      () =>
        h('div', { 'data-testid': 'choose-app-storefront' }, [
          h(
            'span',
            { 'data-testid': 'storefront-value' },
            (props.modelValue as { value?: string } | null)?.value ?? '',
          ),
          h('button', {
            'data-testid': 'storefront-pick-de',
            onClick: () => emit('update:modelValue', { value: 'de', label: 'Germany' }),
          }),
        ]),
  }),
}));

const makeSource = (overrides: Partial<NotificationSourceDto> = {}): NotificationSourceDto => ({
  id: 'source-1' as RecordId,
  appName: 'Example Bank',
  bundleId: null,
  iconUrl: null,
  iconOverride: false,
  sender: null,
  conversational: false,
  mode: 'approved',
  defaultAccountId: null,
  counters: {},
  lastSeenAt: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  ...overrides,
});

const APPS = [
  {
    bundleId: 'com.example.bank',
    name: 'Example Bank',
    developer: 'Example Software Ltd',
    iconUrl: 'https://cdn.example.com/b.jpg',
  },
  {
    bundleId: 'com.example.bank.pro',
    name: 'Example Bank Pro',
    developer: null,
    iconUrl: 'https://cdn.example.com/p.jpg',
  },
];

const mountDialog = async ({ source = makeSource() }: { source?: NotificationSourceDto } = {}) => {
  const { plugins } = createGlobalPlugins();
  const wrapper = mount(ChooseAppDialog, { props: { open: true, source }, global: { plugins } });
  // The search is debounced.
  await vi.advanceTimersByTimeAsync(450);
  await flushPromises();

  return wrapper;
};

describe('ChooseAppDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockSearch.mockResolvedValue({ storefront: 'us', apps: APPS });
    mockChoose.mockResolvedValue(makeSource({ iconOverride: true }));
    mockReset.mockResolvedValue(makeSource());
  });

  it('starts from the app name of the source, in the user’s own storefront', async () => {
    const wrapper = await mountDialog();

    expect(mockSearch).toHaveBeenCalledWith({ term: 'Example Bank', storefront: null });
    expect(wrapper.get('[data-testid="storefront-value"]').text()).toBe('us');
  });

  it('lists the apps with icon, name and developer', async () => {
    const wrapper = await mountDialog();

    const results = wrapper.findAll('[data-testid="choose-app-result"]');
    expect(results).toHaveLength(2);
    expect(results[0]!.get('img').attributes('src')).toBe('https://cdn.example.com/b.jpg');
    expect(results[0]!.text()).toContain('Example Bank');
    expect(results[0]!.text()).toContain('Example Software Ltd');
    expect(results[1]!.text()).not.toContain('Example Software Ltd');
  });

  it('searches again, debounced, in the storefront the owner picks', async () => {
    const wrapper = await mountDialog();

    await wrapper.get('[data-testid="storefront-pick-de"]').trigger('click');
    await flushPromises();

    expect(mockSearch).toHaveBeenLastCalledWith({ term: 'Example Bank', storefront: 'de' });
  });

  it('does not search for fewer than two letters, and says so', async () => {
    const wrapper = await mountDialog({ source: makeSource({ appName: 'E' }) });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="choose-app-hint"]').exists()).toBe(true);
  });

  it('says so when the store has no such app', async () => {
    mockSearch.mockResolvedValue({ storefront: 'us', apps: [] });

    const wrapper = await mountDialog();

    expect(wrapper.find('[data-testid="choose-app-empty"]').exists()).toBe(true);
  });

  it('stores the picked app with the storefront it was found in, and closes', async () => {
    const wrapper = await mountDialog();

    await wrapper.findAll('[data-testid="choose-app-result"]')[1]!.trigger('click');
    await flushPromises();

    expect(mockChoose).toHaveBeenCalledWith({ id: 'source-1', bundleId: 'com.example.bank.pro', storefront: 'us' });
    expect(wrapper.emitted('update:open')).toEqual([[false]]);
  });

  it('offers the reset only for a source whose app the owner chose, and resets it', async () => {
    expect((await mountDialog()).find('[data-testid="choose-app-reset"]').exists()).toBe(false);

    const wrapper = await mountDialog({ source: makeSource({ iconOverride: true }) });
    await wrapper.get('[data-testid="choose-app-reset"]').trigger('click');
    await flushPromises();

    expect(mockReset).toHaveBeenCalledWith({ id: 'source-1' });
    expect(wrapper.emitted('update:open')).toEqual([[false]]);
  });

  it('stays open when the app cannot be saved', async () => {
    mockChoose.mockRejectedValue(new Error('refused'));
    const wrapper = await mountDialog();

    await wrapper.findAll('[data-testid="choose-app-result"]')[0]!.trigger('click');
    await flushPromises();

    expect(wrapper.emitted('update:open')).toBeUndefined();
  });
});
