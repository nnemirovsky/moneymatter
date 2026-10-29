import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('./app-store-lookup', () => ({ lookupByBundleId: jest.fn(), searchByName: jest.fn() }));

import { lookupByBundleId } from './app-store-lookup';
import { getIosAutomationIcons, resetIosAutomationIcons } from './ios-automation-icons';

const byBundle = jest.mocked(lookupByBundleId);
const app = (bundleId: string, iconUrl: string) => ({ bundleId, trackName: 'App', sellerName: null, iconUrl });

describe('getIosAutomationIcons', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    resetIosAutomationIcons();
    process.env.APP_ICON_LOOKUP = 'on';
  });

  it('answers nothing, without a request, under test unless lookups are switched on', async () => {
    delete process.env.APP_ICON_LOOKUP;

    expect(await getIosAutomationIcons()).toEqual({ shortcuts: null, wallet: null });
    expect(byBundle).not.toHaveBeenCalled();
  });

  it('looks Shortcuts and Wallet up by their bundle ids and keeps the answer for later requests', async () => {
    byBundle.mockImplementation(async ({ bundleId }) =>
      bundleId === 'com.apple.shortcuts'
        ? app(bundleId, 'https://cdn.example.com/s.jpg')
        : app(bundleId, 'https://cdn.example.com/w.jpg'),
    );

    expect(await getIosAutomationIcons()).toEqual({
      shortcuts: 'https://cdn.example.com/s.jpg',
      wallet: 'https://cdn.example.com/w.jpg',
    });
    await getIosAutomationIcons();

    expect(byBundle).toHaveBeenCalledTimes(2);
  });

  it('tries the next storefront, and answers null for an app no storefront lists', async () => {
    byBundle.mockImplementation(async ({ bundleId, storefront }) =>
      bundleId === 'com.apple.shortcuts' && storefront === 'gb' ? app(bundleId, 'https://cdn.example.com/s.jpg') : null,
    );

    expect(await getIosAutomationIcons()).toEqual({ shortcuts: 'https://cdn.example.com/s.jpg', wallet: null });
  });
});
