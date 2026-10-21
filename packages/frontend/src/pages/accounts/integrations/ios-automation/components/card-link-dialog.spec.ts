import {
  ACCOUNT_CATEGORIES,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  type AccountModel,
  type CardMappingDto,
  type RecordId,
} from '@bt/shared/types';
import { type VueWrapper, flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { createGlobalPlugins } from '../test-support';
import CardLinkDialog from './card-link-dialog.vue';

const { mockCreate, mockUpdate, mockAccountsStore } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockAccountsStore: { accounts: [] as unknown[], accountsRecord: {} as Record<string, unknown> },
}));

vi.mock('@/api/ingest', () => ({ createCardMapping: mockCreate, updateCardMapping: mockUpdate }));
vi.mock('@/stores/accounts', () => ({ useAccountsStore: () => mockAccountsStore }));
vi.mock('@/components/notification-center', () => ({
  NotificationType: { error: 'error' },
  useNotificationCenter: () => ({
    addSuccessNotification: vi.fn(),
    addErrorNotification: vi.fn(),
    addNotification: vi.fn(),
  }),
}));
vi.mock('@/components/common/responsive-dialog.vue', async () => ({
  default: (await import('../test-support')).createResponsiveDialogStub(),
}));

const makeAccount = (overrides: Partial<AccountModel>): AccountModel =>
  ({
    id: 'account-1' as RecordId,
    name: 'TBC Visa',
    type: ACCOUNT_TYPES.system,
    status: ACCOUNT_STATUSES.active,
    accountCategory: ACCOUNT_CATEGORIES.general,
    currencyCode: 'GEL',
    ...overrides,
  }) as AccountModel;

const OWNED = makeAccount({ id: 'owned' as RecordId, name: 'Owned' });
const OTHER = makeAccount({ id: 'other' as RecordId, name: 'Other' });
const ARCHIVED = makeAccount({ id: 'archived' as RecordId, status: ACCOUNT_STATUSES.archived });
const LOAN = makeAccount({ id: 'loan' as RecordId, accountCategory: ACCOUNT_CATEGORIES.loan });
const VEHICLE = makeAccount({ id: 'vehicle' as RecordId, accountCategory: ACCOUNT_CATEGORIES.vehicle });
const SHARED_IN = makeAccount({ id: 'shared-in' as RecordId, share: { isOwner: false } as never });

const USD_ACCOUNT = makeAccount({ id: 'usd' as RecordId, name: 'Dollars', currencyCode: 'USD' });

const MAPPING: CardMappingDto = {
  id: 'mapping-1' as RecordId,
  cardLabel: 'TBC Visa',
  lastDigits: null,
  currencyCode: null,
  accountId: 'owned' as RecordId,
  createdAt: '2026-10-10T09:00:00.000Z',
};

/** Exposes the options it was given and lets a test pick one; the real select renders options only when opened. */
const AccountSelectStub = defineComponent({
  name: 'AccountSelectFieldStub',
  props: {
    modelValue: { type: Object, default: null },
    accounts: { type: Array, default: () => [] },
    errorMessage: { type: String, default: '' },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h('div', [
        h(
          'select',
          {
            'data-testid': 'account-select',
            value: (props.modelValue as AccountModel | null)?.id ?? '',
            onChange: (event: Event) => {
              const id = (event.target as HTMLSelectElement).value;
              emit(
                'update:modelValue',
                (props.accounts as AccountModel[]).find((account) => account.id === id) ?? null,
              );
            },
          },
          (props.accounts as AccountModel[]).map((account) => h('option', { value: account.id }, account.name)),
        ),
        props.errorMessage ? h('p', { 'data-testid': 'account-error' }, props.errorMessage) : null,
      ]);
  },
});

/** Lists the currencies it was offered and lets a test pick one by its value. */
const CurrencySelectStub = defineComponent({
  name: 'SelectFieldStub',
  props: {
    modelValue: { type: Object, default: null },
    values: { type: Array, default: () => [] },
    disabled: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    type Option = { value: string; label: string };

    return () =>
      h('div', [
        h(
          'select',
          {
            'data-testid': 'currency-select',
            disabled: props.disabled,
            value: (props.modelValue as Option | null)?.value ?? '',
            onChange: (event: Event) => {
              const value = (event.target as HTMLSelectElement).value;
              emit('update:modelValue', (props.values as Option[]).find((option) => option.value === value) ?? null);
            },
          },
          (props.values as Option[]).map((option) => h('option', { value: option.value }, option.label)),
        ),
      ]);
  },
});

const mountDialog = (props: Record<string, unknown> = {}) =>
  mount(CardLinkDialog, {
    props: { open: true, ...props },
    global: {
      plugins: createGlobalPlugins().plugins,
      stubs: { AccountSelectField: AccountSelectStub, SelectField: CurrencySelectStub },
    },
  });

const currencyValues = (wrapper: VueWrapper) =>
  wrapper.findAll('[data-testid="currency-select"] option').map((option) => option.attributes('value'));
const accountValues = (wrapper: VueWrapper) =>
  wrapper.findAll('[data-testid="account-select"] option').map((option) => option.attributes('value'));
const pickCurrency = async (wrapper: VueWrapper, value: string) => {
  await wrapper.get('[data-testid="currency-select"]').setValue(value);
};

const labelInput = (wrapper: VueWrapper) =>
  wrapper.get('[data-testid="card-link-label"] input, input[data-testid="card-link-label"]');
const pickAccount = async (wrapper: VueWrapper, id: string) => {
  await wrapper.get('[data-testid="account-select"]').setValue(id);
};
const submit = async (wrapper: VueWrapper) => {
  await wrapper.get('form').trigger('submit');
  await flushPromises();
};

describe('CardLinkDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccountsStore.accounts = [OWNED, OTHER, ARCHIVED, LOAN, VEHICLE, SHARED_IN];
    mockAccountsStore.accountsRecord = Object.fromEntries(
      mockAccountsStore.accounts.map((a) => [(a as AccountModel).id, a]),
    );
    mockCreate.mockImplementation(async (payload) => ({ ...MAPPING, ...payload, id: 'new' }));
    mockUpdate.mockImplementation(async ({ id, ...payload }) => ({ ...MAPPING, id, ...payload }));
  });

  it('offers only owned, active accounts that are not loans or vehicles', () => {
    const wrapper = mountDialog();

    const options = wrapper
      .findAll('[data-testid="account-select"] option')
      .map((option) => option.attributes('value'));
    expect(options).toEqual(['owned', 'other']);
  });

  it('adds a link with the trimmed card name and the chosen account', async () => {
    const wrapper = mountDialog();

    await labelInput(wrapper).setValue('  TBC Visa  ');
    await pickAccount(wrapper, 'other');
    await submit(wrapper);

    expect(mockCreate).toHaveBeenCalledWith({ cardLabel: 'TBC Visa', accountId: 'other' });
    expect(wrapper.emitted('saved')?.[0]?.[0]).toMatchObject({ cardLabel: 'TBC Visa', accountId: 'other' });
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  describe('last digits', () => {
    const digitsInput = (wrapper: VueWrapper) =>
      wrapper.get('[data-testid="card-link-last-digits"] input, input[data-testid="card-link-last-digits"]');

    it('sends the digits a bank notification names the card by', async () => {
      const wrapper = mountDialog();

      await labelInput(wrapper).setValue('TBC Visa');
      await digitsInput(wrapper).setValue(' 8543 ');
      await pickAccount(wrapper, 'owned');
      await submit(wrapper);

      expect(mockCreate).toHaveBeenCalledWith({ cardLabel: 'TBC Visa', accountId: 'owned', lastDigits: '8543' });
    });

    it('leaves the digits out when the field is empty', async () => {
      const wrapper = mountDialog();

      await labelInput(wrapper).setValue('TBC Visa');
      await pickAccount(wrapper, 'owned');
      await submit(wrapper);

      expect(mockCreate).toHaveBeenCalledWith({ cardLabel: 'TBC Visa', accountId: 'owned' });
    });

    it.each(['123', '123456789', '12a4'])('refuses %s, which is not 4 to 8 digits', async (digits) => {
      const wrapper = mountDialog();

      await labelInput(wrapper).setValue('TBC Visa');
      await digitsInput(wrapper).setValue(digits);
      await pickAccount(wrapper, 'owned');
      await submit(wrapper);

      expect(mockCreate).not.toHaveBeenCalled();
      expect(wrapper.text()).toContain('Enter 4 to 8 digits.');
    });

    it('starts from the digits of a link being edited and sends a change', async () => {
      const wrapper = mountDialog({ mapping: { ...MAPPING, lastDigits: '8543' } });
      expect((digitsInput(wrapper).element as HTMLInputElement).value).toBe('8543');

      await digitsInput(wrapper).setValue('1111');
      await submit(wrapper);

      expect(mockUpdate).toHaveBeenCalledWith({ id: 'mapping-1', lastDigits: '1111' });
    });

    it('clears the digits of a link when the field is emptied', async () => {
      const wrapper = mountDialog({ mapping: { ...MAPPING, lastDigits: '8543' } });

      await digitsInput(wrapper).setValue('');
      await submit(wrapper);

      expect(mockUpdate).toHaveBeenCalledWith({ id: 'mapping-1', lastDigits: null });
    });

    it('hides the field when an account is added to a card that already has its digits', () => {
      const wrapper = mountDialog({ lockLabel: true, initialLabel: 'TBC Visa' });

      expect(wrapper.find('[data-testid="card-link-last-digits"]').exists()).toBe(false);
    });
  });

  it('pre-fills the card name of a link started from an unlinked card', () => {
    const wrapper = mountDialog({ initialLabel: 'Revolut •••• 4242' });

    expect((labelInput(wrapper).element as HTMLInputElement).value).toBe('Revolut •••• 4242');
  });

  it('pre-fills the digits of a link started from a notification that shows only digits', () => {
    const wrapper = mountDialog({ initialLabel: 'Raiffeisen •1258', initialLastDigits: '1258' });

    const input = wrapper.get('[data-testid="card-link-last-digits"] input, input[data-testid="card-link-last-digits"]');

    expect((input.element as HTMLInputElement).value).toBe('1258');
  });

  it('asks for a name and an account before it sends anything', async () => {
    const wrapper = mountDialog();

    await submit(wrapper);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Enter the card name.');
    expect(wrapper.get('[data-testid="account-error"]').text()).toBe('Select an account.');
  });

  it('keeps the dialog open when the server refuses the link', async () => {
    mockCreate.mockRejectedValue(new Error('A link for this card already exists'));
    const wrapper = mountDialog();

    await labelInput(wrapper).setValue('TBC Visa');
    await pickAccount(wrapper, 'owned');
    await submit(wrapper);

    expect(wrapper.emitted('saved')).toBeUndefined();
    expect(wrapper.emitted('update:open')).toBeUndefined();
  });

  describe('editing', () => {
    it('starts from the link being edited', () => {
      const wrapper = mountDialog({ mapping: MAPPING });

      expect((labelInput(wrapper).element as HTMLInputElement).value).toBe('TBC Visa');
      expect((wrapper.get('[data-testid="account-select"]').element as HTMLSelectElement).value).toBe('owned');
    });

    it('renames the card and sends only the name', async () => {
      const wrapper = mountDialog({ mapping: MAPPING });

      await labelInput(wrapper).setValue('TBC Visa Gold');
      await submit(wrapper);

      expect(mockUpdate).toHaveBeenCalledWith({ id: 'mapping-1', cardLabel: 'TBC Visa Gold' });
    });

    it('points the card at another account and sends only the account', async () => {
      const wrapper = mountDialog({ mapping: MAPPING });

      await pickAccount(wrapper, 'other');
      await submit(wrapper);

      expect(mockUpdate).toHaveBeenCalledWith({ id: 'mapping-1', accountId: 'other' });
    });

    it('sends nothing when nothing changed, since the server refuses an empty change', async () => {
      const wrapper = mountDialog({ mapping: MAPPING });

      await submit(wrapper);

      expect(mockUpdate).not.toHaveBeenCalled();
      expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
    });
  });

  describe('one card in several currencies', () => {
    beforeEach(() => {
      mockAccountsStore.accounts = [OWNED, OTHER, USD_ACCOUNT];
    });

    it('starts on the default and offers it with every currency the accounts are in', () => {
      const wrapper = mountDialog();

      expect(currencyValues(wrapper)).toEqual(['default', 'GEL', 'USD']);
      expect((wrapper.get('[data-testid="currency-select"]').element as HTMLSelectElement).value).toBe('default');
      expect(wrapper.get('[data-testid="card-link-currency-hint"]').text()).toContain('without an account of its own');
    });

    it('adds an account for one currency and sends the currency', async () => {
      const wrapper = mountDialog();

      await labelInput(wrapper).setValue('TBC Visa');
      await pickCurrency(wrapper, 'USD');
      await pickAccount(wrapper, 'usd');
      await submit(wrapper);

      expect(mockCreate).toHaveBeenCalledWith({ cardLabel: 'TBC Visa', accountId: 'usd', currencyCode: 'USD' });
      expect(wrapper.get('[data-testid="card-link-currency-hint"]').text()).toContain('in this currency');
    });

    it('offers only the accounts in the chosen currency', async () => {
      const wrapper = mountDialog();

      expect(accountValues(wrapper)).toEqual(['owned', 'other', 'usd']);

      await pickCurrency(wrapper, 'GEL');
      expect(accountValues(wrapper)).toEqual(['owned', 'other']);

      await pickCurrency(wrapper, 'USD');
      expect(accountValues(wrapper)).toEqual(['usd']);
    });

    it('drops an account that does not fit the currency picked after it', async () => {
      const wrapper = mountDialog();
      await labelInput(wrapper).setValue('TBC Visa');
      await pickAccount(wrapper, 'owned');

      await pickCurrency(wrapper, 'USD');
      await submit(wrapper);

      expect(mockCreate).not.toHaveBeenCalled();
      expect(wrapper.get('[data-testid="account-error"]').text()).toBe('Select an account.');
    });

    it('adds under an existing card: the name is fixed and taken currencies are not offered', () => {
      const siblings: CardMappingDto[] = [
        MAPPING,
        { ...MAPPING, id: 'mapping-2' as RecordId, currencyCode: 'GEL', accountId: 'owned' as RecordId },
      ];

      const wrapper = mountDialog({ initialLabel: 'TBC Visa', lockLabel: true, siblings });

      expect(currencyValues(wrapper)).toEqual(['USD']);
      expect((labelInput(wrapper).element as HTMLInputElement).value).toBe('TBC Visa');
      expect(labelInput(wrapper).attributes('disabled')).toBeDefined();
      expect(wrapper.text()).toContain('Add an account');
    });

    it('offers the default to a card that has only currency rows', () => {
      const siblings: CardMappingDto[] = [{ ...MAPPING, currencyCode: 'GEL' }];

      const wrapper = mountDialog({ initialLabel: 'TBC Visa', lockLabel: true, siblings });

      expect(currencyValues(wrapper)).toEqual(['default', 'USD']);
    });

    it('keeps the currency of an edited row, which cannot change', () => {
      const wrapper = mountDialog({ mapping: { ...MAPPING, currencyCode: 'GEL' } });

      expect(currencyValues(wrapper)).toEqual(['GEL']);
      expect(wrapper.get('[data-testid="currency-select"]').attributes('disabled')).toBeDefined();
      expect(accountValues(wrapper)).toEqual(['owned', 'other']);
    });

    it('edits the default row, which any account can serve', () => {
      const wrapper = mountDialog({ mapping: MAPPING });

      expect(currencyValues(wrapper)).toEqual(['default']);
      expect(accountValues(wrapper)).toEqual(['owned', 'other', 'usd']);
    });
  });

  it('starts clean each time it opens', async () => {
    const wrapper = mountDialog();
    await labelInput(wrapper).setValue('Typed and abandoned');

    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true, initialLabel: 'Revolut' });

    expect((labelInput(wrapper).element as HTMLInputElement).value).toBe('Revolut');
  });
});
