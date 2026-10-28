import { VUE_QUERY_CACHE_KEYS } from '@/common/const';
import type { PayeeLookupItem } from '@bt/shared/types';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Ref, defineComponent, ref } from 'vue';

import { resetMissingPayeeAttempts, usePayeeLookup } from './payees';

const loadPayeeLookup = vi.fn();

vi.mock('@/api/payees', () => ({
  loadPayeeLookup: (...args: unknown[]) => loadPayeeLookup(...args),
  loadPayees: vi.fn(),
  loadPayeeById: vi.fn(),
  loadPayeesByAccount: vi.fn(),
}));

const payee = ({ id, name }: { id: string; name: string }): PayeeLookupItem =>
  ({ id, name, logoUrl: null }) as unknown as PayeeLookupItem;

const mountLookup = ({ ids }: { ids: Ref<Array<string | null>> }) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The lookup was loaded earlier and restored from storage: it is fresh as far as the cache knows.
  queryClient.setQueryData(VUE_QUERY_CACHE_KEYS.payeesLookup, [payee({ id: 'old', name: 'Old Shop' })]);
  let lookup!: ReturnType<typeof usePayeeLookup>;
  mount(
    defineComponent({
      setup() {
        lookup = usePayeeLookup({ referencedIds: () => ids.value });
        return () => null;
      },
    }),
    { global: { plugins: [[VueQueryPlugin, { queryClient }]] } },
  );
  return { lookup };
};

describe('usePayeeLookup referencedIds', () => {
  beforeEach(() => {
    loadPayeeLookup.mockReset();
    resetMissingPayeeAttempts();
  });

  it('refetches once when a row names a payee the cached lookup does not hold', async () => {
    loadPayeeLookup.mockResolvedValue([
      payee({ id: 'old', name: 'Old Shop' }),
      payee({ id: 'new', name: 'Cloudflare' }),
    ]);
    const { lookup } = mountLookup({ ids: ref(['old', 'new']) });

    await flushPromises();

    expect(loadPayeeLookup).toHaveBeenCalledTimes(1);
    expect(lookup.byId.value.get('new')?.name).toBe('Cloudflare');
  });

  it('does not refetch while every referenced payee is in the lookup', async () => {
    mountLookup({ ids: ref(['old', null]) });

    await flushPromises();

    expect(loadPayeeLookup).not.toHaveBeenCalled();
  });

  it('does not refetch in a loop for a payee that is still missing afterwards', async () => {
    loadPayeeLookup.mockResolvedValue([payee({ id: 'old', name: 'Old Shop' })]);
    mountLookup({ ids: ref(['gone']) });

    await flushPromises();
    await flushPromises();

    expect(loadPayeeLookup).toHaveBeenCalledTimes(1);
  });

  it('looks again for a still-missing payee once the retry delay has passed and the rows change', async () => {
    vi.useFakeTimers();
    try {
      loadPayeeLookup.mockResolvedValue([payee({ id: 'old', name: 'Old Shop' })]);
      const ids = ref<Array<string | null>>(['late']);
      mountLookup({ ids });
      await flushPromises();
      expect(loadPayeeLookup).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(11_000);
      ids.value = ['late', 'old'];
      await flushPromises();

      expect(loadPayeeLookup).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares the attempt between consumers, so two of them do not each refetch', async () => {
    loadPayeeLookup.mockResolvedValue([payee({ id: 'old', name: 'Old Shop' })]);
    mountLookup({ ids: ref(['gone']) });
    mountLookup({ ids: ref(['gone']) });

    await flushPromises();

    expect(loadPayeeLookup).toHaveBeenCalledTimes(1);
  });
});
