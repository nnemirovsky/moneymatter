import { usePayeesByIds } from '@/composable/data-queries/payees';
import type { ChatCardField } from '@bt/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, toValue } from 'vue';

import { buildCard, buildField } from './card-test-fixtures';
import { useCardLookups } from './use-card-lookups';

vi.mock('@/composable/data-queries/payees', () => ({ usePayeesByIds: vi.fn() }));
// The stores are not under test: each hands back the refs the lookups read.
vi.mock('pinia', () => ({ storeToRefs: (store: unknown) => store }));
vi.mock('@/stores/accounts', () => ({
  useAccountsStore: () => ({ accountsRecord: ref({}), systemAccounts: ref([]) }),
}));
vi.mock('@/stores/categories/categories', () => ({
  useCategoriesStore: () => ({ categoriesMap: ref({}), formattedCategories: ref([]) }),
}));
vi.mock('@/stores/tags', () => ({ useTagsStore: () => ({ tagsMap: ref({}) }) }));
vi.mock('@/stores/currencies', () => ({
  useCurrenciesStore: () => ({ baseCurrency: ref(null), currencies: ref([]) }),
}));

const entityField = ({ path, id, kind }: { path: string; id: string; kind: 'payee' | 'account' }): ChatCardField =>
  buildField({ path, value: id, display: { kind: 'entity', entity: { kind, id, label: '' } } });

describe('useCardLookups', () => {
  beforeEach(() => {
    vi.mocked(usePayeesByIds).mockReturnValue({ byId: ref(new Map()) } as never);
  });

  it('fetches the payees of the fields and of the target record', () => {
    const card = buildCard({
      fields: [entityField({ path: 'payeeId', id: 'payee-new', kind: 'payee' })],
      target: [
        entityField({ path: 'payeeId', id: 'payee-target', kind: 'payee' }),
        entityField({ path: 'accountId', id: 'acc-1', kind: 'account' }),
      ],
    });

    useCardLookups({ card });

    const { ids } = vi.mocked(usePayeesByIds).mock.calls.at(-1)![0];
    expect([...toValue(ids)].toSorted()).toEqual(['payee-new', 'payee-target']);
  });

  it('fetches the payee of a delete card whose only mention is its target', () => {
    const card = buildCard({
      kind: 'delete',
      fields: [buildField({ path: 'id', value: 'tx-1', display: { kind: 'text' } })],
      target: [entityField({ path: 'payeeId', id: 'payee-target', kind: 'payee' })],
    });

    useCardLookups({ card });

    expect(toValue(vi.mocked(usePayeesByIds).mock.calls.at(-1)![0].ids)).toEqual(['payee-target']);
  });

  it('fetches the payees the alternatives of an uncertain field point to', () => {
    const card = buildCard({
      fields: [
        {
          ...entityField({ path: 'payeeId', id: 'payee-main', kind: 'payee' }),
          uncertain: { reason: 'ambiguousMatch', alternatives: ['payee-alt-1', 'payee-alt-2'] },
        },
      ],
    });

    useCardLookups({ card });

    expect([...toValue(vi.mocked(usePayeesByIds).mock.calls.at(-1)![0].ids)].toSorted()).toEqual([
      'payee-alt-1',
      'payee-alt-2',
      'payee-main',
    ]);
  });
});
