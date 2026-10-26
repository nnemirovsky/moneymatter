import enCommon from '@/i18n/locales/chunks/en/common.json';
import { AI_PROVIDER } from '@bt/shared/types';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { createI18n } from 'vue-i18n';

import EffortSelect from './effort-select.vue';

/** Reports the option the user picked; the real select renders its options in a portal. */
const SelectStub = defineComponent({
  props: ['modelValue', 'values', 'labelKey', 'disabled'],
  emits: ['update:modelValue'],
  setup:
    (props, { emit }) =>
    () =>
      h(
        'div',
        { 'data-testid': 'select', 'data-selected': props.modelValue ? props.labelKey(props.modelValue) : '' },
        props.values.map((option: { value: string }) =>
          h(
            'button',
            { 'data-testid': `option-${option.value}`, onClick: () => emit('update:modelValue', option) },
            props.labelKey(option),
          ),
        ),
      ),
});

const mountSelect = (props: {
  connection: { provider: AI_PROVIDER; model: string };
  modelId?: string | null;
  effort?: 'low' | 'high' | 'max' | null;
}) =>
  mount(EffortSelect, {
    props: { modelId: null, effort: null, ...props },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en: enCommon }, missingWarn: false })],
      stubs: { SelectField: SelectStub },
    },
  });

const CODEX = { provider: AI_PROVIDER.codex, model: 'gpt-6-astra' };

describe('EffortSelect', () => {
  it('lists the default and the levels the model takes, by name', () => {
    const wrapper = mountSelect({ connection: CODEX });

    expect(wrapper.findAll('button').map((button) => button.text())).toEqual([
      'Default',
      'Minimal',
      'Low',
      'Medium',
      'High',
    ]);
  });

  it('is not rendered for a model without an effort setting', () => {
    expect(
      mountSelect({ connection: { provider: AI_PROVIDER.custom, model: 'llama3.2' } })
        .find('button')
        .exists(),
    ).toBe(false);
    expect(
      mountSelect({ connection: { provider: AI_PROVIDER.claudeCode, model: 'sonnet' }, modelId: 'haiku' })
        .find('button')
        .exists(),
    ).toBe(false);
  });

  it('shows the stored level, and the default when the stored one does not fit the model', () => {
    expect(
      mountSelect({ connection: CODEX, effort: 'high' })
        .get('[data-testid="effort-select"]')
        .attributes('data-selected'),
    ).toBe('High');
    expect(
      mountSelect({ connection: CODEX, effort: 'max' })
        .get('[data-testid="effort-select"]')
        .attributes('data-selected'),
    ).toBe('Default');
  });

  it('emits the level picked, and null for the default', async () => {
    const wrapper = mountSelect({ connection: CODEX, effort: 'high' });

    await wrapper.get('[data-testid="option-low"]').trigger('click');
    await wrapper.get('[data-testid="option-__effort-default__"]').trigger('click');

    expect(wrapper.emitted('select')).toEqual([['low'], [null]]);
  });

  it('does not emit when the picked option is the one shown', async () => {
    const wrapper = mountSelect({ connection: CODEX, effort: 'high' });

    await wrapper.get('[data-testid="option-high"]').trigger('click');

    expect(wrapper.emitted('select')).toBeUndefined();
  });
});
