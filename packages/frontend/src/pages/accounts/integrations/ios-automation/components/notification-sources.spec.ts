import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import type { NotificationSourceDto, RecordId } from '@bt/shared/types';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createGlobalPlugins } from '../test-support';
import NotificationSources from './notification-sources.vue';

const { mockGet, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('@/api/ingest', () => ({
  getNotificationSources: mockGet,
  updateNotificationSource: mockUpdate,
  deleteNotificationSource: mockDelete,
}));
vi.mock('@/components/notification-center', () => ({
  NotificationType: { error: 'error' },
  useNotificationCenter: () => ({
    addSuccessNotification: vi.fn(),
    addErrorNotification: vi.fn(),
    addNotification: vi.fn(),
  }),
}));
vi.mock('@/components/common/responsive-alert-dialog.vue', async () => ({
  default: (await import('../test-support')).createResponsiveAlertDialogStub(),
}));

const makeSource = (overrides: Partial<NotificationSourceDto> = {}): NotificationSourceDto => ({
  id: 'source-1' as RecordId,
  appName: 'TBC Bank',
  bundleId: null,
  sender: null,
  conversational: false,
  mode: 'auto',
  defaultAccountId: null,
  counters: {},
  lastSeenAt: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  ...overrides,
});

const mountSources = async ({ sources }: { sources: NotificationSourceDto[] }) => {
  mockGet.mockResolvedValue(sources);
  const { plugins, queryClient } = createGlobalPlugins();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = mount(NotificationSources, { global: { plugins } });
  await flushPromises();
  return { wrapper, invalidate };
};

describe('NotificationSources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(makeSource());
    mockDelete.mockResolvedValue({ success: true });
  });

  it('lists the sources that have an answer with their mode, and leaves the waiting ones to their own section', async () => {
    const { wrapper } = await mountSources({
      sources: [
        makeSource(),
        makeSource({ id: 'approved' as RecordId, appName: 'Revolut', mode: 'approved' }),
        makeSource({ id: 'muted' as RecordId, appName: 'Telegram', mode: 'muted' }),
        makeSource({ id: 'pending' as RecordId, appName: 'Messages', mode: 'pending' }),
      ],
    });

    const rows = wrapper.findAll('[data-testid="notification-source-row"]');
    expect(rows.map((row) => row.get('[data-testid="notification-source-name"]').text())).toEqual([
      'TBC Bank',
      'Revolut',
      'Telegram',
    ]);
    expect(rows.map((row) => row.get('[data-testid="notification-source-mode"]').text())).toEqual([
      'Trusted',
      'Approved',
      'Muted',
    ]);
  });

  it('shows the sender of a messaging source', async () => {
    const { wrapper } = await mountSources({
      sources: [makeSource({ appName: 'Messages', sender: 'TBC', mode: 'approved' })],
    });

    expect(wrapper.text()).toContain('From TBC');
  });

  it('shows an empty state before the first notification', async () => {
    const { wrapper } = await mountSources({ sources: [] });

    expect(wrapper.get('[data-testid="notification-sources-empty"]').text()).toContain('No sources yet');
  });

  it('mutes a source that is trusted or approved, and refreshes the request lists', async () => {
    const { wrapper, invalidate } = await mountSources({ sources: [makeSource()] });

    await wrapper.get('[data-testid="notification-source-mute"]').trigger('click');
    await flushPromises();

    expect(mockUpdate).toHaveBeenCalledWith({ id: 'source-1', mode: 'muted' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.notificationSources });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.cardPaymentRequests });
  });

  it('approves a muted source instead of offering to mute it', async () => {
    const { wrapper } = await mountSources({ sources: [makeSource({ mode: 'muted' })] });

    expect(wrapper.find('[data-testid="notification-source-mute"]').exists()).toBe(false);

    await wrapper.get('[data-testid="notification-source-approve"]').trigger('click');
    await flushPromises();

    expect(mockUpdate).toHaveBeenCalledWith({ id: 'source-1', mode: 'approved' });
  });

  it('forgets a source only after a confirmation', async () => {
    const { wrapper } = await mountSources({ sources: [makeSource()] });

    await wrapper.get('[data-testid="notification-source-forget"]').trigger('click');
    expect(mockDelete).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="alert-dialog"]').text()).toContain('TBC Bank counts as a new source');

    await wrapper.get('[data-testid="alert-confirm"]').trigger('click');
    await flushPromises();

    expect(mockDelete).toHaveBeenCalledWith({ id: 'source-1' });
    expect(wrapper.find('[data-testid="alert-dialog"]').exists()).toBe(false);
  });

  it('keeps the source when the confirmation is cancelled', async () => {
    const { wrapper } = await mountSources({ sources: [makeSource()] });

    await wrapper.get('[data-testid="notification-source-forget"]').trigger('click');
    await wrapper.get('[data-testid="alert-cancel"]').trigger('click');

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('reports a failure to load the sources', async () => {
    mockGet.mockRejectedValue(new Error('offline'));
    const { plugins } = createGlobalPlugins();
    const wrapper = mount(NotificationSources, { global: { plugins } });
    await flushPromises();

    expect(wrapper.get('[data-testid="notification-sources-error"]').text()).toContain('Could not load');
  });
});
