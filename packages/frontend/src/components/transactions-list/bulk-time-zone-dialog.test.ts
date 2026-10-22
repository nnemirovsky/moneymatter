import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import BulkTimeZoneDialog from './bulk-time-zone-dialog.vue';

const ResponsiveDialogStub = defineComponent({ template: '<div><slot /></div>' });
const TimeZoneSelectFieldStub = defineComponent({
  props: ['modelValue', 'specialOptions'],
  emits: ['update:modelValue'],
  template: '<div data-testid="field" />',
});

const render = (props: { selectedCount?: number; isLoading?: boolean } = {}) =>
  mount(BulkTimeZoneDialog, {
    props: { open: true, selectedCount: 3, isLoading: false, ...props },
    global: {
      stubs: { ResponsiveDialog: ResponsiveDialogStub, TimeZoneSelectField: TimeZoneSelectFieldStub },
    },
  });

const pick = async (wrapper: ReturnType<typeof render>, value: string) => {
  wrapper.getComponent(TimeZoneSelectFieldStub).vm.$emit('update:modelValue', value);
  await wrapper.vm.$nextTick();
};

describe('BulkTimeZoneDialog', () => {
  it('keeps Apply disabled until a choice is made', async () => {
    const wrapper = render();
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();

    await pick(wrapper, 'Asia/Makassar');
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined();
  });

  it('emits the picked zone', async () => {
    const wrapper = render();
    await pick(wrapper, 'Asia/Makassar');
    await wrapper.find('form').trigger('submit');

    expect(wrapper.emitted('apply')?.[0]).toEqual(['Asia/Makassar']);
  });

  it('emits null for the Clear entry, which the picker lists as a special option', async () => {
    const wrapper = render();
    const options = wrapper.getComponent(TimeZoneSelectFieldStub).props('specialOptions') as { value: string }[];
    await pick(wrapper, options[0]!.value);
    await wrapper.find('form').trigger('submit');

    expect(wrapper.emitted('apply')?.[0]).toEqual([null]);
  });
});
