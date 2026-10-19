import { VUE_QUERY_CACHE_KEYS, VUE_QUERY_GLOBAL_PREFIXES } from '@/common/const/vue-query';
import type { CardPaymentRequestDto, RecordId } from '@bt/shared/types';
import { type VueWrapper, flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createGlobalPlugins } from '../test-support';
import WaitingPayments from './waiting-payments.vue';

const { mockGetRequests, mockRetry, mockDismiss, mockAddWarning, mockAddSuccess } = vi.hoisted(() => ({
  mockGetRequests: vi.fn(),
  mockRetry: vi.fn(),
  mockDismiss: vi.fn(),
  mockAddWarning: vi.fn(),
  mockAddSuccess: vi.fn(),
}));

vi.mock('@/api/ingest', () => ({
  getCardPaymentRequests: mockGetRequests,
  retryCardPaymentRequest: mockRetry,
  dismissCardPaymentRequest: mockDismiss,
}));
vi.mock('@/components/notification-center', () => ({
  NotificationType: { error: 'error' },
  useNotificationCenter: () => ({
    addSuccessNotification: mockAddSuccess,
    addWarningNotification: mockAddWarning,
    addErrorNotification: vi.fn(),
    addNotification: vi.fn(),
  }),
}));
vi.mock('@/components/common/responsive-alert-dialog.vue', async () => ({
  default: (await import('../test-support')).createResponsiveAlertDialogStub(),
}));

const makeRequest = (overrides: Partial<CardPaymentRequestDto> = {}): CardPaymentRequestDto => ({
  id: 'request-1' as RecordId,
  status: 'parked',
  reason: 'unknownCard',
  summary: null,
  cardLabel: 'TBC Visa',
  merchant: 'Cafe Heart of Batumi',
  amountText: '47,00 GEL',
  time: '2026-10-18T10:00:00.000Z',
  transactionId: null,
  createdAt: '2026-10-18T10:00:00.000Z',
  ...overrides,
});

const LOGGED = { outcome: 'logged', summary: 'Logged', transactionId: 't1', planned: false, categoryPending: false };
const PARKED = {
  outcome: 'parked',
  reason: 'rateUnavailable',
  summary: 'Not logged yet: no EUR→GEL rate',
  requestId: 'r',
};

const mountWaiting = async ({
  waiting,
  recent = [],
}: {
  waiting: CardPaymentRequestDto[];
  recent?: CardPaymentRequestDto[];
}) => {
  mockGetRequests.mockImplementation(async ({ status }: { status: string }) =>
    status === 'parked' ? waiting : recent,
  );
  const { queryClient, plugins } = createGlobalPlugins();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = mount(WaitingPayments, { global: { plugins } });
  await flushPromises();
  return { wrapper, invalidate };
};

const rows = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="waiting-payment-row"]');

describe('WaitingPayments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRetry.mockResolvedValue(LOGGED);
    mockDismiss.mockResolvedValue({ success: true });
  });

  it('lists each waiting payment with merchant, amount, card, time and the reason', async () => {
    const { wrapper } = await mountWaiting({ waiting: [makeRequest()] });

    const row = rows(wrapper)[0]!;
    expect(row.get('[data-testid="payment-request-merchant"]').text()).toBe('Cafe Heart of Batumi');
    expect(row.get('[data-testid="payment-request-amount"]').text()).toBe('47,00 GEL');
    expect(row.get('[data-testid="payment-request-card"]').text()).toBe('TBC Visa');
    expect(row.get('[data-testid="payment-request-time"]').text()).toContain('2026');
    expect(row.get('[data-testid="payment-request-reason"]').text()).toBe('The card is not linked to an account.');
  });

  it('lists an interrupted payment like any other', async () => {
    const { wrapper } = await mountWaiting({ waiting: [makeRequest({ status: 'received', reason: 'interrupted' })] });

    expect(rows(wrapper)).toHaveLength(1);
    expect(rows(wrapper)[0]!.get('[data-testid="payment-request-reason"]').text()).toBe(
      'Processing was interrupted before it finished.',
    );
  });

  it('fills in a payment that came through without a merchant or amount', async () => {
    const { wrapper } = await mountWaiting({ waiting: [makeRequest({ merchant: null, amountText: null })] });

    expect(rows(wrapper)[0]!.get('[data-testid="payment-request-merchant"]').text()).toBe('No merchant');
    expect(rows(wrapper)[0]!.get('[data-testid="payment-request-amount"]').text()).toBe('No amount');
  });

  it('shows an empty state when nothing waits', async () => {
    const { wrapper } = await mountWaiting({ waiting: [] });

    expect(wrapper.find('[data-testid="waiting-payments-empty"]').exists()).toBe(true);
  });

  describe('retry', () => {
    it('retries the payment and refreshes the lists and everything a new transaction touches', async () => {
      const { wrapper, invalidate } = await mountWaiting({ waiting: [makeRequest()] });

      await wrapper.get('[data-testid="waiting-payment-retry"]').trigger('click');
      await flushPromises();

      expect(mockRetry).toHaveBeenCalledWith({ id: 'request-1' });
      expect(mockAddSuccess).toHaveBeenCalledWith('Payment logged');
      expect(invalidate).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.cardPaymentRequests });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.unlinkedCards });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [VUE_QUERY_GLOBAL_PREFIXES.transactionChange] });
    });

    it('warns with the server summary when the payment is still waiting', async () => {
      mockRetry.mockResolvedValue(PARKED);
      const { wrapper } = await mountWaiting({ waiting: [makeRequest()] });

      await wrapper.get('[data-testid="waiting-payment-retry"]').trigger('click');
      await flushPromises();

      expect(mockAddWarning).toHaveBeenCalledWith('Still waiting: Not logged yet: no EUR→GEL rate');
      expect(mockAddSuccess).not.toHaveBeenCalled();
    });
  });

  describe('dismiss', () => {
    it('dismisses a payment only after a confirmation', async () => {
      const { wrapper, invalidate } = await mountWaiting({ waiting: [makeRequest()] });

      await wrapper.get('[data-testid="waiting-payment-dismiss"]').trigger('click');
      expect(mockDismiss).not.toHaveBeenCalled();
      expect(wrapper.get('[data-testid="alert-dialog"]').text()).toContain(
        'The payment at Cafe Heart of Batumi will not be logged.',
      );

      await wrapper.get('[data-testid="alert-confirm"]').trigger('click');
      await flushPromises();

      expect(mockDismiss).toHaveBeenCalledWith({ id: 'request-1' });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.cardPaymentRequests });
      expect(wrapper.find('[data-testid="alert-dialog"]').exists()).toBe(false);
    });

    it('keeps the payment when the confirmation is cancelled', async () => {
      const { wrapper } = await mountWaiting({ waiting: [makeRequest()] });

      await wrapper.get('[data-testid="waiting-payment-dismiss"]').trigger('click');
      await wrapper.get('[data-testid="alert-cancel"]').trigger('click');

      expect(mockDismiss).not.toHaveBeenCalled();
    });
  });

  describe('recent payments', () => {
    const RECENT = [
      makeRequest({ id: 'r1' as RecordId, status: 'logged', reason: null }),
      makeRequest({ id: 'r2' as RecordId, status: 'rejected', reason: 'zeroAmount', amountText: '0', merchant: null }),
    ];

    it('loads them only when asked', async () => {
      const { wrapper } = await mountWaiting({ waiting: [], recent: RECENT });
      expect(mockGetRequests).not.toHaveBeenCalledWith({ status: 'recent' });
      expect(wrapper.find('[data-testid="recent-payments"]').exists()).toBe(false);

      await wrapper.get('[data-testid="recent-payments-toggle"]').trigger('click');
      await flushPromises();

      expect(mockGetRequests).toHaveBeenCalledWith({ status: 'recent' });
      const items = wrapper.findAll('[data-testid="recent-payment-row"]');
      expect(items).toHaveLength(2);
      expect(items[0]!.text()).toContain('Logged');
      expect(items[1]!.text()).toContain('Refused');
      expect(items[1]!.text()).toContain('iOS sent no amount or merchant for this payment.');
    });

    it('offers no retry or dismiss on a recent payment', async () => {
      const { wrapper } = await mountWaiting({ waiting: [], recent: RECENT });

      await wrapper.get('[data-testid="recent-payments-toggle"]').trigger('click');
      await flushPromises();

      expect(wrapper.find('[data-testid="recent-payment-row"] [data-testid="waiting-payment-retry"]').exists()).toBe(
        false,
      );
    });
  });
});
