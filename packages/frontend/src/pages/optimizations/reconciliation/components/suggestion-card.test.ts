import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import SuggestionCard from './suggestion-card.vue';
import { buildId, buildSuggestion, buildTransaction, createReconciliationI18n } from './test-fixtures';

const RecordStub = {
  props: ['tx'],
  template: '<div data-testid="record" :data-id="tx.id" />',
};

const mountCard = ({ suggestion = buildSuggestion(), isDismissing = false } = {}) =>
  mount(SuggestionCard, {
    props: { suggestion, isDismissing },
    global: { plugins: [createReconciliationI18n()], stubs: { TransactionRecord: RecordStub } },
  });

describe('SuggestionCard', () => {
  it('shows both payments of the pair', () => {
    const wrapper = mountCard();

    expect(wrapper.findAll('[data-testid="record"]').map((item) => item.attributes('data-id'))).toEqual([
      'tx-a',
      'tx-b',
    ]);
  });

  it('shows the confidence as a percentage and the reason', () => {
    const wrapper = mountCard();

    expect(wrapper.find('[data-testid="suggestion-confidence"]').text()).toBe('92% match');
    expect(wrapper.find('[data-testid="suggestion-reason"]').text()).toBe('Same amount and shop, two minutes apart');
  });

  it('leaves the reason out when the judge gave none', () => {
    expect(
      mountCard({ suggestion: buildSuggestion({ reason: null }) })
        .find('[data-testid="suggestion-reason"]')
        .exists(),
    ).toBe(false);
  });

  it('names the sources each side holds, with the stage of a bank notification', () => {
    const sides = mountCard().findAll('[data-testid="suggestion-side"]');

    expect(sides[0]!.find('[data-testid="suggestion-sources"]').text()).toBe('Wallet notification');
    expect(sides[1]!.find('[data-testid="suggestion-sources"]').text()).toContain('Bank notification');
    expect(sides[1]!.find('[data-testid="suggestion-sources"]').text()).toContain('settlement');
  });

  it('shows no source list for a row entered by hand or synced', () => {
    const wrapper = mountCard({
      suggestion: buildSuggestion({
        transaction: buildTransaction({ id: buildId('tx-a') }),
        transactionSlots: [],
        candidateSlots: [],
      }),
    });

    expect(wrapper.find('[data-testid="suggestion-sources"]').exists()).toBe(false);
  });

  it('asks for a merge or a dismissal', async () => {
    const wrapper = mountCard();

    await wrapper.find('[data-testid="suggestion-merge"]').trigger('click');
    await wrapper.find('[data-testid="suggestion-dismiss"]').trigger('click');

    expect(wrapper.emitted('merge')).toHaveLength(1);
    expect(wrapper.emitted('dismiss')).toHaveLength(1);
  });

  it('holds both buttons while the dismissal runs', () => {
    const wrapper = mountCard({ isDismissing: true });

    expect(wrapper.find('[data-testid="suggestion-merge"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="suggestion-dismiss"]').attributes('disabled')).toBeDefined();
  });

  it('warns instead of informing when the judge was unsure', () => {
    const wrapper = mountCard({ suggestion: buildSuggestion({ confidence: 0.62 }) });

    expect(wrapper.find('[data-testid="suggestion-confidence"]').text()).toBe('62% match');
    expect(wrapper.find('[data-testid="suggestion-confidence"]').classes().join(' ')).toContain('warning');
  });
});
