import type { CardMappingDto, RecordId } from '@bt/shared/types';
import { type VueWrapper, flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ref } from 'vue';
import { defineComponent, h, ref } from 'vue';

import ApplePay from './apple-pay-details.vue';
import * as shortcutModule from './composables/use-shortcut-link';
import { createGlobalPlugins } from './test-support';

const { mockCreateSetupCode, mockLogWaiting, mockConfig, mockAddError, mockPush } = vi.hoisted(() => ({
  mockCreateSetupCode: vi.fn(),
  mockLogWaiting: vi.fn(),
  mockConfig: { isSelfHost: false, docsUrl: 'https://docs.example.com' },
  mockAddError: vi.fn(),
  mockPush: vi.fn(),
}));

vi.mock('vue-router', () => ({ useRouter: () => ({ push: mockPush }) }));
vi.mock('@/routes', () => ({ ROUTES_NAMES: { accounts: 'accounts' } }));

vi.mock('@/api/ingest', () => ({ createCardPaymentSetupCode: mockCreateSetupCode }));
vi.mock('@/api/api-base-url', () => ({ API_HTTP: 'https://money.example.com', API_VER: '/api/v1' }));
vi.mock('@/common/config', () => ({ config: mockConfig }));
vi.mock('./composables/use-shortcut-link', async () => {
  const { ref: createRef } = await import('vue');
  const shortcut = { href: createRef<string | null>(null), isResolved: createRef(true) };
  return { useShortcutLink: () => shortcut, shortcut };
});
vi.mock('./composables/use-log-waiting-payments', () => ({
  useLogWaitingPayments: () => ({ logWaitingPayments: mockLogWaiting, isLogging: ref(false) }),
}));
vi.mock('@/composable/data-queries/use-invalidating-mutation', () => ({ notifyMutationError: vi.fn() }));
vi.mock('@/components/notification-center', () => ({
  useNotificationCenter: () => ({
    addSuccessNotification: vi.fn(),
    addErrorNotification: mockAddError,
    addWarningNotification: vi.fn(),
  }),
}));
vi.mock('@/components/common/responsive-dialog.vue', async () => ({
  default: (await import('./test-support')).createResponsiveDialogStub(),
}));
vi.mock('@/components/common/responsive-alert-dialog.vue', async () => ({
  default: (await import('./test-support')).createResponsiveAlertDialogStub(),
}));

/** The module is mocked above and exports the refs the page reads. */
const mockShortcut = (shortcutModule as unknown as { shortcut: { href: Ref<string | null>; isResolved: Ref<boolean> } })
  .shortcut;

const CODE = 'v1.SETUP-CODE-THAT-MUST-NOT-LINGER';

const stub = (name: string, testId: string) =>
  defineComponent({ name, setup: () => () => h('div', { 'data-testid': testId }) });

const UnlinkedCardsStub = defineComponent({
  name: 'UnlinkedCardsStub',
  emits: ['link'],
  setup:
    (_props, { emit }) =>
    () =>
      h('button', {
        'data-testid': 'unlinked-stub',
        onClick: () => emit('link', { cardLabel: 'TBC Visa', count: 3 }),
      }),
});

/** Shows what the page passes in and lets a test report a saved link. */
const CardLinkDialogStub = defineComponent({
  name: 'CardLinkDialogStub',
  props: { open: { type: Boolean, default: false }, initialLabel: { type: String, default: '' } },
  emits: ['saved'],
  setup:
    (props, { emit }) =>
    () =>
      h('div', { 'data-testid': 'link-dialog', 'data-open': String(props.open), 'data-label': props.initialLabel }, [
        h('button', {
          'data-testid': 'link-saved',
          onClick: () =>
            emit('saved', {
              id: 'm1' as RecordId,
              cardLabel: 'tbc visa',
              lastDigits: null,
              currencyCode: null,
              accountId: 'a1' as RecordId,
              createdAt: '',
            } satisfies CardMappingDto),
        }),
        h('button', {
          'data-testid': 'link-saved-other',
          onClick: () =>
            emit('saved', {
              id: 'm2' as RecordId,
              cardLabel: 'Revolut',
              lastDigits: null,
              currencyCode: null,
              accountId: 'a1' as RecordId,
              createdAt: '',
            } satisfies CardMappingDto),
        }),
      ]),
});

const stubs = {
  CardLinks: stub('CardLinksStub', 'card-links-stub'),
  IngestDevices: stub('IngestDevicesStub', 'devices-stub'),
  UnlinkedCards: UnlinkedCardsStub,
  WaitingPayments: stub('WaitingPaymentsStub', 'waiting-stub'),
  UnconfirmedPayments: stub('UnconfirmedPaymentsStub', 'unconfirmed-stub'),
  AccessHeadersForm: stub('AccessHeadersFormStub', 'access-headers-stub'),
  AddShortcutButton: stub('AddShortcutButtonStub', 'add-shortcut-stub'),
  CardLinkDialog: CardLinkDialogStub,
};

const mountPage = () => {
  const { queryClient, plugins } = createGlobalPlugins();
  const wrapper = mount(ApplePay, { global: { plugins, stubs } });
  return { wrapper, queryClient };
};

const click = async (wrapper: VueWrapper, testId: string) => {
  await wrapper.get(`[data-testid="${testId}"]`).trigger('click');
  await flushPromises();
};

const dumpCache = ({ queryClient }: { queryClient: ReturnType<typeof createGlobalPlugins>['queryClient'] }) =>
  JSON.stringify({
    mutations: queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.data),
    queries: queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  });

describe('Apple Pay page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.isSelfHost = false;
    mockShortcut.href.value = '/shortcuts/log-card-payment.shortcut';
    mockShortcut.isResolved.value = true;
    mockCreateSetupCode.mockResolvedValue({ token: { id: 't1' }, setupCode: CODE });
  });

  describe('the Cloudflare Access fields', () => {
    it('are offered on a self-hosted instance', () => {
      mockConfig.isSelfHost = true;
      const { wrapper } = mountPage();

      expect(wrapper.find('[data-testid="access-headers-stub"]').exists()).toBe(true);
    });

    it('are left out on the hosted service', () => {
      const { wrapper } = mountPage();

      expect(wrapper.find('[data-testid="access-headers-stub"]').exists()).toBe(false);
    });
  });

  describe('the setup code', () => {
    it('is generated for this instance and revokes the previous token by default', async () => {
      const { wrapper } = mountPage();

      await click(wrapper, 'generate-setup-code');

      expect(mockCreateSetupCode).toHaveBeenCalledWith({
        ingestUrl: 'https://money.example.com/api/v1/ingest/card-payment',
        revokePrevious: true,
      });
    });

    it('keeps the previous token when the user unticks the box', async () => {
      const { wrapper } = mountPage();

      await wrapper.get('[data-testid="revoke-previous"]').trigger('click');
      await click(wrapper, 'generate-setup-code');

      expect(mockCreateSetupCode).toHaveBeenCalledWith(expect.objectContaining({ revokePrevious: false }));
    });

    it('opens a one-time dialog with the code', async () => {
      const { wrapper } = mountPage();
      expect(wrapper.find('[data-testid="setup-code-text"]').exists()).toBe(false);

      await click(wrapper, 'generate-setup-code');

      expect(wrapper.get('[data-testid="setup-code-text"]').text()).toBe(CODE);
      expect(wrapper.find('[data-testid="setup-code-qr"]').exists()).toBe(true);
    });

    it('is gone from the page and the query cache once the dialog closes', async () => {
      const { wrapper, queryClient } = mountPage();
      await click(wrapper, 'generate-setup-code');
      expect(dumpCache({ queryClient })).toContain(CODE);

      await click(wrapper, 'setup-code-done');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(wrapper.html()).not.toContain(CODE);
      expect(dumpCache({ queryClient })).not.toContain(CODE);
      expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    });

    it('is gone from the query cache when the page is left with the dialog open', async () => {
      const { wrapper, queryClient } = mountPage();
      await click(wrapper, 'generate-setup-code');

      wrapper.unmount();
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(dumpCache({ queryClient })).not.toContain(CODE);
    });

    it('shows no dialog when the server refuses', async () => {
      mockCreateSetupCode.mockRejectedValue(new Error('boom'));
      const { wrapper } = mountPage();

      await click(wrapper, 'generate-setup-code');

      expect(wrapper.find('[data-testid="setup-code-text"]').exists()).toBe(false);
    });
  });

  describe('Add Shortcut', () => {
    it('is offered next to the generate button', () => {
      const { wrapper } = mountPage();

      expect(wrapper.find('[data-testid="add-shortcut-stub"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="shortcut-unavailable"]').exists()).toBe(false);
    });

    it('points to the manual guide when the instance ships no shortcut', () => {
      mockShortcut.href.value = null;
      const { wrapper } = mountPage();

      expect(wrapper.get('[data-testid="shortcut-unavailable"]').text()).toContain('manual guide');
    });

    it('stays quiet while the probe is still running', () => {
      mockShortcut.href.value = null;
      mockShortcut.isResolved.value = false;
      const { wrapper } = mountPage();

      expect(wrapper.find('[data-testid="shortcut-unavailable"]').exists()).toBe(false);
    });
  });

  it('links to the manual guide in the docs', () => {
    const { wrapper } = mountPage();

    const link = wrapper.get('[data-testid="manual-guide"] a');
    expect(link.attributes('href')).toBe('https://docs.example.com/integrations/apple-pay/');
    expect(link.text()).toContain('manual setup guide');
  });

  it('says that only taps in a shop start the shortcut', () => {
    const { wrapper } = mountPage();

    const note = wrapper.get('[data-testid="apple-pay-limitation"]').text();
    expect(note).toContain('contactless taps in a shop');
    expect(note).toContain('bank');
  });

  it('lists the devices below the payments and goes back to the accounts', async () => {
    const { wrapper } = mountPage();

    expect(wrapper.find('[data-testid="devices-stub"]').exists()).toBe(true);

    await wrapper.get('[data-testid="apple-pay-back"]').trigger('click');

    expect(mockPush).toHaveBeenCalledWith({ name: 'accounts' });
  });

  it('walks through the automation on the phone', () => {
    const { wrapper } = mountPage();

    expect(wrapper.findAll('[data-testid="setup-checklist-step"]')).toHaveLength(3);
  });

  describe('linking an unlinked card', () => {
    const startLink = async (wrapper: VueWrapper) => click(wrapper, 'unlinked-stub');

    it('opens the link dialog with the card name filled in', async () => {
      const { wrapper } = mountPage();

      await startLink(wrapper);

      expect(wrapper.get('[data-testid="link-dialog"]').attributes('data-open')).toBe('true');
      expect(wrapper.get('[data-testid="link-dialog"]').attributes('data-label')).toBe('TBC Visa');
    });

    it('then offers to log the waiting payments, and logs them on confirm', async () => {
      mockLogWaiting.mockResolvedValue({ logged: 3, stillWaiting: 0, failed: 0 });
      const { wrapper } = mountPage();

      await startLink(wrapper);
      await click(wrapper, 'link-saved');

      expect(wrapper.get('[data-testid="alert-dialog"]').text()).toContain('3 payments from tbc visa are waiting');
      expect(wrapper.get('[data-testid="alert-confirm"]').text()).toBe('Log 3 waiting payments');

      await click(wrapper, 'alert-confirm');

      expect(mockLogWaiting).toHaveBeenCalledWith({ cardLabel: 'tbc visa' });
      expect(wrapper.find('[data-testid="alert-dialog"]').exists()).toBe(false);
    });

    it('logs nothing when the offer is declined', async () => {
      const { wrapper } = mountPage();

      await startLink(wrapper);
      await click(wrapper, 'link-saved');
      await click(wrapper, 'alert-cancel');

      expect(mockLogWaiting).not.toHaveBeenCalled();
      expect(wrapper.find('[data-testid="alert-dialog"]').exists()).toBe(false);
    });

    it('makes no offer when the user linked a different card than the one they started from', async () => {
      const { wrapper } = mountPage();

      await startLink(wrapper);
      await click(wrapper, 'link-saved-other');

      expect(wrapper.find('[data-testid="alert-dialog"]').exists()).toBe(false);
    });

    it('reports a failure to log the waiting payments', async () => {
      mockLogWaiting.mockRejectedValue(new Error('offline'));
      const { wrapper } = mountPage();

      await startLink(wrapper);
      await click(wrapper, 'link-saved');
      await click(wrapper, 'alert-confirm');

      expect(mockAddError).toHaveBeenCalledWith('Could not log the waiting payments');
    });
  });
});
