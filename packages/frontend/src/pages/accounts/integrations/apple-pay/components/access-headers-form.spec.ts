import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import type { AccessHeadersStatusDto } from '@bt/shared/types';
import { type VueWrapper, flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createGlobalPlugins } from '../test-support';
import AccessHeadersForm from './access-headers-form.vue';

const { mockGetHeaders, mockSetHeaders, mockAddSuccess, mockNotifyError } = vi.hoisted(() => ({
  mockGetHeaders: vi.fn(),
  mockSetHeaders: vi.fn(),
  mockAddSuccess: vi.fn(),
  mockNotifyError: vi.fn(),
}));

vi.mock('@/api/ingest', () => ({ getAccessHeaders: mockGetHeaders, setAccessHeaders: mockSetHeaders }));
vi.mock('@/composable/data-queries/use-invalidating-mutation', () => ({ notifyMutationError: mockNotifyError }));
vi.mock('@/components/notification-center', () => ({
  useNotificationCenter: () => ({ addSuccessNotification: mockAddSuccess }),
}));

const NOT_CONFIGURED: AccessHeadersStatusDto = { configured: false, clientIdHint: null };
const CONFIGURED: AccessHeadersStatusDto = { configured: true, clientIdHint: '…a1b2' };
const SECRET = 'cf-secret-THAT-MUST-NOT-LINGER';

const mountForm = async (status: AccessHeadersStatusDto, { expanded = true }: { expanded?: boolean } = {}) => {
  mockGetHeaders.mockResolvedValue(status);
  const { queryClient, plugins } = createGlobalPlugins();
  const wrapper = mount(AccessHeadersForm, { global: { plugins }, attachTo: document.body });
  await flushPromises();
  if (expanded) await expand(wrapper);
  return { wrapper, queryClient };
};

const expand = async (wrapper: VueWrapper) => {
  await wrapper.get('[data-testid="access-headers-toggle"]').trigger('click');
  await flushPromises();
};

const input = (wrapper: VueWrapper, testId: string) =>
  wrapper.get(`[data-testid="${testId}"] input, input[data-testid="${testId}"]`);
const fill = async (wrapper: VueWrapper, { id, secret }: { id: string; secret: string }) => {
  await input(wrapper, 'access-headers-client-id').setValue(id);
  await input(wrapper, 'access-headers-client-secret').setValue(secret);
};
const submit = async (wrapper: VueWrapper) => {
  await wrapper.get('form').trigger('submit');
  await flushPromises();
};

describe('AccessHeadersForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetHeaders.mockResolvedValue(CONFIGURED);
  });

  it('starts folded, with only the title and a state hint, even when headers are stored', async () => {
    const { wrapper } = await mountForm(CONFIGURED, { expanded: false });

    expect(wrapper.text()).toContain('Cloudflare Access (optional)');
    expect(wrapper.get('[data-testid="access-headers-status"]').text()).toBe('Configured');
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('CF-Access-Client-Id');

    await expand(wrapper);

    expect(wrapper.find('form').exists()).toBe(true);
  });

  it('explains what the fields are for and that they are optional', async () => {
    const { wrapper } = await mountForm(NOT_CONFIGURED);

    expect(wrapper.text()).toContain('Cloudflare Access (optional)');
    expect(wrapper.text()).toContain('CF-Access-Client-Id');
    expect(wrapper.text()).toContain('If nothing protects your instance, leave both empty.');
  });

  it('says the headers are not set', async () => {
    const { wrapper } = await mountForm(NOT_CONFIGURED);

    expect(wrapper.get('[data-testid="access-headers-status"]').text()).toBe('Not set');
    expect(wrapper.find('[data-testid="access-headers-remove"]').exists()).toBe(false);
  });

  it('shows stored state as placeholders and keeps the secret field write-only', async () => {
    const { wrapper } = await mountForm(CONFIGURED);

    expect(input(wrapper, 'access-headers-client-id').attributes('placeholder')).toBe(
      'Stored (…a1b2). Enter a new ID to replace it',
    );
    const secretField = input(wrapper, 'access-headers-client-secret');
    expect(secretField.attributes('type')).toBe('password');
    expect((secretField.element as HTMLInputElement).value).toBe('');
    expect(secretField.attributes('placeholder')).toBe('Stored. Enter a new secret to replace it');
  });

  it('saves both values trimmed and clears the fields', async () => {
    const { wrapper, queryClient } = await mountForm(NOT_CONFIGURED);

    await fill(wrapper, { id: '  abc.access  ', secret: `  ${SECRET}  ` });
    await submit(wrapper);

    expect(mockSetHeaders).toHaveBeenCalledWith({ clientId: 'abc.access', clientSecret: SECRET });
    expect((input(wrapper, 'access-headers-client-secret').element as HTMLInputElement).value).toBe('');
    expect((input(wrapper, 'access-headers-client-id').element as HTMLInputElement).value).toBe('');
    expect(queryClient.getQueryData(VUE_QUERY_CACHE_KEYS.cardPaymentAccessHeaders)).toEqual(CONFIGURED);
    expect(mockAddSuccess).toHaveBeenCalledWith('Cloudflare Access headers saved');
  });

  it('refuses one value without the other, since the server stores them as a pair', async () => {
    const { wrapper } = await mountForm(NOT_CONFIGURED);

    await fill(wrapper, { id: 'abc.access', secret: '' });
    await submit(wrapper);

    expect(mockSetHeaders).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="access-headers-form-error"]').text()).toBe(
      'Enter both the Client ID and the Client secret, or leave both empty.',
    );
  });

  it('removes the stored pair', async () => {
    const { wrapper } = await mountForm(CONFIGURED);

    await wrapper.get('[data-testid="access-headers-remove"]').trigger('click');
    await flushPromises();

    expect(mockSetHeaders).toHaveBeenCalledWith({ clientId: null, clientSecret: null });
    expect(mockAddSuccess).toHaveBeenCalledWith('Cloudflare Access headers removed');
  });

  it('keeps no secret in the query or mutation cache after saving', async () => {
    const { wrapper, queryClient } = await mountForm(NOT_CONFIGURED);

    await fill(wrapper, { id: 'abc.access', secret: SECRET });
    await submit(wrapper);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state.variables),
      ),
    ).not.toContain(SECRET);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('reports a failed save and keeps what was typed', async () => {
    mockSetHeaders.mockRejectedValue(new Error('boom'));
    const { wrapper } = await mountForm(NOT_CONFIGURED);

    await fill(wrapper, { id: 'abc.access', secret: SECRET });
    await submit(wrapper);

    expect(mockNotifyError).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackKey: 'settings.integrations.applePay.accessHeaders.saveError' }),
    );
    expect((input(wrapper, 'access-headers-client-id').element as HTMLInputElement).value).toBe('abc.access');
    expect(mockAddSuccess).not.toHaveBeenCalled();
  });

  it('shows an error when the status cannot be loaded', async () => {
    mockGetHeaders.mockRejectedValue(new Error('boom'));
    const wrapper = mount(AccessHeadersForm, {
      global: { plugins: createGlobalPlugins().plugins },
      attachTo: document.body,
    });
    await flushPromises();
    await expand(wrapper);

    expect(wrapper.find('[data-testid="access-headers-error"]').exists()).toBe(true);
  });
});
