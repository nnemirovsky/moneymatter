import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { createGlobalPlugins } from '../test-support';
import AddShortcutButton from './add-shortcut-button.vue';

const { mockLink } = vi.hoisted(() => ({ mockLink: { current: null as unknown } }));

vi.mock('../composables/use-shortcut-link', () => ({ useShortcutLink: () => mockLink.current }));

const FILE = '/shortcuts/log-card-payment.shortcut';
const ICLOUD = 'https://www.icloud.com/shortcuts/abc123';

const mountButton = ({ href }: { href: string | null }) => {
  mockLink.current = { href: ref(href), isResolved: ref(true) };
  return mount(AddShortcutButton, { global: { plugins: createGlobalPlugins().plugins } });
};

describe('AddShortcutButton', () => {
  beforeEach(() => {
    mockLink.current = null;
  });

  it('links the signed file in the same tab', () => {
    const link = mountButton({ href: FILE }).get('[data-testid="add-shortcut"]');

    expect(link.attributes('href')).toBe(FILE);
    expect(link.attributes('target')).toBeUndefined();
    expect(link.text()).toBe('Add Shortcut');
  });

  it('opens the iCloud link in a new tab', () => {
    const link = mountButton({ href: ICLOUD }).get('[data-testid="add-shortcut"]');

    expect(link.attributes('href')).toBe(ICLOUD);
    expect(link.attributes('target')).toBe('_blank');
    expect(link.attributes('rel')).toContain('noopener');
  });

  it('hides itself when there is no shortcut to add', () => {
    expect(mountButton({ href: null }).find('[data-testid="add-shortcut"]').exists()).toBe(false);
  });
});
