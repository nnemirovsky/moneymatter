import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import type { NotificationSourceDto, RecordId } from '@bt/shared/types';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createGlobalPlugins } from '../test-support';
import PendingSources from './pending-sources.vue';

const { mockGet, mockUpdate } = vi.hoisted(() => ({ mockGet: vi.fn(), mockUpdate: vi.fn() }));

vi.mock('@/api/ingest', () => ({ getNotificationSources: mockGet, updateNotificationSource: mockUpdate }));
vi.mock('@/components/notification-center', () => ({
  NotificationType: { error: 'error' },
  useNotificationCenter: () => ({
    addSuccessNotification: vi.fn(),
    addErrorNotification: vi.fn(),
    addNotification: vi.fn(),
  }),
}));

const makeSource = (overrides: Partial<NotificationSourceDto> = {}): NotificationSourceDto => ({
  id: 'source-1' as RecordId,
  appName: 'Messages',
  bundleId: null,
  sender: 'TBC',
  conversational: true,
  mode: 'pending',
  defaultAccountId: null,
  counters: {},
  lastSeenAt: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  ...overrides,
});

const mountPending = async ({ sources }: { sources: NotificationSourceDto[] }) => {
  mockGet.mockResolvedValue(sources);
  const { plugins, queryClient } = createGlobalPlugins();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = mount(PendingSources, { global: { plugins } });
  await flushPromises();
  return { wrapper, invalidate };
};

describe('PendingSources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(makeSource({ mode: 'approved' }));
  });

  it('lists only the sources waiting for an answer, with the app and the sender', async () => {
    const { wrapper } = await mountPending({
      sources: [
        makeSource(),
        makeSource({ id: 'approved' as RecordId, appName: 'Revolut', sender: null, mode: 'approved' }),
        makeSource({ id: 'muted' as RecordId, appName: 'Telegram', mode: 'muted' }),
      ],
    });

    const rows = wrapper.findAll('[data-testid="pending-source-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.get('[data-testid="pending-source-name"]').text()).toBe('Messages');
    expect(rows[0]!.text()).toContain('From TBC');
  });

  it('names a source by its bundle id when the app has no name', async () => {
    const { wrapper } = await mountPending({ sources: [makeSource({ appName: null, bundleId: 'com.example.bank' })] });

    expect(wrapper.get('[data-testid="pending-source-name"]').text()).toBe('com.example.bank');
  });

  it('renders nothing when no source waits', async () => {
    const { wrapper } = await mountPending({ sources: [makeSource({ mode: 'auto' })] });

    expect(wrapper.find('[data-testid="pending-sources"]').exists()).toBe(false);
  });

  it('approves a source and refreshes the sources and the held requests', async () => {
    const { wrapper, invalidate } = await mountPending({ sources: [makeSource()] });

    await wrapper.get('[data-testid="pending-source-approve"]').trigger('click');
    await flushPromises();

    expect(mockUpdate).toHaveBeenCalledWith({ id: 'source-1', mode: 'approved' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.notificationSources });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.cardPaymentRequests });
  });

  it('mutes a source', async () => {
    const { wrapper } = await mountPending({ sources: [makeSource()] });

    await wrapper.get('[data-testid="pending-source-mute"]').trigger('click');
    await flushPromises();

    expect(mockUpdate).toHaveBeenCalledWith({ id: 'source-1', mode: 'muted' });
  });

  it('survives a failed update and keeps the source listed', async () => {
    mockUpdate.mockRejectedValue(new Error('offline'));
    const { wrapper } = await mountPending({ sources: [makeSource()] });

    await wrapper.get('[data-testid="pending-source-approve"]').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('[data-testid="pending-source-row"]')).toHaveLength(1);
  });

  it('reports a failure to load the sources', async () => {
    mockGet.mockRejectedValue(new Error('offline'));
    const { plugins } = createGlobalPlugins();
    const wrapper = mount(PendingSources, { global: { plugins } });
    await flushPromises();

    expect(wrapper.get('[data-testid="pending-sources-error"]').text()).toContain('Could not load');
  });
});
