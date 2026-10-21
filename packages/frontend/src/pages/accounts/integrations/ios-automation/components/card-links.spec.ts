import type { CardMappingDto, RecordId } from '@bt/shared/types';
import { type VueWrapper, flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { createGlobalPlugins } from '../test-support';
import CardLinks from './card-links.vue';

const { mockGetMappings, mockDeleteMapping, mockAccountsStore } = vi.hoisted(() => ({
  mockGetMappings: vi.fn(),
  mockDeleteMapping: vi.fn(),
  mockAccountsStore: { accountsRecord: {} as Record<string, { name: string; currencyCode?: string }> },
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

/** Records how the page drives the dialog: open state, which link it edits and which card it extends. */
const CardLinkDialogStub = defineComponent({
  name: 'CardLinkDialogStub',
  props: {
    open: { type: Boolean, default: false },
    mapping: { type: Object, default: null },
    siblings: { type: Array, default: () => [] },
    lockLabel: { type: Boolean, default: false },
    initialLabel: { type: String, default: '' },
  },
  setup: (props) => () =>
    h('div', {
      'data-testid': 'link-dialog',
      'data-open': String(props.open),
      'data-mapping-id': (props.mapping as CardMappingDto | null)?.id ?? '',
      'data-siblings': (props.siblings as CardMappingDto[]).map((sibling) => sibling.id).join(','),
      'data-lock-label': String(props.lockLabel),
      'data-initial-label': props.initialLabel,
    }),
});

const makeMapping = (overrides: Partial<CardMappingDto> = {}): CardMappingDto => ({
  id: 'mapping-1' as RecordId,
  cardLabel: 'TBC Visa',
  lastDigits: null,
  currencyCode: null,
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
const accountRows = (row: ReturnType<typeof rows>[number]) => row.findAll('[data-testid="card-link-account-row"]');
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
    expect(rows(wrapper)[0]!.get('[data-testid="card-link-currency"]').text()).toBe('Default');
  });

  it("shows the currency of the default row's account next to its Default chip", async () => {
    mockAccountsStore.accountsRecord = {
      'account-1': { name: 'TBC main', currencyCode: 'GEL' },
      'account-2': { name: 'Cash USD', currencyCode: 'USD' },
    };
    const wrapper = await mountCardLinks([
      makeMapping(),
      makeMapping({ id: 'usd' as RecordId, currencyCode: 'USD', accountId: 'account-2' as RecordId }),
    ]);

    const [defaultRow, usdRow] = accountRows(rows(wrapper)[0]!);
    expect(defaultRow!.get('[data-testid="card-link-currency"]').text()).toBe('Default');
    expect(defaultRow!.get('[data-testid="card-link-default-currency"]').text()).toBe('GEL');
    expect(usdRow!.find('[data-testid="card-link-default-currency"]').exists()).toBe(false);
  });

  it('gives the Add account button and the Edit and Delete pair the same width on a wide container', async () => {
    const wrapper = await mountCardLinks([makeMapping()]);

    const width = (classes: string[]) => classes.filter((name) => name.includes('w-52'));
    const addClasses = wrapper.get('[data-testid="card-link-add-account"]').classes();
    const actionsClasses = wrapper.get('[data-testid="card-link-actions"]').classes();

    expect(width(addClasses)).toEqual(['@lg/integrations:w-52']);
    expect(width(actionsClasses)).toEqual(width(addClasses));
    // On a narrow container both fill the row, stacked under the card name.
    expect(addClasses).toContain('w-full');
    expect(actionsClasses).toContain('w-full');
  });

  describe('a card in several currencies', () => {
    const multiCurrencyCard = [
      makeMapping({ id: 'default' as RecordId, lastDigits: '1234' }),
      makeMapping({ id: 'gel' as RecordId, currencyCode: 'GEL', accountId: 'account-2' as RecordId }),
      makeMapping({ id: 'usd' as RecordId, currencyCode: 'USD', accountId: 'account-1' as RecordId }),
    ];

    it('shows the card once with its default and each currency account', async () => {
      const wrapper = await mountCardLinks(multiCurrencyCard);

      expect(rows(wrapper)).toHaveLength(1);
      expect(rows(wrapper)[0]!.get('[data-testid="card-link-label-text"]').text()).toContain('•••• 1234');

      const accounts = accountRows(rows(wrapper)[0]!);
      expect(accounts.map((row) => row.get('[data-testid="card-link-currency"]').text())).toEqual([
        'Default',
        'GEL',
        'USD',
      ]);
      expect(accounts.map((row) => row.get('[data-testid="card-link-account-name"]').text())).toEqual([
        'TBC main',
        'Cash GEL',
        'TBC main',
      ]);
      expect(wrapper.find('[data-testid="card-link-no-default"]').exists()).toBe(false);
    });

    it('keeps two cards apart', async () => {
      const wrapper = await mountCardLinks([
        ...multiCurrencyCard,
        makeMapping({ id: 'revolut' as RecordId, cardLabel: 'Revolut' }),
      ]);

      expect(rows(wrapper)).toHaveLength(2);
      expect(accountRows(rows(wrapper)[1]!)).toHaveLength(1);
    });

    it('says a card has no default account when it has only currency rows', async () => {
      const wrapper = await mountCardLinks([multiCurrencyCard[1]!]);

      expect(wrapper.get('[data-testid="card-link-no-default"]').text()).toContain('No default account');
    });

    it('opens the dialog to add an account under this card', async () => {
      const wrapper = await mountCardLinks([
        ...multiCurrencyCard,
        makeMapping({ id: 'revolut' as RecordId, cardLabel: 'Revolut' }),
      ]);

      await rows(wrapper)[0]!.get('[data-testid="card-link-add-account"]').trigger('click');

      expect(dialog(wrapper).attributes('data-open')).toBe('true');
      expect(dialog(wrapper).attributes('data-mapping-id')).toBe('');
      expect(dialog(wrapper).attributes('data-lock-label')).toBe('true');
      expect(dialog(wrapper).attributes('data-initial-label')).toBe('TBC Visa');
      expect(dialog(wrapper).attributes('data-siblings')).toBe('default,gel,usd');
    });

    it('opens the dialog on the row being edited, not on the whole card', async () => {
      const wrapper = await mountCardLinks(multiCurrencyCard);

      await accountRows(rows(wrapper)[0]!)[1]!.get('[data-testid="card-link-edit"]').trigger('click');

      expect(dialog(wrapper).attributes('data-mapping-id')).toBe('gel');
      expect(dialog(wrapper).attributes('data-lock-label')).toBe('false');
    });

    it('deletes one currency row and says where its payments go', async () => {
      const wrapper = await mountCardLinks(multiCurrencyCard);

      await accountRows(rows(wrapper)[0]!)[1]!.get('[data-testid="card-link-delete"]').trigger('click');

      expect(wrapper.get('[data-testid="alert-dialog"]').text()).toContain('in GEL will go to the card');
      await wrapper.get('[data-testid="alert-confirm"]').trigger('click');
      await flushPromises();

      expect(mockDeleteMapping).toHaveBeenCalledWith({ id: 'gel' });
    });
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
    expect(dialog(wrapper).attributes('data-lock-label')).toBe('false');
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
