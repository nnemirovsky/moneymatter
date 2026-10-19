import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import type { CreateCardPaymentSetupCodeResponse, IngestTokenDto, RecordId } from '@bt/shared/types';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import { useGenerateSetupCode } from './use-generate-setup-code';

const { mockCreateSetupCode, mockNotifyError } = vi.hoisted(() => ({
  mockCreateSetupCode: vi.fn(),
  mockNotifyError: vi.fn(),
}));

vi.mock('@/api/ingest', () => ({ createCardPaymentSetupCode: mockCreateSetupCode }));
vi.mock('@/composable/data-queries/use-invalidating-mutation', () => ({ notifyMutationError: mockNotifyError }));

const CODE = 'v1.SETUP-CODE-THAT-MUST-NOT-LINGER';

const TOKEN: IngestTokenDto = {
  id: 'token-1' as RecordId,
  name: 'Apple Pay shortcut',
  start: 'mm_ingest_SETU',
  scopes: ['ingest:transactions'],
  lastUsedAt: null,
  createdAt: '2026-10-18T10:00:00.000Z',
  expiresAt: null,
};

const RESPONSE: CreateCardPaymentSetupCodeResponse = { token: TOKEN, setupCode: CODE };

const PAYLOAD = { ingestUrl: 'https://money.example.com/api/v1/ingest/card-payment', revokePrevious: true };

const mountComposable = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

  let composable!: ReturnType<typeof useGenerateSetupCode>;
  const wrapper = mount(
    defineComponent({
      setup() {
        composable = useGenerateSetupCode();
        return () => null;
      },
    }),
    { global: { plugins: [[VueQueryPlugin, { queryClient }]] } },
  );

  return { composable, queryClient, invalidateQueries, wrapper };
};

/** Every cached mutation result and query value, flattened, to search for the code. */
const dumpCache = ({ queryClient }: { queryClient: QueryClient }) =>
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

const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useGenerateSetupCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSetupCode.mockResolvedValue(RESPONSE);
  });

  it('exposes no code before one is generated', () => {
    const { composable } = mountComposable();

    expect(composable.setupCode.value).toBeNull();
  });

  it('sends the payload, exposes the code and refreshes the token list', async () => {
    const { composable, invalidateQueries } = mountComposable();

    await composable.generate(PAYLOAD);
    await flushPromises();

    expect(mockCreateSetupCode).toHaveBeenCalledWith(PAYLOAD);
    expect(composable.setupCode.value).toBe(CODE);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.ingestTokens });
  });

  it('drops the code from state and from the query cache on clear', async () => {
    const { composable, queryClient } = mountComposable();
    await composable.generate(PAYLOAD);
    await flushPromises();
    expect(dumpCache({ queryClient })).toContain(CODE);

    composable.clear();
    await flushPromises();
    await nextMacrotask();

    expect(composable.setupCode.value).toBeNull();
    expect(dumpCache({ queryClient })).not.toContain(CODE);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('drops the code when the page that holds it is left', async () => {
    const { composable, queryClient, wrapper } = mountComposable();
    await composable.generate(PAYLOAD);
    await flushPromises();

    wrapper.unmount();
    await flushPromises();
    await nextMacrotask();

    expect(dumpCache({ queryClient })).not.toContain(CODE);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('keeps no code and reports the failure when the API refuses', async () => {
    mockCreateSetupCode.mockRejectedValue(new Error('boom'));
    const { composable } = mountComposable();

    await expect(composable.generate(PAYLOAD)).rejects.toThrow('boom');
    await flushPromises();

    expect(composable.setupCode.value).toBeNull();
    expect(mockNotifyError).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackKey: 'settings.integrations.applePay.setup.generateError' }),
    );
  });

  it('never writes the code to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const { composable } = mountComposable();

    await composable.generate(PAYLOAD);
    await flushPromises();
    composable.clear();

    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CODE);
      spy.mockRestore();
    }
  });
});
