import { describe, expect, it } from '@jest/globals';

import { WALLET_BUNDLE, walletFixtures } from './fixtures/notifications';
import { isWalletNotificationApp, parseWalletNotification } from './parse-wallet-notification';

const parse = ({ fixture }: { fixture: (typeof walletFixtures)[keyof typeof walletFixtures] }) =>
  parseWalletNotification({
    bundleId: fixture.bundleId,
    appName: fixture.appName,
    title: fixture.title,
    subtitle: fixture.subtitle,
    body: fixture.body,
  });

describe('isWalletNotificationApp', () => {
  it('recognises the Wallet bundle id, whatever the name says', () => {
    expect(isWalletNotificationApp({ bundleId: WALLET_BUNDLE, appName: 'Telegram' })).toBe(true);
    expect(isWalletNotificationApp({ bundleId: 'com.apple.passbook', appName: null })).toBe(true);
  });

  it('recognises the display name only when there is no bundle id', () => {
    expect(isWalletNotificationApp({ bundleId: null, appName: 'Wallet' })).toBe(true);
    expect(isWalletNotificationApp({ bundleId: null, appName: '  Кошелёк ' })).toBe(true);
    expect(isWalletNotificationApp({ bundleId: 'ph.telegra.Telegraph', appName: 'Wallet' })).toBe(false);
  });

  it('refuses every other app', () => {
    expect(isWalletNotificationApp({ bundleId: null, appName: 'Telegram' })).toBe(false);
    expect(isWalletNotificationApp({ bundleId: null, appName: null })).toBe(false);
  });
});

describe('parseWalletNotification', () => {
  it('reads the card, the merchant and the amount of the fixed layout as a debit', () => {
    const result = parse({ fixture: walletFixtures.wolt });

    expect(result).toEqual({
      symbol: null,
      classified: {
        parser: 'wallet',
        kind: 'debit',
        confidence: 1,
        verdict: 'payment',
        payment: {
          kind: 'debit',
          stage: 'payment',
          amount: '43.6',
          currencyCode: 'GEL',
          originalAmount: null,
          originalCurrencyCode: null,
          merchant: 'Wolt',
          payee: null,
          cardName: 'TBC Bank',
          cardLastDigits: null,
          balanceAfter: null,
          occurredAt: null,
        },
      },
    });
  });

  it('reads a Wallet notification that carries only the display name', () => {
    expect(parse({ fixture: walletFixtures.woltByName })?.classified.payment.merchant).toBe('Wolt');
  });

  it('returns the currency symbol for the caller to resolve', () => {
    const result = parse({ fixture: walletFixtures.dollarSymbol });

    expect(result?.symbol).toBe('$');
    expect(result?.classified.payment).toMatchObject({ amount: '9.99', currencyCode: null, merchant: 'Apple' });
  });

  it('reads a grouped amount with a trailing code', () => {
    expect(parse({ fixture: walletFixtures.groupedAmount })?.classified.payment).toMatchObject({
      amount: '1234.5',
      currencyCode: 'EUR',
    });
  });

  it('leaves a body with words in it to the AI', () => {
    expect(parse({ fixture: walletFixtures.sentence })).toBeNull();
  });

  it.each([
    ['a blank merchant', { subtitle: '  ' }],
    ['a negative amount', { body: '-GEL 5.00' }],
    ['a zero amount', { body: 'GEL 0.00' }],
    ['an empty body', { body: '' }],
  ])('returns null for %s', (_, override) => {
    expect(
      parseWalletNotification({
        bundleId: WALLET_BUNDLE,
        appName: 'Wallet',
        title: 'TBC Bank',
        subtitle: 'Wolt',
        body: 'GEL 43.60',
        ...override,
      }),
    ).toBeNull();
  });

  it('does not take the layout from another app', () => {
    expect(
      parseWalletNotification({
        bundleId: 'ph.telegra.Telegraph',
        appName: 'Telegram',
        title: 'Anna',
        subtitle: 'Wolt',
        body: 'GEL 43.60',
      }),
    ).toBeNull();
  });

  it('has no card when the title is blank', () => {
    expect(
      parseWalletNotification({ bundleId: WALLET_BUNDLE, appName: null, title: ' ', subtitle: 'Wolt', body: 'GEL 1' })
        ?.classified.payment.cardName,
    ).toBeNull();
  });
});
