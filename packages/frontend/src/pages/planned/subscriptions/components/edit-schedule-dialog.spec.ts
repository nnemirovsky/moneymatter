import type { SubscriptionDetail } from '@/api/subscriptions';
import { SUBSCRIPTION_PERIOD_STATUSES, SUBSCRIPTION_TYPES } from '@bt/shared/types';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createI18n } from 'vue-i18n';

import { buildSubscription } from '../subscription-fixtures';
import EditScheduleDialog from './edit-schedule-dialog.vue';

const mutate = vi.fn();

vi.mock('@tanstack/vue-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/vue-query')>()),
  useMutation: () => ({ mutate, isPending: false }),
}));
vi.mock('@/composable/data-queries/subscriptions', () => ({ useInvalidateSubscriptionQueries: () => vi.fn() }));
vi.mock('@/components/notification-center', () => ({
  useNotificationCenter: () => ({ addSuccessNotification: vi.fn() }),
}));

const period = ({ dueDate, status }: { dueDate: string; status: SUBSCRIPTION_PERIOD_STATUSES }) =>
  ({ dueDate, status }) as SubscriptionDetail['periods'][number];

const buildDetail = (overrides: Partial<SubscriptionDetail> = {}): SubscriptionDetail =>
  ({
    ...buildSubscription({ dueDate: '2026-11-02', anchorDay: 2, startDate: '2026-11-02' }),
    tagIds: [],
    nextExpectedDate: '2026-11-15',
    periods: [
      period({ dueDate: '2026-11-02', status: SUBSCRIPTION_PERIOD_STATUSES.paid }),
      period({ dueDate: '2026-11-15', status: SUBSCRIPTION_PERIOD_STATUSES.upcoming }),
    ],
    ...overrides,
  }) as SubscriptionDetail;

const DUE_DATE_LABEL = 'planned.subscriptions.form.dueDateLabel';

const mountDialog = ({ subscription = buildDetail() }: { subscription?: SubscriptionDetail } = {}) =>
  mount(EditScheduleDialog, {
    props: { subscription, open: true },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: {} })],
      stubs: {
        ResponsiveDialog: { template: '<div><slot /><slot name="footer" /></div>' },
        DateField: {
          name: 'DateField',
          props: ['modelValue', 'label'],
          emits: ['update:modelValue'],
          template: '<div />',
        },
        SelectField: true,
        InputField: true,
        Switch: true,
      },
    },
  });

const dueDateField = ({ wrapper }: { wrapper: ReturnType<typeof mountDialog> }) =>
  wrapper.findAllComponents({ name: 'DateField' }).find((field) => field.props('label') === DUE_DATE_LABEL)!;

const submit = async ({ wrapper }: { wrapper: ReturnType<typeof mountDialog> }) => {
  await wrapper.find('form').trigger('submit');
  await nextTick();
  return mutate.mock.calls[0]![0] as Record<string, unknown>;
};

const pick = async ({ wrapper, date }: { wrapper: ReturnType<typeof mountDialog>; date: Date | null }) => {
  dueDateField({ wrapper }).vm.$emit('update:modelValue', date);
  await nextTick();
};

const shownDueDate = ({ wrapper }: { wrapper: ReturnType<typeof mountDialog> }) =>
  dueDateField({ wrapper }).props('modelValue');

describe('EditScheduleDialog', () => {
  beforeEach(() => {
    mutate.mockReset();
  });

  describe('due date prefill', () => {
    it('shows the open period, not the anchor it has moved on from', () => {
      expect(shownDueDate({ wrapper: mountDialog() })).toEqual(new Date(2026, 10, 15));
    });

    it('shows the open period of a paused subscription, which has no next expected date', () => {
      const wrapper = mountDialog({ subscription: buildDetail({ isActive: false, nextExpectedDate: null }) });

      expect(shownDueDate({ wrapper })).toEqual(new Date(2026, 10, 15));
    });

    it('falls back to the anchor when no period is open', () => {
      const wrapper = mountDialog({
        subscription: buildDetail({
          nextExpectedDate: null,
          periods: [period({ dueDate: '2026-11-02', status: SUBSCRIPTION_PERIOD_STATUSES.paid })],
        }),
      });

      expect(shownDueDate({ wrapper })).toEqual(new Date(2026, 10, 2));
    });

    it('stays empty on a detection-only subscription, whose next expected date is an estimate', () => {
      const wrapper = mountDialog({
        subscription: buildDetail({ dueDate: null, anchorDay: null, periods: [], nextExpectedDate: '2026-12-01' }),
      });

      expect(shownDueDate({ wrapper })).toBeUndefined();
    });
  });

  describe('due date payload', () => {
    it('sends no due date and no flag when the field was not edited', async () => {
      const payload = await submit({ wrapper: mountDialog() });

      expect(payload).not.toHaveProperty('dueDate');
      expect(payload).not.toHaveProperty('rescheduleOpenPeriod');
    });

    it('sends nothing when the field is edited and then set back', async () => {
      const wrapper = mountDialog();
      await pick({ wrapper, date: new Date(2026, 10, 20) });
      await pick({ wrapper, date: new Date(2026, 10, 15) });

      const payload = await submit({ wrapper });

      expect(payload).not.toHaveProperty('dueDate');
      expect(payload).not.toHaveProperty('rescheduleOpenPeriod');
    });

    it('sends the date with the flag when the user picks another one, even the stored anchor', async () => {
      const wrapper = mountDialog();
      await pick({ wrapper, date: new Date(2026, 10, 2) });

      const payload = await submit({ wrapper });

      expect(payload).toMatchObject({ dueDate: '2026-11-02', rescheduleOpenPeriod: true });
    });

    it('sends null without the flag when the schedule is cleared', async () => {
      const wrapper = mountDialog();
      await pick({ wrapper, date: null });

      const payload = await submit({ wrapper });

      expect(payload.dueDate).toBeNull();
      expect(payload).not.toHaveProperty('rescheduleOpenPeriod');
    });

    it('leaves a detection-only subscription unscheduled when the field stays empty', async () => {
      const wrapper = mountDialog({
        subscription: buildDetail({ dueDate: null, anchorDay: null, periods: [], nextExpectedDate: '2026-12-01' }),
      });

      const payload = await submit({ wrapper });

      expect(payload).not.toHaveProperty('dueDate');
    });

    it('keeps an untouched installment date out of the payload while validating it as present', async () => {
      const wrapper = mountDialog({
        subscription: buildDetail({ type: SUBSCRIPTION_TYPES.installment, maxOccurrences: 3 }),
      });

      const payload = await submit({ wrapper });

      expect(payload).not.toHaveProperty('dueDate');
      expect(payload.maxOccurrences).toBe(3);
    });
  });
});
