import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('./app-store-lookup', () => ({ lookupByBundleId: jest.fn(), searchByName: jest.fn() }));

import { lookupByBundleId, searchByName } from './app-store-lookup';
import { resolveAppIcon } from './resolve-app-icon';

const byBundle = jest.mocked(lookupByBundleId);
const byName = jest.mocked(searchByName);

const found = (overrides: Record<string, unknown> = {}) => ({
  bundleId: 'com.example.notes',
  trackName: 'Example Notes',
  sellerName: null,
  iconUrl: 'https://cdn.example.com/icon.jpg',
  ...overrides,
});

describe('resolveAppIcon', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    byBundle.mockResolvedValue(null);
    byName.mockResolvedValue(null);
  });

  it('looks a known bundle id up first, in the storefronts in order, and stops at the first hit', async () => {
    byBundle.mockResolvedValueOnce(null).mockResolvedValueOnce(found());

    const icon = await resolveAppIcon({
      bundleId: 'com.example.notes',
      appName: 'Example Notes',
      storefronts: ['us', 'gb', 'de'],
    });

    expect(icon).toEqual({ iconUrl: 'https://cdn.example.com/icon.jpg', bundleId: 'com.example.notes' });
    expect(byBundle.mock.calls.map(([call]) => call.storefront)).toEqual(['us', 'gb']);
    expect(byName).not.toHaveBeenCalled();
  });

  it('falls back to the strict name search when the bundle id is unknown to the storefronts, and keeps the bundle id it finds', async () => {
    byName.mockResolvedValueOnce(null).mockResolvedValueOnce(found({ bundleId: 'com.example.found' }));

    const icon = await resolveAppIcon({
      bundleId: 'com.example.gone',
      appName: 'Example Notes',
      storefronts: ['us', 'gb'],
    });

    expect(byBundle).toHaveBeenCalledTimes(2);
    expect(byName.mock.calls.map(([call]) => [call.appName, call.storefront])).toEqual([
      ['Example Notes', 'us'],
      ['Example Notes', 'gb'],
    ]);
    expect(icon?.bundleId).toBe('com.example.found');
  });

  it('searches by name alone when the shortcut sent no bundle id', async () => {
    byName.mockResolvedValue(found());

    const icon = await resolveAppIcon({ bundleId: null, appName: ' Example Notes ', storefronts: ['us'] });

    expect(byBundle).not.toHaveBeenCalled();
    expect(byName).toHaveBeenCalledWith({ appName: 'Example Notes', storefront: 'us' });
    expect(icon?.iconUrl).toBe('https://cdn.example.com/icon.jpg');
  });

  it('answers null when nothing matched in any storefront', async () => {
    expect(await resolveAppIcon({ bundleId: null, appName: 'Example Notes', storefronts: ['us', 'gb'] })).toBeNull();
    expect(byName).toHaveBeenCalledTimes(2);
  });

  it('answers null without a request for an app with neither a bundle id nor a name', async () => {
    expect(await resolveAppIcon({ bundleId: null, appName: '  ', storefronts: ['us'] })).toBeNull();
    expect(byBundle).not.toHaveBeenCalled();
    expect(byName).not.toHaveBeenCalled();
  });

  it.each([
    ['Messages by name', { bundleId: null, appName: 'Messages' }, 'com.apple.MobileSMS'],
    ['Wallet by name', { bundleId: null, appName: 'Wallet' }, 'com.apple.Passbook'],
    ['Mail by name', { bundleId: null, appName: 'Mail' }, 'com.apple.mobilemail'],
    ['Telegram by name', { bundleId: null, appName: ' telegram ' }, 'ph.telegra.Telegraph'],
  ])('looks a common app up by the bundle id it is known by, not by a name search: %s', async (_label, app, id) => {
    byBundle.mockResolvedValue(found({ bundleId: id }));

    const icon = await resolveAppIcon({ ...app, storefronts: ['us'] });

    expect(byBundle).toHaveBeenCalledWith({ bundleId: id, storefront: 'us' });
    expect(byName).not.toHaveBeenCalled();
    expect(icon?.bundleId).toBe(id);
  });

  it('prefers the bundle id the shortcut sent over the one a name is known by', async () => {
    byBundle.mockResolvedValue(found({ bundleId: 'com.example.chat' }));

    await resolveAppIcon({ bundleId: 'com.example.chat', appName: 'Messages', storefronts: ['us'] });

    expect(byBundle).toHaveBeenCalledWith({ bundleId: 'com.example.chat', storefront: 'us' });
  });

  it('does look Mail up, which is on the App Store', async () => {
    byBundle.mockResolvedValue(found({ bundleId: 'com.apple.mobilemail' }));

    const icon = await resolveAppIcon({ bundleId: 'com.apple.mobilemail', appName: 'Mail', storefronts: ['us'] });

    expect(icon?.bundleId).toBe('com.apple.mobilemail');
  });
});
