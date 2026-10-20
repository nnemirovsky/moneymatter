import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import {
  CARD_PAYMENT_SHORTCUT_DOWNLOAD_NAME,
  CARD_PAYMENT_SHORTCUT_FILE_PATH,
  PAYMENTS_SHORTCUT_DOWNLOAD_NAME,
  PAYMENTS_SHORTCUT_FILE_PATH,
  type ShortcutKind,
} from '../ios-automation';
import { createGlobalPlugins } from '../test-support';
import AddShortcutButton from './add-shortcut-button.vue';

const { mockUseShortcutLink, mockLink } = vi.hoisted(() => ({
  mockUseShortcutLink: vi.fn(),
  mockLink: { current: null as unknown },
}));

vi.mock('../composables/use-shortcut-link', () => ({
  useShortcutLink: (args: unknown) => {
    mockUseShortcutLink(args);
    return mockLink.current;
  },
}));

const ICLOUD = 'https://www.icloud.com/shortcuts/abc123';
const open = vi.fn();

const stubStandalone = ({ isStandalone }: { isStandalone: boolean }) => {
  Object.defineProperty(window, 'matchMedia', {
    value: vi.fn().mockReturnValue({ matches: isStandalone }),
    configurable: true,
  });
};

const mountButton = ({ href, shortcut = 'tap' }: { href: string | null; shortcut?: ShortcutKind }) => {
  mockLink.current = { href: ref(href), isResolved: ref(true) };
  return mount(AddShortcutButton, { props: { shortcut }, global: { plugins: createGlobalPlugins().plugins } });
};

describe('AddShortcutButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLink.current = null;
    vi.stubGlobal('open', open);
    stubStandalone({ isStandalone: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__APP_CONFIG__;
  });

  describe('in a normal tab', () => {
    it('links the tap shortcut file in the same tab', () => {
      const link = mountButton({ href: CARD_PAYMENT_SHORTCUT_FILE_PATH }).get('[data-testid="add-shortcut-tap"]');

      expect(link.attributes('href')).toBe(CARD_PAYMENT_SHORTCUT_FILE_PATH);
      expect(link.attributes('target')).toBeUndefined();
      expect(link.text()).toBe('Add shortcut — iOS 26 or earlier');
    });

    it('downloads the tap file under the name the setup steps use', () => {
      const link = mountButton({ href: CARD_PAYMENT_SHORTCUT_FILE_PATH }).get('[data-testid="add-shortcut-tap"]');

      expect(link.attributes('download')).toBe('MoneyMatter - Log card payment.shortcut');
      expect(link.attributes('download')).toBe(CARD_PAYMENT_SHORTCUT_DOWNLOAD_NAME);
    });

    it('downloads the iOS 27 file under its own name', () => {
      const link = mountButton({ href: PAYMENTS_SHORTCUT_FILE_PATH, shortcut: 'payments' }).get(
        '[data-testid="add-shortcut-payments"]',
      );

      expect(link.attributes('href')).toBe('/shortcuts/log-payments.shortcut');
      expect(link.attributes('download')).toBe(PAYMENTS_SHORTCUT_DOWNLOAD_NAME);
      expect(link.text()).toBe('Add shortcut — iOS 27 or later');
    });

    it('serves each file under the same name from nginx', () => {
      const nginx = readFileSync(resolve(process.cwd(), 'nginx.conf'), 'utf8');

      expect(nginx).toContain(`filename="${CARD_PAYMENT_SHORTCUT_DOWNLOAD_NAME}"`);
      expect(nginx).toContain(`filename="${PAYMENTS_SHORTCUT_DOWNLOAD_NAME}"`);
    });

    it('opens the iCloud link in a new tab through a plain anchor', async () => {
      const link = mountButton({ href: ICLOUD }).get('[data-testid="add-shortcut-tap"]');

      expect(link.attributes('href')).toBe(ICLOUD);
      expect(link.attributes('target')).toBe('_blank');
      expect(link.attributes('rel')).toContain('noopener');
      expect(link.attributes('download')).toBeUndefined();

      await link.trigger('click');

      expect(open).not.toHaveBeenCalled();
    });
  });

  describe('in a home-screen web app', () => {
    beforeEach(() => {
      stubStandalone({ isStandalone: true });
    });

    it('opens the iCloud link through window.open, detached', async () => {
      const link = mountButton({ href: ICLOUD, shortcut: 'payments' }).get('[data-testid="add-shortcut-payments"]');

      await link.trigger('click');

      expect(open).toHaveBeenCalledWith(ICLOUD, '_blank', 'noopener');
    });

    it('keeps the app from navigating away on that click', () => {
      const link = mountButton({ href: ICLOUD }).get('[data-testid="add-shortcut-tap"]').element;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });

      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    });

    it('gives the file no download attribute and opens its absolute URL through window.open', async () => {
      const link = mountButton({ href: PAYMENTS_SHORTCUT_FILE_PATH, shortcut: 'payments' }).get(
        '[data-testid="add-shortcut-payments"]',
      );

      expect(link.attributes('download')).toBeUndefined();

      await link.trigger('click');

      expect(open).toHaveBeenCalledWith(`${window.location.origin}/shortcuts/log-payments.shortcut`, '_blank');
    });
  });

  describe('which shortcut it points at', () => {
    it('asks for the iOS 27 file and link, never the tap shortcut ones', () => {
      window.__APP_CONFIG__ = {
        CARD_PAYMENT_SHORTCUT_ICLOUD_URL: 'https://www.icloud.com/shortcuts/tap',
        PAYMENTS_SHORTCUT_ICLOUD_URL: 'https://www.icloud.com/shortcuts/ios27',
      };

      mountButton({ href: null, shortcut: 'payments' });

      expect(mockUseShortcutLink).toHaveBeenCalledWith({
        filePath: '/shortcuts/log-payments.shortcut',
        icloudUrl: 'https://www.icloud.com/shortcuts/ios27',
      });
    });

    it('asks for the tap file and link for iOS 26 and earlier', () => {
      window.__APP_CONFIG__ = {
        CARD_PAYMENT_SHORTCUT_ICLOUD_URL: 'https://www.icloud.com/shortcuts/tap',
        PAYMENTS_SHORTCUT_ICLOUD_URL: 'https://www.icloud.com/shortcuts/ios27',
      };

      mountButton({ href: null, shortcut: 'tap' });

      expect(mockUseShortcutLink).toHaveBeenCalledWith({
        filePath: '/shortcuts/log-card-payment.shortcut',
        icloudUrl: 'https://www.icloud.com/shortcuts/tap',
      });
    });
  });

  it('hides itself when there is no shortcut to add', () => {
    expect(mountButton({ href: null }).find('[data-testid="add-shortcut-tap"]').exists()).toBe(false);
  });
});
