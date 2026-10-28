import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { createI18n } from 'vue-i18n';

import PayeeSelectField from './payee-select-field.vue';

const lookup = ref(new Map<string, { id: string; name: string }>());
const lookupLoaded = ref(true);
const fetched = ref<{ id: string; name: string } | undefined>(undefined);
const usePayeeById = vi.fn();
const useLookup = vi.fn();

vi.mock('@/composable/data-queries/payees', () => ({
  usePayeeLookup: (...args: unknown[]) => useLookup(...args),
  usePayee: (...args: unknown[]) => usePayeeById(...args),
  usePayees: () => ({ list: computed(() => []), isFetching: ref(false) }),
  useAccountPayees: () => ({ list: computed(() => []), isFetching: ref(false) }),
}));
vi.mock('@/components/common/brand-logo.vue', () => ({ default: { template: '<i data-testid="logo" />' } }));
vi.mock('@/pages/settings/subpages/payees/components/payee-form-dialog.vue', () => ({
  default: { template: '<i />' },
}));

const mountField = ({ modelValue }: { modelValue: string | null }) =>
  mount(PayeeSelectField, {
    props: { modelValue },
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale: 'en',
          messages: { en: { fields: { payeeSelect: { placeholder: 'Select a payee' } } } },
          missingWarn: false,
        }),
      ],
    },
  });

describe('PayeeSelectField', () => {
  beforeEach(() => {
    lookup.value = new Map();
    lookupLoaded.value = true;
    fetched.value = undefined;
    useLookup.mockReset();
    usePayeeById.mockReset();
    useLookup.mockImplementation(() => ({ byId: lookup, isSuccess: lookupLoaded }));
    usePayeeById.mockImplementation(({ enabled }: { enabled: { value: boolean } }) => ({
      data: computed(() => (enabled.value ? fetched.value : undefined)),
    }));
  });

  it('names the payee from the lookup', () => {
    lookup.value = new Map([['p1', { id: 'p1', name: 'Waffle cafe' }]]);

    expect(mountField({ modelValue: 'p1' }).get('[data-test="payee-select-field"]').text()).toContain('Waffle cafe');
  });

  it('names a payee the loaded lookup does not hold, by reading it on its own, instead of the placeholder', () => {
    fetched.value = { id: 'p-new', name: 'Cloudflare' };

    const text = mountField({ modelValue: 'p-new' }).get('[data-test="payee-select-field"]').text();

    expect(text).toContain('Cloudflare');
    expect(text).not.toContain('Select a payee');
  });

  it('asks the lookup to keep an eye on the payee it shows, so the lookup refreshes when it lacks it', () => {
    mountField({ modelValue: 'p-new' });

    const { referencedIds } = useLookup.mock.calls[0]![0] as { referencedIds: () => unknown[] };
    expect(referencedIds()).toEqual(['p-new']);
  });

  it('does not read a payee on its own while the lookup is still loading or when it holds it', () => {
    lookupLoaded.value = false;
    mountField({ modelValue: 'p-new' });
    expect((usePayeeById.mock.calls[0]![0] as { enabled: { value: boolean } }).enabled.value).toBe(false);

    lookupLoaded.value = true;
    lookup.value = new Map([['p-new', { id: 'p-new', name: 'Cloudflare' }]]);
    mountField({ modelValue: 'p-new' });
    expect((usePayeeById.mock.calls[1]![0] as { enabled: { value: boolean } }).enabled.value).toBe(false);
  });

  it('shows the placeholder when no payee is chosen', () => {
    expect(mountField({ modelValue: null }).get('[data-test="payee-select-field"]').text()).toContain('Select a payee');
  });
});
