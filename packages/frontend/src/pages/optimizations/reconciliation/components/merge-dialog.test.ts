import { ApiErrorResponseError } from '@/js/errors';
import { API_ERROR_CODES, type RecordId } from '@bt/shared/types';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';

import { useReconciliationActions } from '../use-reconciliation';
import MergeDialog from './merge-dialog.vue';
import { buildId, buildTransaction, createReconciliationI18n } from './test-fixtures';

vi.mock('../use-reconciliation', () => ({ useReconciliationActions: vi.fn() }));
vi.mock('@/composable/data-queries/payees', () => ({ usePayeeLookup: () => ({ byId: ref(new Map()) }) }));
vi.mock('@/composable/use-date-locale', () => ({ useDateLocale: () => ({ format: () => '18:40' }) }));

const mutate = vi.fn();

// Renders the slots while open, like the real dialog does.
const DialogStub = defineComponent({
  props: ['open'],
  setup:
    (props, { slots }) =>
    () =>
      props.open ? h('div', { 'data-testid': 'dialog' }, [slots.default?.(), slots.footer?.()]) : null,
});
const RecordStub = { props: ['tx'], template: '<div :data-id="tx.id" />' };
const RadioGroupStub = defineComponent({
  props: ['modelValue'],
  setup:
    (props, { slots }) =>
    () =>
      h('div', { 'data-testid': 'group', 'data-value': String(props.modelValue) }, slots.default?.()),
});

const TRANSACTIONS = [buildTransaction({ id: buildId('tx-a') }), buildTransaction({ id: buildId('tx-b') })];

const mountDialog = async ({ defaultSurvivorId }: { defaultSurvivorId?: RecordId } = {}) => {
  const wrapper = mount(MergeDialog, {
    props: { open: false, transactions: TRANSACTIONS, defaultSurvivorId },
    global: {
      plugins: [createReconciliationI18n()],
      stubs: {
        ResponsiveDialog: DialogStub,
        RadioGroup: RadioGroupStub,
        RadioGroupItem: true,
        TransactionRecord: RecordStub,
      },
    },
  });
  await wrapper.setProps({ open: true });
  await nextTick();
  return wrapper;
};

describe('MergeDialog', () => {
  beforeEach(() => {
    mutate.mockReset();
    vi.mocked(useReconciliationActions).mockReturnValue({
      merge: { mutate, isPending: ref(false) },
    } as unknown as ReturnType<typeof useReconciliationActions>);
  });

  it('preselects the survivor the suggestion names', async () => {
    const wrapper = await mountDialog({ defaultSurvivorId: buildId('tx-b') });

    expect(wrapper.find('[data-testid="group"]').attributes('data-value')).toBe('tx-b');
  });

  it('starts without a choice when none is suggested', async () => {
    const wrapper = await mountDialog();

    expect(wrapper.find('[data-testid="group"]').attributes('data-value')).toBe('null');
  });

  it('merges into the preselected survivor', async () => {
    const wrapper = await mountDialog({ defaultSurvivorId: buildId('tx-b') });

    const confirm = wrapper.findAll('button').at(-1)!;
    await confirm.trigger('click');

    expect(mutate).toHaveBeenCalledWith(
      { transactionIds: ['tx-a', 'tx-b'], survivorId: 'tx-b' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('shows the reason when the server refuses the merge over an edit both rows carry', async () => {
    const wrapper = await mountDialog({ defaultSurvivorId: buildId('tx-b') });
    await wrapper.findAll('button').at(-1)!.trigger('click');

    const { onError } = mutate.mock.calls[0]![1] as { onError: (error: unknown) => void };
    onError(
      new ApiErrorResponseError('refused', {
        code: API_ERROR_CODES.validationError,
        message: 'Both transactions have a different note that you wrote. Keep one note, then merge.',
      }),
    );
    await flushPromises();

    expect(wrapper.find('[data-testid="merge-error"]').text()).toContain('Keep one note, then merge.');
  });

  it('clears the reason when the dialog opens again', async () => {
    const wrapper = await mountDialog({ defaultSurvivorId: buildId('tx-b') });
    await wrapper.findAll('button').at(-1)!.trigger('click');
    const { onError } = mutate.mock.calls[0]![1] as { onError: (error: unknown) => void };
    onError(
      new ApiErrorResponseError('refused', { code: API_ERROR_CODES.validationError, message: 'Align the payees.' }),
    );
    await flushPromises();
    expect(wrapper.find('[data-testid="merge-error"]').exists()).toBe(true);

    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });

    expect(wrapper.find('[data-testid="merge-error"]').exists()).toBe(false);
  });
});
