import AppIcon from '@/components/common/app-icon.vue';
import NotificationSourceLabel from '@/components/common/notification-source-label.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

const ICON = 'https://cdn.example.com/icon.jpg';

const mountLabel = (props: Record<string, unknown>) =>
  mount(NotificationSourceLabel, { props: { appName: 'Example Notes', ...props } });

describe('NotificationSourceLabel', () => {
  it('reads sender first, then the app with its icon in the bordered pill', () => {
    const wrapper = mountLabel({ sender: 'ExampleSender', iconUrl: ICON });

    expect(wrapper.get('[data-testid="source-label-sender"]').text()).toBe('ExampleSender');
    const pill = wrapper.get('[data-testid="source-label-app"]');
    expect(pill.classes()).toContain('border');
    expect(pill.text()).toBe('Example Notes');
    expect(pill.get('img').attributes('src')).toBe(ICON);
    // The sender comes before the pill.
    expect(wrapper.text()).toBe('ExampleSenderExample Notes');
    expect(wrapper.text()).not.toContain('·');
  });

  it('shows the icon and the name without a pill when the source is the app itself', () => {
    const wrapper = mountLabel({ sender: null, iconUrl: ICON });

    const name = wrapper.get('[data-testid="source-label-app"]');
    expect(name.text()).toBe('Example Notes');
    expect(name.classes()).not.toContain('border');
    expect(wrapper.find('[data-testid="source-label-sender"]').exists()).toBe(false);
    expect(wrapper.getComponent(AppIcon).props('iconUrl')).toBe(ICON);
  });

  it('falls back to the bundle id, then to the given text, when the app has no name', () => {
    expect(mountLabel({ appName: null, bundleId: 'com.example.notes' }).text()).toContain('com.example.notes');
    expect(mountLabel({ appName: null, fallback: 'Unknown app' }).text()).toContain('Unknown app');
  });
});
