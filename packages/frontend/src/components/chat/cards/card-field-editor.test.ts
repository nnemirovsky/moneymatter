import AccountSelectField from '@/components/fields/account-select-field.vue';
import CategorySelectField from '@/components/fields/category-select-field.vue';
import DateField from '@/components/fields/date-field.vue';
import FormattedAmountField from '@/components/fields/formatted-amount-field.vue';
import InputField from '@/components/fields/input-field.vue';
import PayeeSelectField from '@/components/fields/payee-select-field.vue';
import SelectField from '@/components/fields/select-field.vue';
import TagSelectField from '@/components/fields/tag-select-field.vue';
import { Checkbox } from '@/components/lib/ui/checkbox';
import type { ChatCardField } from '@bt/shared/types';
import { type VueWrapper, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { DefineComponent } from 'vue';

import CardFieldEditor from './card-field-editor.vue';
import { buildField, buildLookups, createChatI18n } from './card-test-fixtures';

/** SelectField is generic, so the wrapper helpers do not type its props; this one does. */
const selectProps = ({ wrapper }: { wrapper: VueWrapper }): Record<string, unknown> =>
  wrapper.findComponent(SelectField as unknown as DefineComponent).props();

const mountEditor = ({ field, modelValue }: { field: ChatCardField; modelValue: unknown }) =>
  mount(CardFieldEditor, {
    props: { field, modelValue, lookups: buildLookups() },
    global: {
      plugins: [createChatI18n()],
      stubs: {
        AccountSelectField: true,
        CategorySelectField: true,
        PayeeSelectField: true,
        TagSelectField: true,
        DateField: true,
        SelectField: true,
      },
    },
  });

describe('CardFieldEditor', () => {
  it('edits text in an input field with a placeholder', () => {
    const wrapper = mountEditor({
      field: buildField({ path: 'note', editable: { type: 'text' } }),
      modelValue: 'Lunch',
    });
    const input = wrapper.findComponent(InputField);

    expect(input.exists()).toBe(true);
    expect(input.props('placeholder')).toBe('Enter a value');
    expect(input.props('modelValue')).toBe('Lunch');
  });

  it('passes the typed text up', async () => {
    const wrapper = mountEditor({
      field: buildField({ path: 'note', editable: { type: 'text' } }),
      modelValue: 'Lunch',
    });

    wrapper.findComponent(InputField).vm.$emit('update:modelValue', 'Dinner');

    expect(wrapper.emitted('update:modelValue')).toEqual([['Dinner']]);
  });

  it('edits a number in a number input', () => {
    const wrapper = mountEditor({
      field: buildField({ path: 'termMonths', editable: { type: 'number' } }),
      modelValue: 12,
    });
    const input = wrapper.findComponent(InputField);

    expect(input.props('type')).toBe('number');
    expect(input.props('placeholder')).toBe('Enter a number');
  });

  it('edits money in a formatted amount field', () => {
    const wrapper = mountEditor({
      field: buildField({ path: 'amount', editable: { type: 'money' } }),
      modelValue: 4.5,
    });
    const amount = wrapper.findComponent(FormattedAmountField);

    expect(amount.exists()).toBe(true);
    expect(amount.props('modelValue')).toBe(4.5);
    expect(amount.props('placeholder')).toBe('Enter an amount');
  });

  it('edits a date in a date field and sends a yyyy-MM-dd string', () => {
    const wrapper = mountEditor({
      field: buildField({ path: 'time', editable: { type: 'date' } }),
      modelValue: '2026-03-05',
    });
    const date = wrapper.findComponent(DateField);

    expect(date.exists()).toBe(true);
    date.vm.$emit('update:modelValue', new Date(2026, 2, 9));

    expect(wrapper.emitted('update:modelValue')).toEqual([['2026-03-09']]);
  });

  it('edits a date and time and sends an ISO string', () => {
    const wrapper = mountEditor({
      field: buildField({ path: 'time', editable: { type: 'datetime' } }),
      modelValue: '2026-03-05T10:00:00.000Z',
    });
    const when = new Date('2026-03-09T08:30:00.000Z');

    wrapper.findComponent(DateField).vm.$emit('update:modelValue', when);

    expect(wrapper.emitted('update:modelValue')).toEqual([['2026-03-09T08:30:00.000Z']]);
  });

  it('edits an enum in a select field over its options', () => {
    const wrapper = mountEditor({
      field: buildField({ path: 'transactionType', editable: { type: 'enum', options: ['income', 'expense'] } }),
      modelValue: 'expense',
    });
    const select = selectProps({ wrapper });

    expect(select.values).toEqual([
      { value: 'income', label: 'income' },
      { value: 'expense', label: 'expense' },
    ]);
    expect(select.modelValue).toEqual({ value: 'expense', label: 'expense' });
  });

  it('edits a boolean in a checkbox', () => {
    const wrapper = mountEditor({
      field: buildField({ path: 'isPlanned', editable: { type: 'boolean' } }),
      modelValue: false,
    });
    const checkbox = wrapper.findComponent(Checkbox);

    expect(checkbox.exists()).toBe(true);
    checkbox.vm.$emit('update:modelValue', true);

    expect(wrapper.emitted('update:modelValue')).toEqual([[true]]);
  });

  it.each([
    ['account', AccountSelectField, 'accountId'],
    ['category', CategorySelectField, 'categoryId'],
    ['payee', PayeeSelectField, 'payeeId'],
    ['tag', TagSelectField, 'tagIds'],
  ] as const)('builds the %s picker for an entity field', (entity, component, path) => {
    const wrapper = mountEditor({
      field: buildField({ path, editable: { type: 'entity', entity } }),
      modelValue: entity === 'tag' ? ['t1'] : 'id-1',
    });

    expect(wrapper.findComponent(component).exists()).toBe(true);
  });

  it('edits a currency in a select field over the user currencies', () => {
    const wrapper = mountEditor({
      field: buildField({ path: 'currencyCode', editable: { type: 'entity', entity: 'userCurrency' } }),
      modelValue: 'USD',
    });
    const select = selectProps({ wrapper });

    expect(select.values).toEqual([
      { value: 'USD', label: 'USD' },
      { value: 'EUR', label: 'EUR' },
    ]);
    expect(select.placeholder).toBe('Select a currency');
  });

  it('shows an entity it has no picker for as read-only text', () => {
    const wrapper = mountEditor({
      field: buildField({ path: 'budgetId', editable: { type: 'entity', entity: 'budget' } }),
      modelValue: 'b1',
    });

    expect(wrapper.findComponent(InputField).exists()).toBe(false);
    expect(wrapper.find('[data-testid="field-readonly"]').exists()).toBe(true);
  });
});
