import {
  CONVERSATIONAL_APP_GATE_PATTERN,
  CONVERSATIONAL_APP_NAMES,
  NOTIFICATION_SOURCE_KEY_MAX_LENGTH,
  WALLET_BUNDLE_ID,
  buildSourceKey,
  findContextApp,
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
    expect(buildSourceKey({ appName: 'bcc.kz' })).toBe('name:bcc.kz');
  });

  it('gives Wallet one key whether it arrives by bundle id or by a localized name', () => {
    const keys = [
      buildSourceKey({ bundleId: 'com.apple.Passbook', appName: 'Wallet' }),
      buildSourceKey({ appName: 'Wallet' }),
      buildSourceKey({ appName: 'Кошелёк' }),
      buildSourceKey({ appName: 'Apple Wallet' }),
    ];

    expect(new Set(keys)).toEqual(new Set(['com.apple.passbook']));
  });

  it('keeps a messaging app named by its display name apart per sender', () => {
    expect(buildSourceKey({ appName: 'Telegram', sender: 'Mum' })).toBe('name:telegram|mum');
    expect(buildSourceKey({ appName: 'Messages', sender: 'TBC' })).toBe('name:messages|tbc');
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
  it('recognizes Wallet by its bundle id', () => {
    expect(isWalletApp({ bundleId: WALLET_BUNDLE_ID })).toBe(true);
    expect(isWalletApp({ bundleId: 'COM.APPLE.PASSBOOK', appName: 'Telegram' })).toBe(true);
  });

  it.each(['Wallet', ' wallet ', 'Apple Wallet', 'Кошелёк', 'Кошелек', 'Гаманець', 'საფულე'])(
    'recognizes Wallet by the display name %j when no bundle id is sent',
    (appName) => {
      expect(isWalletApp({ appName })).toBe(true);
      expect(isWalletApp({ bundleId: '  ', appName })).toBe(true);
    },
  );

  it('lets a bundle id that is not Wallet overrule a Wallet-like name', () => {
    expect(isWalletApp({ bundleId: 'ph.telegra.Telegraph', appName: 'Wallet' })).toBe(false);
  });

  it('does not take other app names for Wallet', () => {
    expect(isWalletApp({ appName: 'Telegram' })).toBe(false);
    expect(isWalletApp({ appName: 'TBC Bank' })).toBe(false);
    expect(isWalletApp({})).toBe(false);
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
    [{ appName: 'bcc.kz' }, true],
    [{ appName: 'BCC.KZ' }, true],
    [{ bundleId: 'com.revolut.revolut' }, true],
    [{ bundleId: 'ge.tbconline.TBC-ipad' }, true],
    [{ bundleId: 'kz.bcc.starbanking' }, true],
    [{ appName: 'Candy Crush' }, false],
  ])('isKnownBankApp(%j) is %s', (app, expected) => {
    expect(isKnownBankApp(app)).toBe(expected);
  });
});

describe('getDefaultSourceMode', () => {
  it('trusts Wallet from the start, by bundle id or by display name', () => {
    expect(getDefaultSourceMode({ bundleId: WALLET_BUNDLE_ID })).toBe('auto');
    expect(getDefaultSourceMode({ appName: 'Wallet' })).toBe('auto');
    expect(getDefaultSourceMode({ appName: 'Кошелёк' })).toBe('auto');
  });

  it('does not trust an app that only calls itself Wallet', () => {
    expect(getDefaultSourceMode({ bundleId: 'com.example.wallet', appName: 'Wallet' })).toBe('pending');
  });

  it('trusts the seeded bank apps from the start', () => {
    expect(getDefaultSourceMode({ appName: 'TBC Bank' })).toBe('auto');
    expect(getDefaultSourceMode({ appName: 'bcc.kz' })).toBe('auto');
    expect(getDefaultSourceMode({ bundleId: 'com.revolut.revolut' })).toBe('auto');
  });

  it('starts the apps the shortcut names but the seed list does not know pending', () => {
    expect(getDefaultSourceMode({ appName: 'Telegram' })).toBe('pending');
    expect(getDefaultSourceMode({ appName: 'Ledger Wallet' })).toBe('pending');
    expect(getDefaultSourceMode({ appName: 'Messages' })).toBe('pending');
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

describe('context apps', () => {
  it('starts a seeded merchant app in the context mode, whatever the case of its name', () => {
    expect(getDefaultSourceMode({ appName: 'Wolt' })).toBe('context');
    expect(getDefaultSourceMode({ appName: 'Uber Eats' })).toBe('context');
    expect(getDefaultSourceMode({ appName: 'Яндекс Еда' })).toBe('context');
  });

  it('does not seed a bare brand that also sells rides', () => {
    expect(getDefaultSourceMode({ appName: 'Bolt' })).toBe('pending');
    expect(getDefaultSourceMode({ appName: 'Uber' })).toBe('pending');
  });

  it('gives a seeded app its service, hints and excludes', () => {
    expect(findContextApp({ appName: 'Bolt Food' })).toMatchObject({ service: 'Bolt Food', hints: ['bolt food', 'bolt.eu/f'] });
    expect(findContextApp({ appName: 'Amazon' })?.excludes).toContain('prime');
    expect(findContextApp({ appName: 'TBC' })).toBeNull();
  });
});

describe('CONVERSATIONAL_APP_GATE_PATTERN', () => {
  const pattern = new RegExp(CONVERSATIONAL_APP_GATE_PATTERN, 'u');

  it('matches every messaging and mail name in display case', () => {
    for (const name of CONVERSATIONAL_APP_NAMES) {
      expect(pattern.test(name)).toBe(true);
      expect(pattern.test(name.toUpperCase())).toBe(true);
    }
    expect(pattern.test('Messages')).toBe(true);
    expect(pattern.test('WhatsApp')).toBe(true);
  });

  it('lets every other app through', () => {
    for (const name of ['Wolt', 'TBC', 'Wallet', 'Raiffeisen', 'Mail Bank']) expect(pattern.test(name)).toBe(false);
  });
});
