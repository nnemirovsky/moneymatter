import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';

import TimeZoneSelectField from './time-zone-select-field.vue';

const SPECIAL = { value: '__automatic__', label: 'Automatic (device): Asia/Tbilisi' };

const mountField = (props: Record<string, unknown> = {}) =>
  mount(TimeZoneSelectField, {
    props: { modelValue: null, placeholder: 'Pick a zone', ...props },
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key } },
  });

const openList = async (wrapper: ReturnType<typeof mountField>) => {
  await wrapper.find('[role="combobox"], button').trigger('click');
  await wrapper.vm.$nextTick();
};

describe('TimeZoneSelectField', () => {
  beforeAll(() => {
    // jsdom lacks it; reka scrolls the highlighted item into view.
    Element.prototype.scrollIntoView = () => {};
  });

  it('shows the placeholder without a value', () => {
    const wrapper = mountField();
    expect(wrapper.text()).toContain('Pick a zone');
    wrapper.unmount();
  });

  it('shows the label of the selected zone', () => {
    const wrapper = mountField({ modelValue: 'Asia/Tbilisi' });
    expect(wrapper.text()).toContain('Asia/Tbilisi');
    wrapper.unmount();
  });

  it('shows the label of a selected special option', () => {
    const wrapper = mountField({ modelValue: SPECIAL.value, specialOptions: [SPECIAL] });
    expect(wrapper.text()).toContain(SPECIAL.label);
    wrapper.unmount();
  });

  it('lists the special options first and emits the picked zone', async () => {
    const wrapper = mountField({ specialOptions: [SPECIAL] });
    await openList(wrapper);

    const items = Array.from(document.body.querySelectorAll('[role="option"]'));
    expect(items[0]?.textContent).toContain(SPECIAL.label);

    const tbilisi = items.find((item) => item.textContent?.endsWith('· Asia/Tbilisi')) as HTMLElement;
    tbilisi.click();
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('update:modelValue')?.[0]).toStrictEqual(['Asia/Tbilisi']);
    wrapper.unmount();
  });
});
