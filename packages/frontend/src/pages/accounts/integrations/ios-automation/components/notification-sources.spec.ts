import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import {
  ACCOUNT_CATEGORIES,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  type AccountModel,
  type NotificationSourceDto,
  type RecordId,
} from '@bt/shared/types';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { createGlobalPlugins } from '../test-support';
import NotificationSources from './notification-sources.vue';

const { mockGet, mockUpdate, mockDelete, mockCreate, mockAccountsStore } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
  mockAccountsStore: { accounts: [] as unknown[] },
}));

vi.mock('@/stores/accounts', () => ({ useAccountsStore: () => mockAccountsStore }));

vi.mock('@/api/ingest', () => ({
  getNotificationSources: mockGet,
  updateNotificationSource: mockUpdate,
  deleteNotificationSource: mockDelete,
  createContextSource: mockCreate,
}));
vi.mock('@/components/notification-center', () => ({
  NotificationType: { error: 'error' },
  useNotificationCenter: () => ({
    addSuccessNotification: vi.fn(),
    addErrorNotification: vi.fn(),
    addNotification: vi.fn(),
  }),
}));
// The real picker is a popover list; here only the account it shows and the one it reports matter.
vi.mock('@/components/fields/account-select-field.vue', () => ({
  default: defineComponent({
    name: 'AccountSelectFieldStub',
    props: {
      modelValue: { type: Object, default: null },
      accounts: { type: Array, default: () => [] },
      noneLabel: { type: String, default: '' },
      clearable: { type: Boolean, default: false },
    },
    emits: ['update:modelValue'],
    setup:
      (props, { emit }) =>
      () =>
        h('div', { 'data-testid': 'account-select' }, [
          h('span', { 'data-testid': 'account-select-value' }, (props.modelValue as AccountModel | null)?.name ?? ''),
          h('span', { 'data-testid': 'account-select-count' }, String(props.accounts.length)),
          h('span', { 'data-testid': 'account-select-none' }, props.noneLabel),
          h('span', { 'data-testid': 'account-select-clearable' }, String(props.clearable)),
          ...(props.accounts as AccountModel[]).map((account) =>
            h('button', { 'data-testid': `pick-${account.id}`, onClick: () => emit('update:modelValue', account) }),
          ),
          h('button', { 'data-testid': 'clear-account', onClick: () => emit('update:modelValue', null) }),
        ]),
  }),
}));
vi.mock('@/components/common/responsive-alert-dialog.vue', async () => ({
  default: (await import('../test-support')).createResponsiveAlertDialogStub(),
}));

const makeAccount = (overrides: Partial<AccountModel>): AccountModel =>
  ({
    id: 'account-1' as RecordId,
    name: 'Raiffeisen',
    type: ACCOUNT_TYPES.system,
    status: ACCOUNT_STATUSES.active,
    accountCategory: ACCOUNT_CATEGORIES.general,
    currencyCode: 'RUB',
    ...overrides,
  }) as AccountModel;

const RAIFFEISEN = makeAccount({});
const LOAN = makeAccount({ id: 'loan' as RecordId, name: 'Car loan', accountCategory: ACCOUNT_CATEGORIES.loan });

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
    mockAccountsStore.accounts = [RAIFFEISEN, LOAN];
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
      'Known',
      'Approved',
      'Muted',
    ]);
  });

  describe('context sources', () => {
    it('badges a context source and says what it does', async () => {
      const { wrapper } = await mountSources({ sources: [makeSource({ appName: 'Wolt', mode: 'context' })] });

      expect(wrapper.get('[data-testid="notification-source-mode"]').text()).toBe('Context');
      expect(wrapper.get('[data-testid="notification-source-context-hint"]').text()).toContain(
        'never create a payment',
      );
      expect(wrapper.find('[data-testid="notification-source-context"]').exists()).toBe(false);
    });

    it('switches an app to context', async () => {
      const { wrapper } = await mountSources({ sources: [makeSource({ appName: 'Foodora', mode: 'approved' })] });

      await wrapper.get('[data-testid="notification-source-context"]').trigger('click');
      await flushPromises();

      expect(mockUpdate).toHaveBeenCalledWith({ id: 'source-1', mode: 'context' });
    });

    it('offers the context choice for a messaging sender but not for a muted source', async () => {
      const { wrapper } = await mountSources({
        sources: [
          makeSource({ conversational: true, sender: 'Госуслуги', mode: 'approved' }),
          makeSource({ id: 'muted' as RecordId, mode: 'muted' }),
        ],
      });

      expect(wrapper.findAll('[data-testid="notification-source-context"]')).toHaveLength(1);
    });

    it('adds a context source by name, with the sender of a mail app', async () => {
      mockCreate.mockResolvedValue(makeSource({ mode: 'context' }));
      const { wrapper, invalidate } = await mountSources({ sources: [] });

      await wrapper.get('[data-testid="add-context-app"] input, input[data-testid="add-context-app"]').setValue('Mail');
      await wrapper
        .get('[data-testid="add-context-sender"] input, input[data-testid="add-context-sender"]')
        .setValue('Госуслуги');
      await wrapper.get('[data-testid="add-context-source"]').trigger('submit');
      await flushPromises();

      expect(mockCreate).toHaveBeenCalledWith({ appName: 'Mail', sender: 'Госуслуги' });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.notificationSources });
    });

    it('does not add a source without a name', async () => {
      const { wrapper } = await mountSources({ sources: [] });

      await wrapper.get('[data-testid="add-context-source"]').trigger('submit');
      await flushPromises();

      expect(mockCreate).not.toHaveBeenCalled();
    });
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

  describe('the account a source logs to', () => {
    it('shows the current default and offers only accounts that take a manual payment', async () => {
      const { wrapper } = await mountSources({ sources: [makeSource({ defaultAccountId: RAIFFEISEN.id })] });

      expect(wrapper.get('[data-testid="account-select-value"]').text()).toBe('Raiffeisen');
      expect(wrapper.get('[data-testid="account-select-count"]').text()).toBe('1');
    });

    it('saves the chosen account as the default and refreshes the sources', async () => {
      const { wrapper, invalidate } = await mountSources({ sources: [makeSource()] });

      await wrapper.get(`[data-testid="pick-${RAIFFEISEN.id}"]`).trigger('click');
      await flushPromises();

      expect(mockUpdate).toHaveBeenCalledWith({ id: 'source-1', defaultAccountId: RAIFFEISEN.id });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.notificationSources });
    });

    it('offers "Ask me each time" as the option for no account, and the clear button only while one is set', async () => {
      const { wrapper } = await mountSources({
        sources: [makeSource({ defaultAccountId: RAIFFEISEN.id }), makeSource({ id: 'other' as RecordId })],
      });

      const picks = wrapper.findAll('[data-testid="account-select"]');
      expect(picks.map((pick) => pick.get('[data-testid="account-select-none"]').text())).toEqual([
        'Ask me each time',
        'Ask me each time',
      ]);
      expect(picks.map((pick) => pick.get('[data-testid="account-select-clearable"]').text())).toEqual([
        'true',
        'false',
      ]);
    });

    it('clears the default when the choice is cleared', async () => {
      const { wrapper } = await mountSources({ sources: [makeSource({ defaultAccountId: RAIFFEISEN.id })] });

      await wrapper.get('[data-testid="clear-account"]').trigger('click');
      await flushPromises();

      expect(mockUpdate).toHaveBeenCalledWith({ id: 'source-1', defaultAccountId: null });
    });

    it('does not save when the choice is the account it already has', async () => {
      const { wrapper } = await mountSources({ sources: [makeSource({ defaultAccountId: RAIFFEISEN.id })] });

      await wrapper.get(`[data-testid="pick-${RAIFFEISEN.id}"]`).trigger('click');
      await flushPromises();

      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
