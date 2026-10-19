import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import { useApplePayStatus } from './use-apple-pay-status';

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
  let status!: ReturnType<typeof useApplePayStatus>;
  mount(
    defineComponent({
      setup() {
        status = useApplePayStatus();
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

describe('useApplePayStatus', () => {
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

  it('stays not set up when the requests fail', async () => {
    mockGetMappings.mockRejectedValue(new Error('offline'));
    mockGetTokens.mockRejectedValue(new Error('offline'));

    expect((await mountStatus()).isSetUp.value).toBe(false);
  });
});
