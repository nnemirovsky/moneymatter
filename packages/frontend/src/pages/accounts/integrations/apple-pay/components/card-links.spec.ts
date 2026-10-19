import type { CardMappingDto, RecordId } from '@bt/shared/types';
import { type VueWrapper, flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { createGlobalPlugins } from '../test-support';
import CardLinks from './card-links.vue';

const { mockGetMappings, mockDeleteMapping, mockAccountsStore } = vi.hoisted(() => ({
  mockGetMappings: vi.fn(),
  mockDeleteMapping: vi.fn(),
  mockAccountsStore: { accountsRecord: {} as Record<string, { name: string }> },
}));

vi.mock('@/api/ingest', () => ({ getCardMappings: mockGetMappings, deleteCardMapping: mockDeleteMapping }));
vi.mock('@/stores/accounts', () => ({ useAccountsStore: () => mockAccountsStore }));
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

/** Records how the page drives the dialog: open state and which link it edits. */
const CardLinkDialogStub = defineComponent({
  name: 'CardLinkDialogStub',
  props: { open: { type: Boolean, default: false }, mapping: { type: Object, default: null } },
  setup: (props) => () =>
    h('div', {
      'data-testid': 'link-dialog',
      'data-open': String(props.open),
      'data-mapping-id': (props.mapping as CardMappingDto | null)?.id ?? '',
    }),
});

const makeMapping = (overrides: Partial<CardMappingDto> = {}): CardMappingDto => ({
  id: 'mapping-1' as RecordId,
  cardLabel: 'TBC Visa',
  accountId: 'account-1' as RecordId,
  createdAt: '2026-10-10T09:00:00.000Z',
  ...overrides,
});

const mountCardLinks = async (mappings: CardMappingDto[]) => {
  mockGetMappings.mockResolvedValue(mappings);
  const wrapper = mount(CardLinks, {
    global: { plugins: createGlobalPlugins().plugins, stubs: { CardLinkDialog: CardLinkDialogStub } },
  });
  await flushPromises();
  return wrapper;
};

const rows = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="card-link-row"]');
const dialog = (wrapper: VueWrapper) => wrapper.get('[data-testid="link-dialog"]');

describe('CardLinks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccountsStore.accountsRecord = { 'account-1': { name: 'TBC main' }, 'account-2': { name: 'Cash GEL' } };
    mockDeleteMapping.mockResolvedValue({ success: true });
  });

  it('lists each card with the account it is linked to', async () => {
    const wrapper = await mountCardLinks([
      makeMapping(),
      makeMapping({ id: 'mapping-2' as RecordId, cardLabel: 'Revolut', accountId: 'account-2' as RecordId }),
    ]);

    expect(rows(wrapper)).toHaveLength(2);
    expect(rows(wrapper)[0]!.get('[data-testid="card-link-label-text"]').text()).toBe('TBC Visa');
    expect(rows(wrapper)[0]!.get('[data-testid="card-link-account-name"]').text()).toBe('TBC main');
    expect(rows(wrapper)[1]!.get('[data-testid="card-link-account-name"]').text()).toBe('Cash GEL');
  });

  it('says so when the linked account is gone', async () => {
    const wrapper = await mountCardLinks([makeMapping({ accountId: 'missing' as RecordId })]);

    expect(rows(wrapper)[0]!.get('[data-testid="card-link-account-name"]').text()).toBe('Account no longer available');
  });

  it('shows an empty state before any card is linked', async () => {
    const wrapper = await mountCardLinks([]);

    expect(wrapper.find('[data-testid="card-links-empty"]').exists()).toBe(true);
    expect(rows(wrapper)).toHaveLength(0);
  });

  it('shows an error when the links cannot be loaded', async () => {
    mockGetMappings.mockRejectedValue(new Error('boom'));
    const wrapper = mount(CardLinks, {
      global: { plugins: createGlobalPlugins().plugins, stubs: { CardLinkDialog: CardLinkDialogStub } },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="card-links-error"]').exists()).toBe(true);
  });

  it('opens an empty dialog to add a link', async () => {
    const wrapper = await mountCardLinks([makeMapping()]);

    await wrapper.get('[data-testid="card-link-add"]').trigger('click');

    expect(dialog(wrapper).attributes('data-open')).toBe('true');
    expect(dialog(wrapper).attributes('data-mapping-id')).toBe('');
  });

  it('opens the dialog on the link being edited', async () => {
    const wrapper = await mountCardLinks([makeMapping()]);

    await wrapper.get('[data-testid="card-link-edit"]').trigger('click');

    expect(dialog(wrapper).attributes('data-open')).toBe('true');
    expect(dialog(wrapper).attributes('data-mapping-id')).toBe('mapping-1');
  });

  it('deletes a link only after a confirmation', async () => {
    const wrapper = await mountCardLinks([makeMapping()]);

    await wrapper.get('[data-testid="card-link-delete"]').trigger('click');
    expect(mockDeleteMapping).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="alert-dialog"]').text()).toContain('Payments from TBC Visa will wait');

    await wrapper.get('[data-testid="alert-confirm"]').trigger('click');
    await flushPromises();

    expect(mockDeleteMapping).toHaveBeenCalledWith({ id: 'mapping-1' });
    expect(wrapper.find('[data-testid="alert-dialog"]').exists()).toBe(false);
  });

  it('keeps the link when the confirmation is cancelled', async () => {
    const wrapper = await mountCardLinks([makeMapping()]);

    await wrapper.get('[data-testid="card-link-delete"]').trigger('click');
    await wrapper.get('[data-testid="alert-cancel"]').trigger('click');

    expect(mockDeleteMapping).not.toHaveBeenCalled();
  });
});
