import { VUE_QUERY_GLOBAL_PREFIXES } from '@/common/const/vue-query';
import type { RecordId, UnconfirmedCardPaymentDto } from '@bt/shared/types';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createGlobalPlugins } from '../test-support';
import UnconfirmedPayments from './unconfirmed-payments.vue';

const { mockGetUnconfirmed, mockDeleteTransaction } = vi.hoisted(() => ({
  mockGetUnconfirmed: vi.fn(),
  mockDeleteTransaction: vi.fn(),
}));

vi.mock('@/api/ingest', () => ({ getUnconfirmedCardPayments: mockGetUnconfirmed }));
vi.mock('@/api/transactions', () => ({ deleteTransaction: mockDeleteTransaction }));
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

const makePlan = (overrides: Partial<UnconfirmedCardPaymentDto> = {}): UnconfirmedCardPaymentDto => ({
  transactionId: 'tx-1' as RecordId,
  accountId: 'account-1' as RecordId,
  amount: 47,
  currencyCode: 'GEL',
  merchant: 'Cafe Heart of Batumi',
  card: 'TBC Visa',
  time: '2026-10-05T10:00:00.000Z',
  ...overrides,
});

const mountUnconfirmed = async (plans: UnconfirmedCardPaymentDto[]) => {
  mockGetUnconfirmed.mockResolvedValue(plans);
  const { queryClient, plugins } = createGlobalPlugins();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = mount(UnconfirmedPayments, { global: { plugins } });
  await flushPromises();
  return { wrapper, invalidate };
};

describe('UnconfirmedPayments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteTransaction.mockResolvedValue(undefined);
  });

  it('lists each unconfirmed plan with its date, merchant and amount', async () => {
    const { wrapper } = await mountUnconfirmed([makePlan()]);

    const row = wrapper.get('[data-testid="unconfirmed-payment-row"]');
    expect(row.get('[data-testid="unconfirmed-payment-merchant"]').text()).toBe('Cafe Heart of Batumi');
    expect(row.get('[data-testid="unconfirmed-payment-amount"]').text()).toContain('47.00');
    expect(row.get('[data-testid="unconfirmed-payment-date"]').text()).toBe('Oct 5, 2026');
  });

  it('is hidden when no plan is unconfirmed', async () => {
    const { wrapper } = await mountUnconfirmed([]);

    expect(wrapper.find('[data-testid="unconfirmed-payments"]').exists()).toBe(false);
  });

  it('deletes the plan through the transaction endpoint after a confirmation', async () => {
    const { wrapper, invalidate } = await mountUnconfirmed([makePlan()]);

    await wrapper.get('[data-testid="unconfirmed-payment-delete"]').trigger('click');
    expect(mockDeleteTransaction).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="alert-confirm"]').trigger('click');
    await flushPromises();

    expect(mockDeleteTransaction).toHaveBeenCalledWith('tx-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [VUE_QUERY_GLOBAL_PREFIXES.transactionChange] });
  });

  it('keeps the plan when the confirmation is cancelled', async () => {
    const { wrapper } = await mountUnconfirmed([makePlan()]);

    await wrapper.get('[data-testid="unconfirmed-payment-delete"]').trigger('click');
    await wrapper.get('[data-testid="alert-cancel"]').trigger('click');

    expect(mockDeleteTransaction).not.toHaveBeenCalled();
  });
});
