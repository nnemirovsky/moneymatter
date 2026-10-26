import { VUE_QUERY_CACHE_KEYS, VUE_QUERY_GLOBAL_PREFIXES } from '@/common/const/vue-query';
import type { CardPaymentRequestDto, RecordId } from '@bt/shared/types';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import { useLogWaitingPayments } from './use-log-waiting-payments';

const { mockGetRequests, mockRetry, mockAddSuccess, mockAddWarning } = vi.hoisted(() => ({
  mockGetRequests: vi.fn(),
  mockRetry: vi.fn(),
  mockAddSuccess: vi.fn(),
  mockAddWarning: vi.fn(),
}));

vi.mock('@/api/ingest', () => ({
  getCardPaymentRequests: mockGetRequests,
  retryCardPaymentRequest: mockRetry,
}));
vi.mock('@/components/notification-center', () => ({
  useNotificationCenter: () => ({ addSuccessNotification: mockAddSuccess, addWarningNotification: mockAddWarning }),
}));
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}` }),
}));

const makeRequest = (overrides: Partial<CardPaymentRequestDto>): CardPaymentRequestDto => ({
  id: 'request-1' as RecordId,
  pipeline: 'cardPayment',
  status: 'parked',
  reason: 'unknownCard',
  summary: null,
  cardLabel: 'Example Visa',
  cardLastDigits: null,
  accountGuessId: null,
  aiRetryAt: null,
  aiAlternatives: [],
  merchant: 'Cafe',
  amountText: '47,00 GEL',
  time: '2026-10-18T10:00:00.000Z',
  transactionId: null,
  createdAt: '2026-10-18T10:00:00.000Z',
  ...overrides,
});

const LOGGED = { outcome: 'logged', summary: 'Logged', transactionId: 't', planned: false, categoryPending: false };
const PARKED = { outcome: 'parked', reason: 'rateUnavailable', summary: 'Waiting', requestId: 'r' };

const mountComposable = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

  let composable!: ReturnType<typeof useLogWaitingPayments>;
  mount(
    defineComponent({
      setup() {
        composable = useLogWaitingPayments();
        return () => null;
      },
    }),
    { global: { plugins: [[VueQueryPlugin, { queryClient }]] } },
  );

  return { composable, invalidateQueries };
};

describe('useLogWaitingPayments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRetry.mockResolvedValue(LOGGED);
  });

  it('retries every waiting payment of the card, one at a time, and leaves the others', async () => {
    mockGetRequests.mockResolvedValue([
      makeRequest({ id: 'a' as RecordId }),
      makeRequest({ id: 'b' as RecordId, cardLabel: 'example visa •••• 1234' }),
      makeRequest({ id: 'other' as RecordId, cardLabel: 'Revolut' }),
      makeRequest({ id: 'rate' as RecordId, reason: 'rateUnavailable' }),
    ]);
    const { composable } = mountComposable();

    const result = await composable.logWaitingPayments({ cardLabel: 'Example Visa' });

    expect(mockGetRequests).toHaveBeenCalledWith({ status: 'parked' });
    expect(mockRetry.mock.calls).toEqual([[{ id: 'a' }], [{ id: 'b' }]]);
    expect(result).toEqual({ logged: 2, stillWaiting: 0, failed: 0 });
  });

  it('counts a payment that stays parked as still waiting, not as logged', async () => {
    mockGetRequests.mockResolvedValue([makeRequest({ id: 'a' as RecordId }), makeRequest({ id: 'b' as RecordId })]);
    mockRetry.mockResolvedValueOnce(LOGGED).mockResolvedValueOnce(PARKED);
    const { composable } = mountComposable();

    expect(await composable.logWaitingPayments({ cardLabel: 'Example Visa' })).toEqual({
      logged: 1,
      stillWaiting: 1,
      failed: 0,
    });
  });

  it('keeps going after one retry fails and counts it', async () => {
    mockGetRequests.mockResolvedValue([makeRequest({ id: 'a' as RecordId }), makeRequest({ id: 'b' as RecordId })]);
    mockRetry.mockRejectedValueOnce(new Error('409')).mockResolvedValueOnce(LOGGED);
    const { composable } = mountComposable();

    expect(await composable.logWaitingPayments({ cardLabel: 'Example Visa' })).toEqual({
      logged: 1,
      stillWaiting: 0,
      failed: 1,
    });
  });

  it('refreshes the waiting list, the unlinked cards and everything a new transaction touches', async () => {
    mockGetRequests.mockResolvedValue([makeRequest({})]);
    const { composable, invalidateQueries } = mountComposable();

    await composable.logWaitingPayments({ cardLabel: 'Example Visa' });
    await flushPromises();

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.cardPaymentRequests });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.unlinkedCards });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: [VUE_QUERY_GLOBAL_PREFIXES.transactionChange] });
  });

  it('says how many were logged', async () => {
    mockGetRequests.mockResolvedValue([makeRequest({ id: 'a' as RecordId }), makeRequest({ id: 'b' as RecordId })]);
    const { composable } = mountComposable();

    await composable.logWaitingPayments({ cardLabel: 'Example Visa' });

    expect(mockAddSuccess).toHaveBeenCalledWith('settings.integrations.iosAutomation.unlinked.logged:{"count":2}');
    expect(mockAddWarning).not.toHaveBeenCalled();
  });

  it('warns when some payments are still waiting or failed', async () => {
    mockGetRequests.mockResolvedValue([makeRequest({ id: 'a' as RecordId }), makeRequest({ id: 'b' as RecordId })]);
    mockRetry.mockResolvedValueOnce(LOGGED).mockResolvedValueOnce(PARKED);
    const { composable } = mountComposable();

    await composable.logWaitingPayments({ cardLabel: 'Example Visa' });

    expect(mockAddSuccess).toHaveBeenCalledWith('settings.integrations.iosAutomation.unlinked.logged:{"count":1}');
    expect(mockAddWarning).toHaveBeenCalledWith('settings.integrations.iosAutomation.unlinked.notLogged:{"count":1}');
  });

  it('does nothing and says nothing when no payment waits on the card', async () => {
    mockGetRequests.mockResolvedValue([]);
    const { composable } = mountComposable();

    expect(await composable.logWaitingPayments({ cardLabel: 'Example Visa' })).toEqual({
      logged: 0,
      stillWaiting: 0,
      failed: 0,
    });
    expect(mockRetry).not.toHaveBeenCalled();
    expect(mockAddSuccess).not.toHaveBeenCalled();
    expect(mockAddWarning).not.toHaveBeenCalled();
  });
});
