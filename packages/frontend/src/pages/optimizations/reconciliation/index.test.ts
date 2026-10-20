import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive, ref } from 'vue';

import { createReconciliationI18n } from './components/test-fixtures';
import ReconciliationPage from './index.vue';
import { useDuplicateSuggestions, useStuckPending } from './use-reconciliation';

const route = reactive<{ query: Record<string, unknown> }>({ query: {} });
const replace = vi.fn();
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }));
vi.mock('@/routes', () => ({ ROUTES_NAMES: { optimizations: 'optimizations' } }));
vi.mock('./use-reconciliation', () => ({ useStuckPending: vi.fn(), useDuplicateSuggestions: vi.fn() }));
vi.mock('@vueuse/core', () => ({ useElementSize: () => ({ width: ref(1000) }) }));

const mountPage = () =>
  mount(ReconciliationPage, {
    global: {
      plugins: [createReconciliationI18n()],
      stubs: {
        TransactionsTab: { template: '<div data-testid="transactions-tab" />' },
        SuggestionsTab: { template: '<div data-testid="suggestions-tab" />' },
        StuckPendingTab: { template: '<div data-testid="stuck-tab" />' },
        HistoryTab: { template: '<div data-testid="history-tab" />' },
        RouterLink: { template: '<a><slot /></a>' },
        DesktopOnlyTooltip: { template: '<div><slot /></div>' },
      },
    },
  });

describe('Reconciliation page tabs', () => {
  beforeEach(() => {
    route.query = {};
    replace.mockReset();
    vi.mocked(useStuckPending).mockReturnValue({ data: ref([]) } as unknown as ReturnType<typeof useStuckPending>);
    vi.mocked(useDuplicateSuggestions).mockReturnValue({ data: ref([]) } as unknown as ReturnType<
      typeof useDuplicateSuggestions
    >);
  });

  it('badges the Suggestions tab with the number of open suggestions', () => {
    vi.mocked(useDuplicateSuggestions).mockReturnValue({
      data: ref([{ id: 'a' }, { id: 'b' }]),
    } as unknown as ReturnType<typeof useDuplicateSuggestions>);

    const badge = mountPage().find('[data-testid="suggestions-badge"]');

    expect(badge.text()).toBe('2');
  });

  it('shows no badge when nothing is suggested', () => {
    expect(mountPage().find('[data-testid="suggestions-badge"]').exists()).toBe(false);
  });

  it('opens the Suggestions tab from the address, for the link in an inbox card', () => {
    route.query = { tab: 'suggestions' };

    const wrapper = mountPage();

    expect(wrapper.find('[data-testid="suggestions-tab"]').exists()).toBe(true);
  });
});
