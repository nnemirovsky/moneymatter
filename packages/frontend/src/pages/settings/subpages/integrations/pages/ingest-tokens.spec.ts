import commonEn from '@/i18n/locales/chunks/en/common.json';
import integrationsEn from '@/i18n/locales/chunks/en/settings/integrations.json';
import type { IngestTokenDto, RecordId } from '@bt/shared/types';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { type VueWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';

import IngestTokens from './ingest-tokens.vue';

const { mockGetIngestTokens, mockRevokeIngestToken, mockAddSuccess, mockNotifyError } = vi.hoisted(() => ({
  mockGetIngestTokens: vi.fn(),
  mockRevokeIngestToken: vi.fn(),
  mockAddSuccess: vi.fn(),
  mockNotifyError: vi.fn(),
}));

vi.mock('@/api/ingest', () => ({
  getIngestTokens: mockGetIngestTokens,
  revokeIngestToken: mockRevokeIngestToken,
}));
vi.mock('@/composable/data-queries/use-invalidating-mutation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/composable/data-queries/use-invalidating-mutation')>()),
  notifyMutationError: mockNotifyError,
}));
vi.mock('@/components/notification-center', () => ({
  NotificationType: { error: 'error' },
  useNotificationCenter: () => ({
    addSuccessNotification: mockAddSuccess,
    addErrorNotification: vi.fn(),
    addNotification: vi.fn(),
  }),
}));

/** The dialog tree needs the app shell (media queries, portals); here only open state and confirm matter. */
vi.mock('@/components/common/responsive-alert-dialog.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'ResponsiveAlertDialogStub',
      props: { open: { type: Boolean, default: false }, confirmLabel: { type: String, default: '' } },
      emits: ['update:open', 'confirm'],
      setup(props, { emit, slots }) {
        return () =>
          props.open
            ? h('div', { 'data-testid': 'revoke-dialog' }, [
                slots.title?.(),
                slots.description?.(),
                h('button', { 'data-testid': 'revoke-confirm', onClick: () => emit('confirm') }, props.confirmLabel),
                h('button', { 'data-testid': 'revoke-cancel', onClick: () => emit('update:open', false) }),
              ])
            : null;
      },
    }),
  };
});

vi.mock('../components/create-token-dialog.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'CreateTokenDialogStub',
      props: { open: { type: Boolean, default: false } },
      setup: (props) => () => h('div', { 'data-testid': 'create-dialog', 'data-open': String(props.open) }),
    }),
  };
});

const NOW = new Date('2026-10-18T12:00:00.000Z');

const makeToken = (overrides: Partial<IngestTokenDto> = {}): IngestTokenDto => ({
  id: 'token-1' as RecordId,
  name: 'iPhone shortcut',
  start: 'mm_ingest_aB3x',
  scopes: ['ingest:transactions'],
  lastUsedAt: null,
  createdAt: '2026-10-10T09:00:00.000Z',
  expiresAt: null,
  ...overrides,
});

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { ...commonEn, ...integrationsEn } },
});

const mountPage = () =>
  mount(IngestTokens, {
    global: {
      plugins: [
        i18n,
        [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }],
      ],
    },
  });

const rows = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="ingest-token-row"]');

const mountWithTokens = async (tokens: IngestTokenDto[]) => {
  mockGetIngestTokens.mockResolvedValue(tokens);
  const wrapper = mountPage();
  await flushPromises();
  return wrapper;
};

describe('Ingest tokens page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mockRevokeIngestToken.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the list', () => {
    it('shows name, token start, scope, last used and created', async () => {
      const wrapper = await mountWithTokens([
        makeToken({ lastUsedAt: '2026-10-18T09:00:00.000Z', createdAt: '2026-10-10T09:00:00.000Z' }),
      ]);

      const row = rows(wrapper)[0]!;
      expect(row.text()).toContain('iPhone shortcut');
      expect(row.text()).toContain('mm_ingest_aB3x…');
      expect(row.text()).toContain('Log card payments');
      expect(row.get('[data-testid="ingest-token-last-used"]').text()).toBe('about 3 hours ago');
      expect(row.get('[data-testid="ingest-token-created"]').text()).toBe('Oct 10, 2026');
    });

    it('says "Never" for a token that has not been used', async () => {
      const wrapper = await mountWithTokens([makeToken({ lastUsedAt: null })]);

      expect(rows(wrapper)[0]!.get('[data-testid="ingest-token-last-used"]').text()).toBe('Never');
    });

    it('shows the raw scope when this client does not know it', async () => {
      const wrapper = await mountWithTokens([makeToken({ scopes: ['ingest:something-new' as never] })]);

      expect(rows(wrapper)[0]!.text()).toContain('ingest:something-new');
    });

    it('shows the expiry only for a token that expires', async () => {
      const wrapper = await mountWithTokens([
        makeToken({ id: 'a' as RecordId, expiresAt: null }),
        makeToken({ id: 'b' as RecordId, name: 'Expiring', expiresAt: '2027-01-05T00:00:00.000Z' }),
      ]);

      const [never, expiring] = rows(wrapper);
      expect(never!.find('[data-testid="ingest-token-expires"]').exists()).toBe(false);
      expect(expiring!.get('[data-testid="ingest-token-expires"]').text()).toBe('Jan 5, 2027');
    });

    it('never renders anything that looks like a full secret', async () => {
      const wrapper = await mountWithTokens([makeToken()]);

      expect(wrapper.text()).not.toMatch(/mm_ingest_[A-Za-z0-9_-]{20,}/);
    });
  });

  describe('empty and failed states', () => {
    it('shows an empty state with a create action when there are no tokens', async () => {
      const wrapper = await mountWithTokens([]);

      expect(rows(wrapper)).toHaveLength(0);
      expect(wrapper.get('[data-testid="ingest-tokens-empty"]').text()).toContain('No tokens yet');
    });

    it('says the list could not be loaded instead of claiming there are no tokens', async () => {
      mockGetIngestTokens.mockRejectedValue(new Error('offline'));
      const wrapper = mountPage();
      await flushPromises();

      expect(wrapper.find('[data-testid="ingest-tokens-empty"]').exists()).toBe(false);
      expect(wrapper.text()).toContain('Could not load your tokens.');
    });
  });

  describe('creating', () => {
    it('opens the create dialog from the header button', async () => {
      const wrapper = await mountWithTokens([makeToken()]);
      expect(wrapper.get('[data-testid="create-dialog"]').attributes('data-open')).toBe('false');

      await wrapper.get('[data-testid="ingest-token-create"]').trigger('click');

      expect(wrapper.get('[data-testid="create-dialog"]').attributes('data-open')).toBe('true');
    });
  });

  describe('revoking', () => {
    it('asks for confirmation before revoking and revokes nothing until confirmed', async () => {
      const wrapper = await mountWithTokens([makeToken()]);

      await rows(wrapper)[0]!.get('[data-testid="ingest-token-revoke"]').trigger('click');

      expect(wrapper.get('[data-testid="revoke-dialog"]').text()).toContain('iPhone shortcut stops working at once.');
      expect(mockRevokeIngestToken).not.toHaveBeenCalled();
    });

    it('revokes the chosen token on confirm, then refreshes the list and confirms with a notification', async () => {
      const wrapper = await mountWithTokens([
        makeToken({ id: 'a' as RecordId, name: 'First' }),
        makeToken({ id: 'b' as RecordId, name: 'Second' }),
      ]);

      await rows(wrapper)[1]!.get('[data-testid="ingest-token-revoke"]').trigger('click');
      mockGetIngestTokens.mockResolvedValue([makeToken({ id: 'a' as RecordId, name: 'First' })]);
      await wrapper.get('[data-testid="revoke-confirm"]').trigger('click');
      await flushPromises();

      expect(mockRevokeIngestToken).toHaveBeenCalledWith({ id: 'b' });
      expect(mockAddSuccess).toHaveBeenCalledWith('Token revoked');
      expect(rows(wrapper)).toHaveLength(1);
      expect(wrapper.find('[data-testid="revoke-dialog"]').exists()).toBe(false);
    });

    it('revokes nothing when the confirmation is cancelled', async () => {
      const wrapper = await mountWithTokens([makeToken()]);

      await rows(wrapper)[0]!.get('[data-testid="ingest-token-revoke"]').trigger('click');
      await wrapper.get('[data-testid="revoke-cancel"]').trigger('click');

      expect(mockRevokeIngestToken).not.toHaveBeenCalled();
      expect(wrapper.find('[data-testid="revoke-dialog"]').exists()).toBe(false);
    });
  });
});
