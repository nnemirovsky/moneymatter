import AppIcon from '@/components/common/app-icon.vue';
import NotificationSourceLabel from '@/components/common/notification-source-label.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

const ICON = 'https://cdn.example.com/icon.jpg';

const mountLabel = (props: Record<string, unknown>) =>
  mount(NotificationSourceLabel, { props: { appName: 'Example Notes', ...props } });

describe('NotificationSourceLabel', () => {
  it('reads icon, app name, a colon and the sender, in plain text without a pill', () => {
    const wrapper = mountLabel({ sender: 'ExampleSender', iconUrl: ICON });

    expect(wrapper.get('img').attributes('src')).toBe(ICON);
    expect(wrapper.text()).toBe('Example Notes: ExampleSender');
    expect(wrapper.get('[data-testid="source-label-app"]').text()).toBe('Example Notes');
    expect(wrapper.get('[data-testid="source-label-sender"]').text()).toBe('ExampleSender');
    expect(wrapper.find('.border').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('·');
  });

  it('shows the icon and the name alone when the source is the app itself', () => {
    const wrapper = mountLabel({ sender: null, iconUrl: ICON });

    expect(wrapper.text()).toBe('Example Notes');
    expect(wrapper.find('[data-testid="source-label-sender"]').exists()).toBe(false);
    expect(wrapper.getComponent(AppIcon).props('iconUrl')).toBe(ICON);
  });

  it('falls back to the bundle id, then to the given text, when the app has no name', () => {
    expect(mountLabel({ appName: null, bundleId: 'com.example.notes' }).text()).toContain('com.example.notes');
    expect(mountLabel({ appName: null, fallback: 'Unknown app' }).text()).toContain('Unknown app');
  });
});
