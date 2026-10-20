import commonEn from '@/i18n/locales/chunks/en/common.json';
import integrationsEn from '@/i18n/locales/chunks/en/settings/integrations.json';
import type { CreateIngestTokenResponse, IngestTokenDto, RecordId } from '@bt/shared/types';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { type VueWrapper, flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createI18n } from 'vue-i18n';

import CreateTokenDialog from './create-token-dialog.vue';

const { mockCreateIngestToken, mockAddSuccess, mockNotifyError } = vi.hoisted(() => ({
  mockCreateIngestToken: vi.fn(),
  mockAddSuccess: vi.fn(),
  mockNotifyError: vi.fn(),
}));

vi.mock('@/api/ingest', () => ({ createIngestToken: mockCreateIngestToken }));
vi.mock('@/composable/data-queries/use-invalidating-mutation', () => ({ notifyMutationError: mockNotifyError }));
vi.mock('@/components/notification-center', () => ({
  useNotificationCenter: () => ({ addSuccessNotification: mockAddSuccess, addErrorNotification: vi.fn() }),
}));

/** Renders its slots while open, and forwards a close the way the real dialog does. */
vi.mock('@/components/common/responsive-dialog.vue', async () => {
  const { defineComponent: define, h: render } = await import('vue');
  return {
    default: define({
      name: 'ResponsiveDialogStub',
      props: { open: { type: Boolean, default: true } },
      emits: ['update:open'],
      setup(props, { emit, slots }) {
        const close = () => emit('update:open', false);
        return () =>
          props.open === false
            ? null
            : render('div', { 'data-testid': 'dialog' }, [
                slots.title?.(),
                slots.description?.(),
                slots.default?.({ close }),
                slots.footer?.({ close }),
                render('button', { 'data-testid': 'dialog-dismiss', onClick: close }),
              ]);
      },
    }),
  };
});

/** A native select over the option objects, since the reka select renders its options only when opened. */
const SelectFieldStub = defineComponent({
  name: 'SelectFieldStub',
  props: {
    modelValue: { type: Object, default: null },
    values: { type: Array, default: () => [] },
    label: { type: String, default: '' },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h(
        'select',
        {
          'data-testid': 'expiry-select',
          value: (props.modelValue as { id: string } | null)?.id,
          onChange: (event: Event) => {
            const id = (event.target as HTMLSelectElement).value;
            emit(
              'update:modelValue',
              (props.values as { id: string }[]).find((option) => option.id === id),
            );
          },
        },
        (props.values as { id: string; label: string }[]).map((option) =>
          h('option', { value: option.id }, option.label),
        ),
      );
  },
});

const SECRET = 'mm_ingest_SHOWN-ONCE-SECRET';

const TOKEN: IngestTokenDto = {
  id: 'token-1' as RecordId,
  name: 'iPhone shortcut',
  start: 'mm_ingest_SHOW',
  scopes: ['ingest:transactions'],
  lastUsedAt: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  expiresAt: null,
};

const RESPONSE: CreateIngestTokenResponse = { token: TOKEN, secret: SECRET };

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { ...commonEn, ...integrationsEn } },
});

let queryClient: QueryClient;
const writeText = vi.fn();

const mountDialog = () =>
  mount(CreateTokenDialog, {
    props: { open: true },
    global: {
      plugins: [i18n, [VueQueryPlugin, { queryClient }]],
      stubs: { SelectField: SelectFieldStub },
    },
  });

const nameInput = (wrapper: VueWrapper) =>
  wrapper.find('[data-testid="ingest-token-name"] input, input[data-testid="ingest-token-name"]');
const submit = async (wrapper: VueWrapper) => {
  await wrapper.get('form').trigger('submit');
  await flushPromises();
};
const secretText = (wrapper: VueWrapper) => wrapper.find('[data-testid="ingest-token-secret"]').text();
const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('CreateTokenDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    mockCreateIngestToken.mockResolvedValue(RESPONSE);
    Object.assign(navigator, { clipboard: { writeText } });
    writeText.mockResolvedValue(undefined);
  });

  describe('the form', () => {
    it('asks for a name and an expiry, and has no secret yet', () => {
      const wrapper = mountDialog();

      expect(nameInput(wrapper).exists()).toBe(true);
      expect(wrapper.find('[data-testid="expiry-select"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="ingest-token-secret"]').exists()).toBe(false);
    });

    it('refuses a blank name without calling the API', async () => {
      const wrapper = mountDialog();

      await nameInput(wrapper).setValue('   ');
      await submit(wrapper);

      expect(mockCreateIngestToken).not.toHaveBeenCalled();
      expect(wrapper.text()).toContain('Enter a name for the token.');
    });

    it('sends the trimmed name and no expiry by default', async () => {
      const wrapper = mountDialog();

      await nameInput(wrapper).setValue('  iPhone shortcut ');
      await submit(wrapper);

      expect(mockCreateIngestToken).toHaveBeenCalledWith({ name: 'iPhone shortcut' });
    });

    it('sends the chosen expiry in days', async () => {
      const wrapper = mountDialog();

      await nameInput(wrapper).setValue('Script');
      await wrapper.get('[data-testid="expiry-select"]').setValue('days90');
      await submit(wrapper);

      expect(mockCreateIngestToken).toHaveBeenCalledWith({ name: 'Script', expiresInDays: 90 });
    });
  });

  describe('after the token is created', () => {
    const createToken = async () => {
      const wrapper = mountDialog();
      await nameInput(wrapper).setValue('iPhone shortcut');
      await submit(wrapper);
      return wrapper;
    };

    it('shows the secret with a note that it will not be shown again', async () => {
      const wrapper = await createToken();

      expect(secretText(wrapper)).toBe(SECRET);
      expect(wrapper.text()).toContain("You won't see this token again.");
      expect(wrapper.find('form').exists()).toBe(false);
    });

    it('copies the secret and confirms with a notification', async () => {
      const wrapper = await createToken();

      await wrapper.get('[data-testid="ingest-token-copy"]').trigger('click');
      await flushPromises();

      expect(writeText).toHaveBeenCalledWith(SECRET);
      expect(mockAddSuccess).toHaveBeenCalledWith('Token copied to clipboard');
    });

    it('clears the secret from state and the query cache when the dialog is closed with Done', async () => {
      const wrapper = await createToken();

      await wrapper.get('[data-testid="ingest-token-done"]').trigger('click');
      await flushPromises();
      await nextMacrotask();

      expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
      expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
      expect(
        JSON.stringify(
          queryClient
            .getMutationCache()
            .getAll()
            .map((m) => m.state.data),
        ),
      ).not.toContain(SECRET);
    });

    it('clears the secret when the dialog is dismissed, so reopening shows an empty form', async () => {
      const wrapper = await createToken();

      await wrapper.get('[data-testid="dialog-dismiss"]').trigger('click');
      await wrapper.setProps({ open: false });
      await flushPromises();
      await nextMacrotask();
      await wrapper.setProps({ open: true });

      expect(wrapper.find('[data-testid="ingest-token-secret"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain(SECRET);
      expect((nameInput(wrapper).element as HTMLInputElement).value).toBe('');
      expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    });

    it('clears the secret when the parent closes the dialog', async () => {
      const wrapper = await createToken();

      await wrapper.setProps({ open: false });
      await flushPromises();
      await nextMacrotask();
      await wrapper.setProps({ open: true });

      expect(wrapper.text()).not.toContain(SECRET);
      expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    });
  });
});
