import TimeZoneSelectField from '@/components/fields/time-zone-select-field.vue';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import TimeZoneSection from './time-zone-section.vue';

const patchAsync = vi.fn();
const addSuccessNotification = vi.fn();
const settings = ref<Record<string, unknown> | undefined>({});

vi.mock('@/composable/data-queries/user-settings', () => ({
  useUserSettings: () => ({ data: settings, patchAsync, isPatching: ref(false) }),
}));
vi.mock('@/components/notification-center', () => ({
  useNotificationCenter: () => ({ addSuccessNotification }),
}));
vi.mock('@/js/helpers/time-zone', () => ({ deviceTimeZone: () => 'Asia/Tbilisi' }));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const mountSection = () =>
  mount(TimeZoneSection, {
    global: { mocks: { $t: (key: string) => key }, stubs: { TimeZoneSelectField: true } },
  });

describe('TimeZoneSection', () => {
  beforeEach(() => {
    patchAsync.mockReset().mockResolvedValue(undefined);
    addSuccessNotification.mockReset();
    settings.value = {};
  });

  it('patches the device source and zone when Automatic is chosen', async () => {
    const wrapper = mountSection();
    wrapper.findComponent(TimeZoneSelectField).vm.$emit('update:modelValue', '__automatic__');
    await flushPromises();

    expect(patchAsync).toHaveBeenCalledWith({ timeZoneSource: 'device', timeZone: 'Asia/Tbilisi' });
    expect(addSuccessNotification).toHaveBeenCalledTimes(1);
  });

  it('patches the manual source and the zone when a zone is chosen', async () => {
    const wrapper = mountSection();
    wrapper.findComponent(TimeZoneSelectField).vm.$emit('update:modelValue', 'America/New_York');
    await flushPromises();

    expect(patchAsync).toHaveBeenCalledWith({ timeZoneSource: 'manual', timeZone: 'America/New_York' });
  });

  it('selects Automatic unless the source is manual', () => {
    settings.value = { timeZone: 'Asia/Tbilisi', timeZoneSource: 'device' };
    expect(mountSection().findComponent(TimeZoneSelectField).props('modelValue')).toBe('__automatic__');

    settings.value = { timeZone: 'Asia/Tbilisi', timeZoneSource: 'manual' };
    expect(mountSection().findComponent(TimeZoneSelectField).props('modelValue')).toBe('Asia/Tbilisi');
  });

  it('patches hourCycle for 24-hour and 12-hour, and null for Automatic', async () => {
    settings.value = { hourCycle: 'h12' };
    const wrapper = mountSection();
    const buttons = wrapper.findAll('button');
    expect(buttons).toHaveLength(3);

    await buttons[1]!.trigger('click');
    await buttons[2]!.trigger('click');
    await buttons[0]!.trigger('click');
    await flushPromises();

    expect(patchAsync.mock.calls).toStrictEqual([
      [{ hourCycle: 'h23' }],
      [{ hourCycle: 'h12' }],
      [{ hourCycle: null }],
    ]);
  });

  it('does not report success when the patch fails', async () => {
    patchAsync.mockRejectedValueOnce(new Error('boom'));
    const wrapper = mountSection();
    wrapper.findComponent(TimeZoneSelectField).vm.$emit('update:modelValue', 'America/New_York');
    await flushPromises();

    expect(addSuccessNotification).not.toHaveBeenCalled();
  });
});
