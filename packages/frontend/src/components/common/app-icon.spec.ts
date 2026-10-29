import AppIcon from '@/components/common/app-icon.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

const ICON = 'https://cdn.example.com/icon.jpg';

describe('AppIcon', () => {
  it('shows the resolved icon image', () => {
    const wrapper = mount(AppIcon, { props: { appName: 'Example Notes', iconUrl: ICON, size: 20 } });

    const image = wrapper.get('img');
    expect(image.attributes('src')).toBe(ICON);
    expect(image.attributes('style')).toContain('width: 20px');
  });

  it('falls back to the first letter of the app when no icon was found', () => {
    const wrapper = mount(AppIcon, { props: { appName: 'example notes', iconUrl: null } });

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.get('[data-testid="app-icon-fallback"]').attributes('data-letter')).toBe('E');
    expect(wrapper.text()).toBe('');
    expect(wrapper.get('[data-testid="app-icon-fallback"]').attributes('data-glyph')).toBe('monogram');
  });

  it.each([
    ['Messages', null, 'messages'],
    [null, 'com.apple.Passbook', 'wallet'],
  ])('draws a neutral glyph for the built-in app %s %s, which has no App Store icon', (appName, bundleId, glyph) => {
    const wrapper = mount(AppIcon, { props: { appName, bundleId, iconUrl: null } });

    expect(wrapper.get('[data-testid="app-icon-fallback"]').attributes('data-glyph')).toBe(glyph);
    expect(wrapper.element.tagName.toLowerCase()).toBe('svg');
  });

  it('falls back to the glyph when the image fails to load, and tries a new icon url again', async () => {
    const wrapper = mount(AppIcon, { props: { appName: 'Example Notes', iconUrl: ICON } });

    await wrapper.get('img').trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('[data-testid="app-icon-fallback"]').exists()).toBe(true);

    await wrapper.setProps({ iconUrl: 'https://cdn.example.com/other.jpg' });
    expect(wrapper.get('img').attributes('src')).toBe('https://cdn.example.com/other.jpg');
  });
});
