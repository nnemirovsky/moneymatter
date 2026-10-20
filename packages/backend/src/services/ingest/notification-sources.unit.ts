import {
  NOTIFICATION_SOURCE_KEY_MAX_LENGTH,
  WALLET_BUNDLE_ID,
  buildSourceKey,
  getDefaultSourceMode,
  isConversationalApp,
  isKnownBankApp,
  isWalletApp,
} from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

describe('buildSourceKey', () => {
  it('uses the lower-cased bundle id when there is one', () => {
    expect(buildSourceKey({ bundleId: 'com.apple.Passbook', appName: 'Wallet' })).toBe('com.apple.passbook');
  });

  it('falls back to the normalized app name', () => {
    expect(buildSourceKey({ appName: '  TBC   Bank ' })).toBe('name:tbc bank');
  });

  it('is unknown when the notification names no app', () => {
    expect(buildSourceKey({})).toBe('unknown');
    expect(buildSourceKey({ bundleId: '  ', appName: '' })).toBe('unknown');
  });

  it('appends the sender for a messaging or mail app', () => {
    expect(buildSourceKey({ bundleId: 'com.apple.MobileSMS', sender: 'TBC' })).toBe('com.apple.mobilesms|tbc');
    expect(buildSourceKey({ appName: 'Mail', sender: ' Bank  Alerts ' })).toBe('name:mail|bank alerts');
  });

  it('keeps two senders of one messaging app apart', () => {
    expect(buildSourceKey({ bundleId: 'com.apple.MobileSMS', sender: 'TBC' })).not.toBe(
      buildSourceKey({ bundleId: 'com.apple.MobileSMS', sender: 'Mum' }),
    );
  });

  it('ignores the sender of every other app', () => {
    expect(buildSourceKey({ bundleId: 'ge.tbc.app', sender: 'Anything' })).toBe('ge.tbc.app');
    expect(buildSourceKey({ appName: 'TBC Bank', sender: 'Anything' })).toBe('name:tbc bank');
  });

  it('keeps a messaging app without a sender at the app level', () => {
    expect(buildSourceKey({ bundleId: 'com.apple.MobileSMS', sender: '' })).toBe('com.apple.mobilesms');
  });

  it('cuts the key to the column length', () => {
    const key = buildSourceKey({ bundleId: 'com.apple.MobileSMS', sender: 'x'.repeat(400) });

    expect(key).toHaveLength(NOTIFICATION_SOURCE_KEY_MAX_LENGTH);
  });
});

describe('app classification', () => {
  it('recognizes Wallet by its bundle id only', () => {
    expect(isWalletApp({ bundleId: WALLET_BUNDLE_ID })).toBe(true);
    expect(isWalletApp({ bundleId: 'COM.APPLE.PASSBOOK' })).toBe(true);
    expect(isWalletApp({ appName: 'Wallet' })).toBe(false);
  });

  it.each([
    [{ bundleId: 'com.apple.MobileSMS' }, true],
    [{ bundleId: 'net.whatsapp.WhatsApp' }, true],
    [{ appName: 'Messages' }, true],
    [{ appName: 'Сообщения' }, true],
    [{ appName: 'TBC Bank' }, false],
    [{ bundleId: 'ge.tbc.app', appName: 'Messages' }, false],
  ])('isConversationalApp(%j) is %s', (app, expected) => {
    expect(isConversationalApp(app)).toBe(expected);
  });

  it.each([
    [{ appName: 'TBC Bank' }, true],
    [{ appName: ' tbc  bank ' }, true],
    [{ bundleId: 'com.revolut.revolut' }, true],
    [{ appName: 'Candy Crush' }, false],
  ])('isKnownBankApp(%j) is %s', (app, expected) => {
    expect(isKnownBankApp(app)).toBe(expected);
  });
});

describe('getDefaultSourceMode', () => {
  it('trusts Wallet from the start', () => {
    expect(getDefaultSourceMode({ bundleId: WALLET_BUNDLE_ID })).toBe('auto');
  });

  it('trusts the seeded bank apps from the start', () => {
    expect(getDefaultSourceMode({ appName: 'TBC Bank' })).toBe('auto');
    expect(getDefaultSourceMode({ bundleId: 'com.revolut.revolut' })).toBe('auto');
  });

  it('starts every other app pending', () => {
    expect(getDefaultSourceMode({ bundleId: 'com.example.unknown', appName: 'Example' })).toBe('pending');
    expect(getDefaultSourceMode({})).toBe('pending');
  });

  it('starts a messaging or mail app pending, whatever its sender', () => {
    expect(getDefaultSourceMode({ bundleId: 'com.apple.MobileSMS' })).toBe('pending');
    expect(getDefaultSourceMode({ appName: 'Mail' })).toBe('pending');
  });

  it('matches a seeded bank by name even when its bundle id is not on the list', () => {
    expect(getDefaultSourceMode({ bundleId: 'ge.example.bank', appName: 'TBC Bank' })).toBe('auto');
  });
});
