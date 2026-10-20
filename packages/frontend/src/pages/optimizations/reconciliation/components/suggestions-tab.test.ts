import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';

import { useDuplicateSuggestions, useReconciliationActions } from '../use-reconciliation';
import SuggestionsTab from './suggestions-tab.vue';
import { buildId, buildSuggestion, buildTransaction, createReconciliationI18n } from './test-fixtures';

vi.mock('../use-reconciliation', () => ({
  useDuplicateSuggestions: vi.fn(),
  useReconciliationActions: vi.fn(),
}));

const state = {
  data: ref<ReturnType<typeof buildSuggestion>[] | undefined>(undefined),
  isFetched: ref(false),
  isError: ref(false),
};
const refetch = vi.fn();
const dismissMutate = vi.fn();
const dismissVariables = ref<{ suggestionId: string } | undefined>(undefined);
const dismissPending = ref(false);

// The dialog is covered by its own suite; here it only reports what the tab hands it.
const MergeDialogStub = defineComponent({
  props: ['open', 'transactions', 'defaultSurvivorId'],
  emits: ['update:open'],
  setup: (props) => () =>
    h('div', {
      'data-testid': 'merge-dialog',
      'data-open': String(props.open),
      'data-ids': props.transactions.map((tx: { id: string }) => tx.id).join(','),
      'data-survivor': String(props.defaultSurvivorId),
    }),
});
const CardStub = defineComponent({
  props: ['suggestion', 'isDismissing'],
  emits: ['merge', 'dismiss'],
  setup:
    (props, { emit }) =>
    () =>
      h(
        'div',
        { 'data-testid': 'card', 'data-id': props.suggestion.id, 'data-dismissing': String(props.isDismissing) },
        [
          h('button', { 'data-testid': `merge-${props.suggestion.id}`, onClick: () => emit('merge') }),
          h('button', { 'data-testid': `dismiss-${props.suggestion.id}`, onClick: () => emit('dismiss') }),
        ],
      ),
});

const mountTab = () =>
  mount(SuggestionsTab, {
    global: {
      plugins: [createReconciliationI18n()],
      stubs: {
        MergeDialog: MergeDialogStub,
        SuggestionCard: CardStub,
        ScrollArea: { template: '<div><slot /></div>' },
      },
    },
  });

describe('SuggestionsTab', () => {
  beforeEach(() => {
    refetch.mockReset();
    dismissMutate.mockReset();
    state.data.value = undefined;
    state.isFetched.value = false;
    state.isError.value = false;
    dismissVariables.value = undefined;
    dismissPending.value = false;
    vi.mocked(useDuplicateSuggestions).mockReturnValue({
      data: state.data,
      isFetched: state.isFetched,
      isError: state.isError,
      refetch,
    } as unknown as ReturnType<typeof useDuplicateSuggestions>);
    vi.mocked(useReconciliationActions).mockReturnValue({
      dismissSuggestion: { mutate: dismissMutate, isPending: dismissPending, variables: dismissVariables },
    } as unknown as ReturnType<typeof useReconciliationActions>);
  });

  it('shows a skeleton until the first answer', () => {
    const wrapper = mountTab();

    expect(wrapper.find('[data-testid="suggestions-skeleton"]').exists()).toBe(true);
  });

  it('shows the empty state when nothing is suggested', () => {
    state.isFetched.value = true;
    state.data.value = [];

    const wrapper = mountTab();

    expect(wrapper.find('[data-testid="suggestions-empty"]').text()).toContain('No suggestions right now');
    expect(wrapper.find('[data-testid="card"]').exists()).toBe(false);
  });

  it('offers a retry when the list cannot load', async () => {
    state.isError.value = true;

    const wrapper = mountTab();
    await wrapper.find('button').trigger('click');

    expect(wrapper.text()).toContain("Couldn't load the suggestions.");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('lists a card per suggestion', () => {
    state.isFetched.value = true;
    state.data.value = [buildSuggestion({ id: buildId('sug-1') }), buildSuggestion({ id: buildId('sug-2') })];

    const wrapper = mountTab();

    expect(wrapper.findAll('[data-testid="card"]').map((item) => item.attributes('data-id'))).toEqual([
      'sug-1',
      'sug-2',
    ]);
  });

  it('opens the existing merge dialog with the pair and the suggested survivor', async () => {
    state.isFetched.value = true;
    state.data.value = [
      buildSuggestion({
        id: buildId('sug-1'),
        transaction: buildTransaction({ id: buildId('tx-a') }),
        candidate: buildTransaction({ id: buildId('tx-b') }),
        suggestedSurvivorId: buildId('tx-b'),
      }),
    ];
    const wrapper = mountTab();
    expect(wrapper.find('[data-testid="merge-dialog"]').attributes('data-open')).toBe('false');

    await wrapper.find('[data-testid="merge-sug-1"]').trigger('click');
    await flushPromises();

    const dialog = wrapper.find('[data-testid="merge-dialog"]');
    expect(dialog.attributes('data-open')).toBe('true');
    expect(dialog.attributes('data-ids')).toBe('tx-a,tx-b');
    expect(dialog.attributes('data-survivor')).toBe('tx-b');
  });

  it('marks a suggestion as not duplicates', async () => {
    state.isFetched.value = true;
    state.data.value = [buildSuggestion({ id: buildId('sug-1') })];

    await mountTab().find('[data-testid="dismiss-sug-1"]').trigger('click');

    expect(dismissMutate).toHaveBeenCalledWith({ suggestionId: 'sug-1' });
  });

  it('marks only the dismissed card as busy', () => {
    state.isFetched.value = true;
    state.data.value = [buildSuggestion({ id: buildId('sug-1') }), buildSuggestion({ id: buildId('sug-2') })];
    dismissPending.value = true;
    dismissVariables.value = { suggestionId: 'sug-2' };

    const wrapper = mountTab();

    expect(wrapper.findAll('[data-testid="card"]').map((item) => item.attributes('data-dismissing'))).toEqual([
      'false',
      'true',
    ]);
  });
});
