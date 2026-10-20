import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import { useIosAutomationStatus } from './use-ios-automation-status';

const { mockGetMappings, mockGetTokens, mockGetRequests } = vi.hoisted(() => ({
  mockGetMappings: vi.fn(),
  mockGetTokens: vi.fn(),
  mockGetRequests: vi.fn(),
}));

vi.mock('@/api/ingest', () => ({
  getCardMappings: mockGetMappings,
  getIngestTokens: mockGetTokens,
  getCardPaymentRequests: mockGetRequests,
}));

const mountStatus = async () => {
  let status!: ReturnType<typeof useIosAutomationStatus>;
  mount(
    defineComponent({
      setup() {
        status = useIosAutomationStatus();
        return () => null;
      },
    }),
    {
      global: {
        plugins: [
          [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }],
        ],
      },
    },
  );
  await flushPromises();

  return status;
};

describe('useIosAutomationStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMappings.mockResolvedValue([]);
    mockGetTokens.mockResolvedValue([]);
    mockGetRequests.mockResolvedValue([]);
  });

  it('is not set up with no linked card and no device token', async () => {
    const status = await mountStatus();

    expect(status.isSetUp.value).toBe(false);
    expect(status.linkedCardsCount.value).toBe(0);
    expect(status.waitingCount.value).toBe(0);
  });

  it('is set up once a card is linked', async () => {
    mockGetMappings.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);

    const status = await mountStatus();

    expect(status.isSetUp.value).toBe(true);
    expect(status.linkedCardsCount.value).toBe(2);
  });

  it('is set up once a device token exists, even with no linked card', async () => {
    mockGetTokens.mockResolvedValue([{ id: 't1' }]);

    expect((await mountStatus()).isSetUp.value).toBe(true);
  });

  it('counts the payments that wait for the user', async () => {
    mockGetRequests.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);

    expect((await mountStatus()).waitingCount.value).toBe(3);
  });

  it('reports the newest request time as the last payment', async () => {
    mockGetMappings.mockResolvedValue([{ id: 'm1' }]);
    mockGetRequests.mockResolvedValue([
      { id: 'r1', createdAt: '2026-10-19T09:00:00.000Z' },
      { id: 'r2', createdAt: '2026-10-19T12:30:00.000Z' },
      { id: 'r3', createdAt: '2026-10-18T23:00:00.000Z' },
    ]);

    expect((await mountStatus()).lastPaymentAt.value).toBe('2026-10-19T12:30:00.000Z');
  });

  it('has no last payment before any request, and reads no log before Apple Pay is set up', async () => {
    const status = await mountStatus();

    expect(status.lastPaymentAt.value).toBeNull();
    // The parked view is always read; the recent view only once Apple Pay is set up.
    expect(mockGetRequests).toHaveBeenCalledTimes(1);
    expect(mockGetRequests).toHaveBeenCalledWith({ status: 'parked' });
  });

  it('stays not set up when the requests fail', async () => {
    mockGetMappings.mockRejectedValue(new Error('offline'));
    mockGetTokens.mockRejectedValue(new Error('offline'));

    expect((await mountStatus()).isSetUp.value).toBe(false);
  });
});
