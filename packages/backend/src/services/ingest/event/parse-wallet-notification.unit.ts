import { describe, expect, it } from '@jest/globals';

import { WALLET_BUNDLE, walletFixtures } from './fixtures/notifications';
import { parseWalletNotification } from './parse-wallet-notification';

const parse = ({ fixture }: { fixture: (typeof walletFixtures)[keyof typeof walletFixtures] }) =>
  parseWalletNotification({
    bundleId: fixture.bundleId,
    appName: fixture.appName,
    title: fixture.title,
    subtitle: fixture.subtitle,
    body: fixture.body,
  });

describe('app recognition', () => {
  it('reads a Wallet notification that arrives by display name only', () => {
    const result = parseWalletNotification({
      bundleId: null,
      appName: 'Wallet',
      title: 'Example Visa',
      subtitle: 'Wolt',
      body: 'GEL 43.60',
    });

    expect(result?.classified.payment.merchant).toBe('Wolt');
  });

  it('refuses another app, even one that prints the same layout', () => {
    expect(
      parseWalletNotification({
        bundleId: 'ph.telegra.Telegraph',
        appName: 'Wallet',
        title: 'Example Visa',
        subtitle: 'Wolt',
        body: 'GEL 43.60',
      }),
    ).toBeNull();
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
          cardName: 'Example Bank',
          cardLastDigits: null,
          balanceAfter: null,
          occurredAt: null,
        },
      },
    });
  });

  it('reads the online Wolt payment of the owner phone: card as the title, merchant as the subtitle, GEL before the number', () => {
    const result = parse({ fixture: walletFixtures.woltOnline });

    expect(result?.classified.payment).toMatchObject({
      kind: 'debit',
      amount: '29.41',
      currencyCode: 'GEL',
      merchant: 'Wolt',
      cardName: 'Example Bank',
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
        title: 'Example Bank',
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
