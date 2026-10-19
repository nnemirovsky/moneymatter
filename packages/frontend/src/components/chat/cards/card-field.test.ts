import type { ChatCardDependency, ChatCardField } from '@bt/shared/types';
import { RouterLinkStub, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import CardField from './card-field.vue';
import { buildField, buildLookups, createChatI18n } from './card-test-fixtures';

const mountField = ({
  field,
  currencyCode = null,
  dependsOn = [],
  names = {},
}: {
  field: ChatCardField;
  currencyCode?: string | null;
  dependsOn?: ChatCardDependency[];
  names?: Record<string, string>;
}) =>
  mount(CardField, {
    props: { field, currencyCode, dependsOn, lookups: buildLookups({ names }) },
    global: { plugins: [createChatI18n()], stubs: { RouterLink: RouterLinkStub } },
  });

describe('CardField', () => {
  it('shows the translated label and the value', () => {
    const wrapper = mountField({ field: buildField({ path: 'note', value: 'Lunch', display: { kind: 'text' } }) });

    expect(wrapper.text()).toContain('Note');
    expect(wrapper.text()).toContain('Lunch');
  });

  it('formats money with the currency', () => {
    const wrapper = mountField({
      field: buildField({ path: 'amount', value: 4.5, display: { kind: 'money' } }),
      currencyCode: 'USD',
    });

    expect(wrapper.text()).toContain('$4.50');
  });

  it('formats a date', () => {
    const wrapper = mountField({ field: buildField({ path: 'time', value: '2026-03-05', display: { kind: 'date' } }) });

    expect(wrapper.text()).toContain('Mar 5, 2026');
  });

  it('shows a boolean as yes or no', () => {
    expect(
      mountField({ field: buildField({ path: 'isPlanned', value: true, display: { kind: 'boolean' } }) }).text(),
    ).toContain('Yes');
    expect(
      mountField({ field: buildField({ path: 'isPlanned', value: false, display: { kind: 'boolean' } }) }).text(),
    ).toContain('No');
  });

  it('names an entity from the lookups', () => {
    const wrapper = mountField({
      field: buildField({
        path: 'categoryId',
        value: 'cat-1',
        display: { kind: 'entity' },
        editable: { type: 'entity', entity: 'category' },
      }),
      names: { 'category:cat-1': 'Groceries' },
    });

    expect(wrapper.text()).toContain('Groceries');
  });

  it('names every entity of a list', () => {
    const wrapper = mountField({
      field: buildField({
        path: 'tagIds',
        value: ['t1', 't2'],
        display: { kind: 'entity' },
        editable: { type: 'entity', entity: 'tag' },
      }),
      names: { 'tag:t1': 'Trip', 'tag:t2': 'Work' },
    });

    expect(wrapper.text()).toContain('Trip');
    expect(wrapper.text()).toContain('Work');
  });

  it('falls back to the entity kind when the name is not known', () => {
    const wrapper = mountField({
      field: buildField({
        path: 'budgetId',
        value: 'b1',
        display: { kind: 'entity' },
        editable: { type: 'entity', entity: 'budget' },
      }),
    });

    expect(wrapper.text()).toContain('Budget');
  });

  it('shows a ref to a pending card as a link to that card', () => {
    const wrapper = mountField({
      field: buildField({
        path: 'categoryId',
        value: '$proposal:p1',
        display: { kind: 'entity' },
        editable: { type: 'entity', entity: 'category' },
      }),
      dependsOn: [
        {
          id: 'p1',
          revision: 1,
          status: 'pending',
          title: { key: 'chat.cards.title.create', params: { entity: 'category' } },
        },
      ],
    });

    expect(wrapper.text()).toContain('From the card “Create category”');
  });

  it('shows before and after for an update', () => {
    const wrapper = mountField({
      field: buildField({ path: 'note', value: 'Dinner', before: 'Lunch', display: { kind: 'text' } }),
    });

    expect(wrapper.find('[data-testid="field-before"]').text()).toContain('Was Lunch');
    expect(wrapper.find('[data-testid="field-value"]').text()).toBe('Dinner');
  });

  it('does not show a before value when there is none', () => {
    const wrapper = mountField({ field: buildField({ path: 'note', value: 'Dinner', display: { kind: 'text' } }) });

    expect(wrapper.find('[data-testid="field-before"]').exists()).toBe(false);
  });

  it('renders markup in a value as text', () => {
    const wrapper = mountField({
      field: buildField({ path: 'note', value: '<b onclick="x()">hi</b>', display: { kind: 'text' } }),
    });

    expect(wrapper.find('b').exists()).toBe(false);
    expect(wrapper.text()).toContain('<b onclick="x()">hi</b>');
  });

  describe('uncertain field', () => {
    const uncertain = buildField({
      path: 'categoryId',
      value: 'cat-1',
      display: { kind: 'entity' },
      editable: { type: 'entity', entity: 'category' },
      uncertain: { reason: 'guessedFromHistory', alternatives: ['cat-2', 'cat-3'] },
    });
    const names = { 'category:cat-1': 'Groceries', 'category:cat-2': 'Dining', 'category:cat-3': 'Fuel' };

    it('highlights the field with the reason', () => {
      const wrapper = mountField({ field: uncertain, names });

      expect(wrapper.find('[data-testid="uncertain"]').exists()).toBe(true);
      expect(wrapper.text()).toContain('Guessed from your history');
    });

    it('offers each alternative as a one-tap choice', async () => {
      const wrapper = mountField({ field: uncertain, names });
      const choices = wrapper.findAll('[data-testid="alternative"]');

      expect(choices.map((choice) => choice.text())).toEqual(['Dining', 'Fuel']);

      await choices[0]!.trigger('click');

      expect(wrapper.emitted('choose')).toEqual([['cat-2']]);
    });

    it('does not mark a certain field', () => {
      const wrapper = mountField({ field: buildField({ path: 'note', value: 'x', display: { kind: 'text' } }) });

      expect(wrapper.find('[data-testid="uncertain"]').exists()).toBe(false);
    });

    it('disables the choices when the card cannot be changed', () => {
      const wrapper = mount(CardField, {
        props: {
          field: uncertain,
          currencyCode: null,
          dependsOn: [],
          lookups: buildLookups({ names }),
          disabled: true,
        },
        global: { plugins: [createChatI18n()], stubs: { RouterLink: RouterLinkStub } },
      });

      expect(wrapper.find('[data-testid="alternative"]').attributes('disabled')).toBeDefined();
    });
  });
});
