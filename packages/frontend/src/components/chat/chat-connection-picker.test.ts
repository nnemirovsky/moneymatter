import { useAiSettings } from '@/composable/data-queries/ai-settings';
import { useAiConnectionsList } from '@/composable/data-queries/use-ai-connections';
import { AI_PROVIDER, type AIConnectionInfo } from '@bt/shared/types';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, ref } from 'vue';

import { createChatI18n } from './cards/card-test-fixtures';
import ChatConnectionPicker from './chat-connection-picker.vue';

vi.mock('@/composable/data-queries/use-ai-connections', () => ({ useAiConnectionsList: vi.fn() }));
vi.mock('@/composable/data-queries/ai-settings', () => ({ useAiSettings: vi.fn() }));

const connection = (overrides: Partial<AIConnectionInfo> = {}): AIConnectionInfo => ({
  id: 'c1',
  provider: AI_PROVIDER.custom,
  name: 'Home Ollama',
  model: 'llama3.2',
  hasApiKey: false,
  createdAt: '2026-03-05T10:00:00.000Z',
  status: 'valid',
  lastValidatedAt: '2026-03-05T10:00:00.000Z',
  ...overrides,
});

const state = {
  connections: ref<AIConnectionInfo[]>([]),
  includedModelName: ref<string | null>(null),
};

/** The select reports the option the user picked; the real one renders its options in a portal. */
const SelectStub = defineComponent({
  props: ['modelValue', 'values', 'disabled', 'labelKey'],
  emits: ['update:modelValue'],
  setup:
    (props, { emit }) =>
    () =>
      h(
        'div',
        {
          'data-testid': 'select',
          'data-selected': props.modelValue ? props.labelKey(props.modelValue) : '',
          'data-disabled': String(props.disabled),
        },
        props.values.map((option: { value: string }) =>
          h(
            'button',
            { 'data-testid': `option-${option.value}`, onClick: () => emit('update:modelValue', option) },
            props.labelKey(option),
          ),
        ),
      ),
});

const mountPicker = (props: { connectionId: string | null; disabled?: boolean }) =>
  mount(ChatConnectionPicker, {
    props,
    global: { plugins: [createChatI18n()], stubs: { SelectField: SelectStub } },
  });

describe('ChatConnectionPicker', () => {
  beforeEach(() => {
    state.connections.value = [
      connection({ id: 'c1', name: 'Home Ollama', model: 'llama3.2' }),
      connection({ id: 'c2', name: 'Studio vLLM', model: 'qwen2.5' }),
    ];
    state.includedModelName.value = null;
    vi.mocked(useAiConnectionsList).mockReturnValue({
      connections: computed(() => state.connections.value),
    } as unknown as ReturnType<typeof useAiConnectionsList>);
    vi.mocked(useAiSettings).mockReturnValue({
      getFeatureStatus: () => ({ serverModelName: state.includedModelName.value }),
    } as unknown as ReturnType<typeof useAiSettings>);
  });

  it('lists every connection with its model and shows the thread connection as selected', () => {
    const wrapper = mountPicker({ connectionId: 'c2' });

    expect(wrapper.find('[data-testid="option-c1"]').text()).toBe('Home Ollama (llama3.2)');
    expect(wrapper.find('[data-testid="option-c2"]').text()).toBe('Studio vLLM (qwen2.5)');
    expect(wrapper.find('[data-testid="select"]').attributes('data-selected')).toBe('Studio vLLM (qwen2.5)');
  });

  it('offers the included model only where one serves chat', async () => {
    const wrapper = mountPicker({ connectionId: 'c1' });
    expect(wrapper.find('[data-testid="option-included"]').exists()).toBe(false);

    state.includedModelName.value = 'Gemini';
    const withIncluded = mountPicker({ connectionId: null });

    expect(withIncluded.find('[data-testid="option-included"]').text()).toBe('Included model');
    expect(withIncluded.find('[data-testid="select"]').attributes('data-selected')).toBe('Included model');
  });

  it('reports the picked connection, and null for the included model', async () => {
    state.includedModelName.value = 'Gemini';
    const wrapper = mountPicker({ connectionId: 'c1' });

    await wrapper.find('[data-testid="option-c2"]').trigger('click');
    await wrapper.find('[data-testid="option-included"]').trigger('click');

    expect(wrapper.emitted('select')).toEqual([['c2'], [null]]);
  });

  it('is disabled while told to', () => {
    expect(
      mountPicker({ connectionId: 'c1', disabled: true }).find('[data-testid="select"]').attributes('data-disabled'),
    ).toBe('true');
    expect(mountPicker({ connectionId: 'c1' }).find('[data-testid="select"]').attributes('data-disabled')).toBe(
      'false',
    );
  });

  it('names a connection that needs attention', () => {
    state.connections.value = [connection({ id: 'c1', status: 'invalid' })];

    const wrapper = mountPicker({ connectionId: 'c1' });

    expect(wrapper.find('[data-testid="option-c1"]').text()).toBe('Home Ollama (llama3.2) - needs attention');
  });

  it('selects nothing for a connection that was deleted', () => {
    const wrapper = mountPicker({ connectionId: 'deleted' });

    expect(wrapper.find('[data-testid="select"]').attributes('data-selected')).toBe('');
  });

  it('renders nothing while there is nothing to pick', () => {
    state.connections.value = [];

    const wrapper = mountPicker({ connectionId: null });

    expect(wrapper.find('[data-testid="chat-connection-picker"]').exists()).toBe(false);
  });
});
