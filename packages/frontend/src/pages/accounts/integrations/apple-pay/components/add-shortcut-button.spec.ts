import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { CARD_PAYMENT_SHORTCUT_DOWNLOAD_NAME } from '../apple-pay';
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

  it('downloads the file under the name the setup steps use', () => {
    const link = mountButton({ href: FILE }).get('[data-testid="add-shortcut"]');

    expect(link.attributes('download')).toBe('MoneyMatter - Log card payment.shortcut');
    expect(link.attributes('download')).toBe(CARD_PAYMENT_SHORTCUT_DOWNLOAD_NAME);
  });

  it('serves the file under the same name from nginx', () => {
    const nginx = readFileSync(resolve(process.cwd(), 'nginx.conf'), 'utf8');

    expect(nginx).toContain(`filename="${CARD_PAYMENT_SHORTCUT_DOWNLOAD_NAME}"`);
  });

  it('opens the iCloud link in a new tab', () => {
    const link = mountButton({ href: ICLOUD }).get('[data-testid="add-shortcut"]');

    expect(link.attributes('href')).toBe(ICLOUD);
    expect(link.attributes('target')).toBe('_blank');
    expect(link.attributes('rel')).toContain('noopener');
    expect(link.attributes('download')).toBeUndefined();
  });

  it('hides itself when there is no shortcut to add', () => {
    expect(mountButton({ href: null }).find('[data-testid="add-shortcut"]').exists()).toBe(false);
  });
});
