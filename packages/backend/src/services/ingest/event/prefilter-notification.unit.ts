import { AMOUNT_GATE_SAMPLES, type GateStrictness } from '@bt/shared/types';
import { i18nextReady } from '@i18n/index';
import { beforeAll, describe, expect, it } from '@jest/globals';

import { blueCoffeeTap } from './fixtures/notifications';
import { prefilterNotification } from './prefilter-notification';

const filter = ({
  title = 'Example Bank',
  subtitle = '',
  body,
  strictness = 'standard',
  bundleId = 'ge.example.app',
  appName = 'Example Bank',
}: {
  title?: string;
  subtitle?: string;
  body: string;
  strictness?: GateStrictness;
  bundleId?: string | null;
  appName?: string | null;
}) =>
  prefilterNotification({
    bundleId,
    appName,
    title,
    subtitle,
    body,
    strictness,
  });

beforeAll(async () => {
  await i18nextReady;
});

describe('prefilterNotification', () => {
  describe('the amount', () => {
    it('passes a payment and reports the part the gate matched', () => {
      expect(filter({ title: 'Example Bank', subtitle: 'Wolt', body: 'GEL 43.60' })).toEqual({
        pass: true,
        amountText: 'GEL 43.60',
      });
    });

    it.each(['Your balance is looking good', 'See you tonight at 20:30', 'Order #4521 shipped', ''])(
      'drops "%s" as noAmount',
      (body) => {
        expect(filter({ title: '', body })).toEqual({
          pass: false,
          reason: 'noAmount',
        });
      },
    );

    it('passes the Example push that ends in a cashback credit and a piggy-bank balance, matching the payment amount', () => {
      const { title, subtitle, body } = blueCoffeeTap.bankPush;

      expect(filter({ title, subtitle, body })).toEqual({
        pass: true,
        amountText: '48.00 GEL',
      });
    });

    it.each(['strict', 'standard', 'loose'] as const)(
      'passes the real Example push of the Blue Cofee payment at %s',
      (strictness) => {
        const { title, subtitle, body } = blueCoffeeTap.bankPush;

        expect(filter({ title, subtitle, body, strictness }).pass).toBe(true);
      },
    );

    it('follows the strictness of the user', () => {
      const body = 'Purchase at Wolt 43.60';

      expect(filter({ body, strictness: 'standard' })).toEqual({
        pass: false,
        reason: 'noAmount',
      });
      expect(filter({ body, strictness: 'loose' })).toMatchObject({
        pass: true,
      });
    });

    it.each(AMOUNT_GATE_SAMPLES.filter((sample) => sample.minLevel === null))(
      'drops the gate sample "$text" at every level',
      ({ text }) => {
        for (const strictness of ['strict', 'standard', 'loose'] as const) {
          expect(filter({ title: '', body: text, strictness })).toMatchObject({
            pass: false,
          });
        }
      },
    );
  });

  describe('security', () => {
    it.each([
      'Your code 482913 for the payment of 43.60 GEL. Enter it to confirm.',
      'Confirm the payment of 43.60 GEL with code 482913. Do not share this code with anyone.',
      'Введите код 482913 для подтверждения оплаты 43.60 GEL',
      'Введіть код 482913 для підтвердження оплати 43.60 GEL',
      'შეიყვანეთ კოდი 482913 გადახდის დასადასტურებლად 43.60 GEL',
      'Do not share 4829 with anyone. Payment 12.00 EUR',
    ])('drops an OTP request: %s', (body) => {
      expect(filter({ title: '', body })).toEqual({
        pass: false,
        reason: 'security',
      });
    });

    it.each([
      'Payment 43.60 GEL, auth code 482913',
      'Purchase 43.60 GEL at Wolt. Authorization code: 482913',
      'Payment approved, approval code 482913, 43.60 GEL',
      'Оплата 43.60 GEL, код авторизации 482913',
    ])('passes a completed payment that states its code: %s', (body) => {
      expect(filter({ title: '', body })).toMatchObject({ pass: true });
    });

    it('passes a code that nobody asks the user to enter or hide', () => {
      expect(
        filter({
          title: '',
          body: 'Reference 482913: payment of 43.60 GEL received',
        }),
      ).toMatchObject({
        pass: true,
      });
    });

    it('does not read the digits of a card, an amount or a date as a code', () => {
      expect(
        filter({
          title: '',
          body: 'Confirm 1,234.50 EUR on card *4821 on 2026-10-20',
        }),
      ).toMatchObject({
        pass: true,
      });
    });

    it('needs a code: a request without a standalone code passes', () => {
      expect(
        filter({
          title: '',
          body: 'Please confirm the payment of 43.60 GEL in the app',
        }),
      ).toMatchObject({
        pass: true,
      });
    });
  });

  describe('promo', () => {
    it.each([
      'Get 20% off orders over 50 GEL this weekend',
      'Cashback up to 10% on purchases above 100 GEL',
      'Скидка 30% на заказы от 50 GEL',
      'Знижка 15% на замовлення від 200 UAH',
      'ფასდაკლება 20% შეკვეთებზე 50 GEL-დან',
      'Use promo code SAVE20 and get 5 EUR off',
    ])('drops a promo: %s', (body) => {
      expect(filter({ title: '', body })).toEqual({
        pass: false,
        reason: 'promo',
      });
    });

    it.each([
      'Purchase 43.60 GEL at Wolt, card *1234, cashback 2%',
      'Payment 43.60 GEL. Balance 1,250.00 GEL. 20% off your next order',
      'Покупка 43.60 GEL, остаток 1250.00 GEL. Скидка 5% на следующий заказ',
    ])('passes a payment that mentions a promo word: %s', (body) => {
      expect(filter({ title: '', body })).toMatchObject({ pass: true });
    });
  });

  describe('own output', () => {
    it.each([
      'Logged 43.60 GEL at Wolt → Food',
      'Already logged 43.60 GEL at Wolt → Food',
      'Noted 43.60 GEL at Wolt → Food; the bank sync will confirm it',
      'Needs your OK in MoneyMatter: 43.60 GEL at Wolt',
      'Queued, will appear shortly',
      'Not logged yet: link the card "Example Visa" in MoneyMatter → Accounts → iOS Automation',
    ])('drops our own banner "%s" before it is read as a payment', (body) => {
      expect(filter({ title: '', body, bundleId: null, appName: null })).toEqual({ pass: false, reason: 'self' });
    });

    it('recognizes a banner in another language', () => {
      expect(
        filter({
          title: '',
          body: 'Записано 43.60 GEL: Wolt → Їжа',
          bundleId: null,
          appName: null,
        }),
      ).toEqual({
        pass: false,
        reason: 'self',
      });
    });

    it.each([
      ['the Shortcuts app by bundle id', 'com.apple.shortcuts', null],
      ['the Shortcuts app by name', null, 'Shortcuts'],
      ['the Shortcuts app by a translated name', null, 'Команды'],
      ['the MoneyMatter web app by name', null, 'MoneyMatter'],
    ])('drops a notification from %s', (_name, bundleId, appName) => {
      expect(filter({ title: 'Payment', body: 'GEL 43.60', bundleId, appName })).toEqual({
        pass: false,
        reason: 'self',
      });
    });

    it('does not take a bank for MoneyMatter', () => {
      expect(
        filter({
          title: 'Example Bank',
          body: 'Logged out of Example. Balance GEL 10.00',
        }).pass,
      ).toBe(true);
    });

    it('drops our output ahead of the other checks, so an amount in it does not matter', () => {
      expect(
        filter({
          title: '',
          body: 'Logged 43.60 GEL at Wolt → Food',
          strictness: 'strict',
        }),
      ).toEqual({
        pass: false,
        reason: 'self',
      });
    });
  });
});
