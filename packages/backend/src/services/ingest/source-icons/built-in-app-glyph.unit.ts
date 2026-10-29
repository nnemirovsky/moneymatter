import { getBuiltInAppGlyph, getKnownBundleId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

describe('getBuiltInAppGlyph', () => {
  it.each([
    [{ bundleId: 'com.apple.MobileSMS', appName: null }, 'messages'],
    [{ bundleId: null, appName: 'Messages' }, 'messages'],
    [{ bundleId: null, appName: ' iMessage ' }, 'messages'],
    [{ bundleId: 'com.apple.Passbook', appName: null }, 'wallet'],
    [{ bundleId: null, appName: 'Wallet' }, 'wallet'],
  ])('knows the built-in app %j', (app, glyph) => {
    expect(getBuiltInAppGlyph(app)).toBe(glyph);
  });

  it('has no glyph for Mail, which is on the App Store, nor for any other app', () => {
    expect(getBuiltInAppGlyph({ bundleId: 'com.apple.mobilemail', appName: 'Mail' })).toBeNull();
    expect(getBuiltInAppGlyph({ bundleId: null, appName: 'Example Notes' })).toBeNull();
    expect(getBuiltInAppGlyph({ bundleId: null, appName: null })).toBeNull();
  });

  it('lets a bundle id decide over a name', () => {
    expect(getBuiltInAppGlyph({ bundleId: 'com.example.chat', appName: 'Messages' })).toBeNull();
  });
});

describe('getKnownBundleId', () => {
  it.each([
    ['Mail', 'com.apple.mobilemail'],
    [' MESSAGES ', 'com.apple.MobileSMS'],
    ['Wallet', 'com.apple.Passbook'],
    ['Gmail', 'com.google.Gmail'],
    ['Shortcuts', 'com.apple.shortcuts'],
  ])('knows %s', (appName, bundleId) => {
    expect(getKnownBundleId({ appName })).toBe(bundleId);
  });

  it('knows nothing of an app that is not on the list', () => {
    expect(getKnownBundleId({ appName: 'Example Notes' })).toBeNull();
    expect(getKnownBundleId({ appName: null })).toBeNull();
  });
});
