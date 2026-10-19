import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import type { CreateIngestTokenResponse, IngestTokenDto, RecordId } from '@bt/shared/types';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import { useCreateIngestToken } from './use-create-ingest-token';

const { mockCreateIngestToken, mockNotifyError } = vi.hoisted(() => ({
  mockCreateIngestToken: vi.fn(),
  mockNotifyError: vi.fn(),
}));

vi.mock('@/api/ingest', () => ({ createIngestToken: mockCreateIngestToken }));
vi.mock('@/composable/data-queries/use-invalidating-mutation', () => ({ notifyMutationError: mockNotifyError }));

const SECRET = 'mm_ingest_SECRET-VALUE-THAT-MUST-NOT-LINGER';

const TOKEN: IngestTokenDto = {
  id: 'token-1' as RecordId,
  name: 'iPhone shortcut',
  start: 'mm_ingest_SECR',
  scopes: ['ingest:transactions'],
  lastUsedAt: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  expiresAt: null,
};

const RESPONSE: CreateIngestTokenResponse = { token: TOKEN, secret: SECRET };

const mountComposable = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

  let composable!: ReturnType<typeof useCreateIngestToken>;
  mount(
    defineComponent({
      setup() {
        composable = useCreateIngestToken();
        return () => null;
      },
    }),
    { global: { plugins: [[VueQueryPlugin, { queryClient }]] } },
  );

  return { composable, queryClient, invalidateQueries };
};

/** Every cached mutation result and query value, flattened, to search for the secret. */
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

describe('useCreateIngestToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateIngestToken.mockResolvedValue(RESPONSE);
  });

  it('exposes no secret before a token is created', () => {
    const { composable } = mountComposable();

    expect(composable.secret.value).toBeNull();
  });

  it('sends the payload, exposes the secret once created and refreshes the token list', async () => {
    const { composable, invalidateQueries } = mountComposable();

    await composable.createToken({ name: 'iPhone shortcut', expiresInDays: 30 });
    await flushPromises();

    expect(mockCreateIngestToken).toHaveBeenCalledWith({ name: 'iPhone shortcut', expiresInDays: 30 });
    expect(composable.secret.value).toBe(SECRET);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: VUE_QUERY_CACHE_KEYS.ingestTokens });
  });

  it('drops the secret from state and from the query cache on clear', async () => {
    const { composable, queryClient } = mountComposable();
    await composable.createToken({ name: 'iPhone shortcut' });
    await flushPromises();
    expect(dumpCache({ queryClient })).toContain(SECRET);

    composable.clear();
    await flushPromises();
    await nextMacrotask();

    expect(composable.secret.value).toBeNull();
    expect(dumpCache({ queryClient })).not.toContain(SECRET);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('keeps no secret and reports the failure when the API refuses', async () => {
    mockCreateIngestToken.mockRejectedValue(new Error('boom'));
    const { composable } = mountComposable();

    await expect(composable.createToken({ name: 'iPhone shortcut' })).rejects.toThrow('boom');
    await flushPromises();

    expect(composable.secret.value).toBeNull();
    expect(mockNotifyError).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackKey: 'settings.integrations.ingestTokens.create.error' }),
    );
  });

  it('replaces the previous secret when a second token is created without clearing', async () => {
    const SECOND_SECRET = 'mm_ingest_SECOND';
    const { composable, queryClient } = mountComposable();
    await composable.createToken({ name: 'First' });
    mockCreateIngestToken.mockResolvedValue({ token: TOKEN, secret: SECOND_SECRET });
    await composable.createToken({ name: 'Second' });
    await flushPromises();
    await nextMacrotask();

    expect(composable.secret.value).toBe(SECOND_SECRET);
    expect(dumpCache({ queryClient })).not.toContain(SECRET);
  });
});
