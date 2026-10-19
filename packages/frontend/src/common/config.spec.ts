import { afterEach, describe, expect, it } from 'vitest';

import { config } from './config';

describe('config.cardPaymentShortcutIcloudUrl', () => {
  afterEach(() => {
    delete window.__APP_CONFIG__;
  });

  it('returns the runtime value', () => {
    window.__APP_CONFIG__ = { CARD_PAYMENT_SHORTCUT_ICLOUD_URL: 'https://www.icloud.com/shortcuts/abc123' };

    expect(config.cardPaymentShortcutIcloudUrl).toBe('https://www.icloud.com/shortcuts/abc123');
  });

  it('is undefined when the entrypoint wrote an empty string', () => {
    window.__APP_CONFIG__ = { CARD_PAYMENT_SHORTCUT_ICLOUD_URL: '' };

    expect(config.cardPaymentShortcutIcloudUrl).toBeUndefined();
  });

  it('is undefined when there is no runtime config at all', () => {
    expect(config.cardPaymentShortcutIcloudUrl).toBeUndefined();
  });
});
