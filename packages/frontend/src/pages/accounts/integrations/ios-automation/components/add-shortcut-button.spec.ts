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

const { mockUseShortcutLink, mockLink, mockFile, mockAddError } = vi.hoisted(() => ({
  mockUseShortcutLink: vi.fn(),
  mockLink: { current: null as unknown },
  mockFile: { current: null as File | null },
  mockAddError: vi.fn(),
}));

vi.mock('../composables/use-shortcut-link', () => ({
  useShortcutLink: (args: unknown) => {
    mockUseShortcutLink(args);
    return mockLink.current;
  },
  useShortcutFile: () => ({
    file: {
      get value() {
        return mockFile.current;
      },
    },
  }),
}));

vi.mock('@/components/notification-center', () => ({
  useNotificationCenter: () => ({ addErrorNotification: mockAddError }),
}));

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
    mockFile.current = null;
    vi.stubGlobal('open', open);
    stubStandalone({ isStandalone: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
  });

  describe('in a home-screen web app', () => {
    beforeEach(() => {
      stubStandalone({ isStandalone: true });
    });

    it('keeps the app from navigating away on that click', () => {
      const link = mountButton({ href: CARD_PAYMENT_SHORTCUT_FILE_PATH }).get(
        '[data-testid="add-shortcut-tap"]',
      ).element;
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

  describe('when the browser can share files', () => {
    const share = vi.fn();
    const shortcutFile = new File(['signed'], PAYMENTS_SHORTCUT_DOWNLOAD_NAME);

    const stubSharing = ({ canShare = true }: { canShare?: boolean } = {}) => {
      vi.stubGlobal('navigator', {
        ...navigator,
        share,
        canShare: vi.fn().mockReturnValue(canShare),
      });
    };

    beforeEach(() => {
      share.mockReset().mockResolvedValue(undefined);
      mockFile.current = shortcutFile;
      stubSharing();
    });

    const clickPayments = async () => {
      const link = mountButton({
        href: PAYMENTS_SHORTCUT_FILE_PATH,
        shortcut: 'payments',
      }).get('[data-testid="add-shortcut-payments"]');
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      });
      link.element.dispatchEvent(event);
      await Promise.resolve();

      return event;
    };

    it('shares the loaded file instead of following the link', async () => {
      const event = await clickPayments();

      expect(event.defaultPrevented).toBe(true);
      expect(share).toHaveBeenCalledWith({ files: [shortcutFile] });
      expect(open).not.toHaveBeenCalled();
    });

    it('shares from the installed app too, instead of opening the browser sheet', async () => {
      stubStandalone({ isStandalone: true });

      await clickPayments();

      expect(share).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
    });

    it('stays quiet when the share sheet is dismissed', async () => {
      share.mockRejectedValue(new DOMException('dismissed', 'AbortError'));

      await clickPayments();
      await Promise.resolve();

      expect(mockAddError).not.toHaveBeenCalled();
    });

    it('tells the user when sharing fails', async () => {
      share.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));

      await clickPayments();
      await new Promise((done) => setTimeout(done));

      expect(mockAddError).toHaveBeenCalledWith(expect.stringContaining('share sheet'));
    });

    it('tells how to finish from the share sheet, which has no Open in Shortcuts', () => {
      const wrapper = mountButton({ href: PAYMENTS_SHORTCUT_FILE_PATH, shortcut: 'payments' });

      expect(wrapper.get('[data-testid="add-shortcut-payments-hint"]').text()).toContain('Save to Files');
    });

    it('words the hint for the plain download when the share sheet is not used', () => {
      stubSharing({ canShare: false });

      const wrapper = mountButton({ href: PAYMENTS_SHORTCUT_FILE_PATH, shortcut: 'payments' });

      expect(wrapper.get('[data-testid="add-shortcut-payments-hint"]').text()).toBe(
        'Open the downloaded file to add the shortcut.',
      );
    });

    it('falls back to the link when the browser refuses the file', async () => {
      stubSharing({ canShare: false });

      const event = await clickPayments();

      expect(event.defaultPrevented).toBe(false);
      expect(share).not.toHaveBeenCalled();
    });

    it('falls back to the link before the file has loaded', async () => {
      mockFile.current = null;

      const event = await clickPayments();

      expect(event.defaultPrevented).toBe(false);
      expect(share).not.toHaveBeenCalled();
    });
  });

  describe('which shortcut it points at', () => {
    it('asks for the iOS 27 file, never the tap shortcut one', () => {
      mountButton({ href: null, shortcut: 'payments' });

      expect(mockUseShortcutLink).toHaveBeenCalledWith({ filePath: '/shortcuts/log-payments.shortcut' });
    });

    it('asks for the tap file for iOS 26 and earlier', () => {
      mountButton({ href: null, shortcut: 'tap' });

      expect(mockUseShortcutLink).toHaveBeenCalledWith({ filePath: '/shortcuts/log-card-payment.shortcut' });
    });
  });

  it('hides itself when there is no shortcut to add', () => {
    expect(mountButton({ href: null }).find('[data-testid="add-shortcut-tap"]').exists()).toBe(false);
  });
});
