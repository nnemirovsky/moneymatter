import { flushPromises, mount } from '@vue/test-utils';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { createGlobalPlugins } from '../test-support';
import ShortcutChoice from './shortcut-choice.vue';

const { mockLinks, mockUseShortcutLink } = vi.hoisted(() => ({
  mockLinks: {} as Record<string, { href: unknown; isResolved: unknown }>,
  mockUseShortcutLink: vi.fn(),
}));

vi.mock('../composables/use-shortcut-link', () => ({
  useShortcutLink: (args: { filePath: string }) => {
    mockUseShortcutLink(args);
    return mockLinks[args.filePath];
  },
  useShortcutFile: () => ({ file: ref(null) }),
}));

const PAYMENTS_FILE = '/shortcuts/log-payments.shortcut';
const TAP_FILE = '/shortcuts/log-card-payment.shortcut';

const setLink = ({
  filePath,
  href,
  isResolved = true,
}: {
  filePath: string;
  href: string | null;
  isResolved?: boolean;
}) => {
  mockLinks[filePath] = { href: ref(href), isResolved: ref(isResolved) };
};

const mountChoice = () => mount(ShortcutChoice, { global: { plugins: createGlobalPlugins().plugins } });

const collectSourceFiles = ({ dir }: { dir: string }): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return collectSourceFiles({ dir: path });

    return /\.(vue|ts)$/.test(name) && !/\.(spec|test)\.ts$/.test(name) ? [path] : [];
  });

describe('ShortcutChoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLink({ filePath: PAYMENTS_FILE, href: PAYMENTS_FILE });
    setLink({ filePath: TAP_FILE, href: TAP_FILE });
  });

  it('shows both buttons, iOS 27 or later and iOS 26 or earlier', () => {
    const wrapper = mountChoice();

    expect(wrapper.get('[data-testid="add-shortcut-payments"]').text()).toBe('Add shortcut — iOS 27 or later');
    expect(wrapper.get('[data-testid="add-shortcut-tap"]').text()).toBe('Add shortcut — iOS 26 or earlier');
  });

  it('lays the two options side by side in a wide container and stacks them in a narrow one', () => {
    const grid = mountChoice().get('[data-testid="shortcut-choice"] > div');

    expect(grid.classes()).toContain('grid-cols-1');
    expect(grid.classes()).toContain('@xl/shortcut-choice:grid-cols-2');
    expect(mountChoice().get('[data-testid="shortcut-choice"]').classes()).toContain('@container/shortcut-choice');
  });

  it('points the iOS 27 button at its own file and link, and the iOS 26 button at the tap shortcut', () => {
    mountChoice();

    const paths = mockUseShortcutLink.mock.calls.map(([args]) => args.filePath);
    expect(paths).toContain(PAYMENTS_FILE);
    expect(paths).toContain(TAP_FILE);
  });

  describe('instructions', () => {
    it('keeps them closed until asked', () => {
      const wrapper = mountChoice();

      expect(wrapper.find('[data-testid="triggered-shortcut-setup"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="setup-checklist"]').exists()).toBe(false);
    });

    it('expands the iOS 27 instructions under its own button only', async () => {
      const wrapper = mountChoice();

      await wrapper.get('[data-testid="shortcut-instructions-toggle-payments"]').trigger('click');
      await flushPromises();

      const option = wrapper.get('[data-testid="shortcut-option-payments"]');
      expect(option.find('[data-testid="triggered-shortcut-setup"]').exists()).toBe(true);
      expect(wrapper.get('[data-testid="shortcut-option-tap"]').find('[data-testid="setup-checklist"]').exists()).toBe(
        false,
      );
      expect(option.get('[data-testid="shortcut-instructions-toggle-payments"]').text()).toBe('Hide instructions');
    });

    it('expands the iOS 26 checklist under its own button', async () => {
      const wrapper = mountChoice();

      await wrapper.get('[data-testid="shortcut-instructions-toggle-tap"]').trigger('click');
      await flushPromises();

      const option = wrapper.get('[data-testid="shortcut-option-tap"]');
      expect(option.findAll('[data-testid="setup-checklist-step"]')).toHaveLength(3);
      expect(wrapper.find('[data-testid="triggered-shortcut-setup"]').exists()).toBe(false);
    });

    it('closes them again', async () => {
      const wrapper = mountChoice();
      const toggle = wrapper.get('[data-testid="shortcut-instructions-toggle-payments"]');

      await toggle.trigger('click');
      await flushPromises();
      await toggle.trigger('click');
      await flushPromises();

      expect(wrapper.find('[data-testid="triggered-shortcut-setup"]').exists()).toBe(false);
      expect(toggle.text()).toBe('Show instructions');
    });
  });

  describe('when a shortcut is not shipped', () => {
    it('hides its button and says so, once the probe has answered', () => {
      setLink({ filePath: PAYMENTS_FILE, href: null });
      const wrapper = mountChoice();

      expect(wrapper.find('[data-testid="add-shortcut-payments"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="shortcut-unavailable-payments"]').text()).toContain('"iOS 27 or later"');
      expect(wrapper.get('[data-testid="shortcut-unavailable-payments"]').text()).toContain('manual guide');
      expect(wrapper.find('[data-testid="add-shortcut-tap"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="shortcut-unavailable-tap"]').exists()).toBe(false);
    });

    it('stays quiet while the probe is still running', () => {
      setLink({ filePath: PAYMENTS_FILE, href: null, isResolved: false });
      const wrapper = mountChoice();

      expect(wrapper.find('[data-testid="shortcut-unavailable-payments"]').exists()).toBe(false);
    });

    it('drops the copy-the-code hint when nothing can be added', () => {
      setLink({ filePath: PAYMENTS_FILE, href: null });
      setLink({ filePath: TAP_FILE, href: null });
      const wrapper = mountChoice();

      expect(wrapper.find('[data-testid="shortcut-choice-hint"]').exists()).toBe(false);
    });

    it('asks for the setup code first when something can be added', () => {
      expect(mountChoice().get('[data-testid="shortcut-choice-hint"]').text()).toContain('Copy the setup code first');
    });
  });

  describe('no detection', () => {
    it('never reads the user agent while rendering', () => {
      const userAgent = vi.spyOn(navigator, 'userAgent', 'get');

      mountChoice();

      expect(userAgent).not.toHaveBeenCalled();
    });

    it('has no code path that reads navigator.userAgent or remembers a choice', () => {
      const sourceDir = resolve(__dirname, '..');

      for (const file of collectSourceFiles({ dir: sourceDir })) {
        const source = readFileSync(file, 'utf8');

        expect(source, file).not.toMatch(/navigator\.userAgent|userAgent/);
        expect(source, file).not.toMatch(/localStorage|sessionStorage/);
      }
    });
  });
});
