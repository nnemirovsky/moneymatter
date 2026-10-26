import { describe, expect, it } from '@jest/globals';

import { parseBankPushByRules } from './parse-bank-push-by-rules';

const push = ({ title = '', subtitle = '', body }: { title?: string; subtitle?: string; body: string }) => ({
  title,
  subtitle,
  body,
  raw: null,
});

const read = ({ body, title = 'Example Bank' }: { body: string; title?: string }) =>
  parseBankPushByRules({ text: push({ title, body }), appName: 'Example Bank' });

const collapsed = (body: string) =>
  parseBankPushByRules({ text: { title: 'Example Bank', subtitle: '', body, raw: null }, appName: 'Example Bank' });

describe('parseBankPushByRules', () => {
  it('reads an amount line, a card line and a merchant line with the date', () => {
    const result = read({ body: 'Purchase 60.64 EUR\nVisa *1234\nCafe Moon 15.01.2026 17:38' });

    expect(result).toMatchObject({
      symbol: null,
      classified: {
        parser: 'rules',
        kind: 'debit',
        verdict: 'payment',
        confidence: 0.9,
        payment: {
          kind: 'debit',
          stage: 'payment',
          amount: '60.64',
          currencyCode: 'EUR',
          merchant: 'Cafe Moon',
          cardName: 'Visa',
          cardLastDigits: '1234',
          payee: null,
        },
      },
    });
    expect(result!.classified.payment.occurredAt).toEqual(new Date('2026-01-15T17:38:00'));
  });

  it('reads the same push when its line breaks are collapsed into one line', () => {
    const result = parseBankPushByRules({
      text: {
        title: 'Example Bank',
        subtitle: '',
        body: 'Purchase 60.64 EUR Visa *1234 Cafe Moon 15.01.2026 17:38',
        raw: null,
      },
      appName: 'Example Bank',
    });

    expect(result?.classified.payment).toMatchObject({
      kind: 'debit',
      amount: '60.64',
      currencyCode: 'EUR',
      merchant: 'Cafe Moon',
      cardName: 'Visa',
      cardLastDigits: '1234',
    });
  });

  it('uses the line breaks of the device rendering when it has them', () => {
    const result = parseBankPushByRules({
      text: {
        title: 'Example Bank',
        subtitle: '',
        body: 'Purchase 60.64 EUR Cafe Moon',
        raw: 'Example Bank\nPurchase 60.64 EUR\nCafe Moon',
      },
      appName: 'Example Bank',
    });

    expect(result?.classified.payment.merchant).toBe('Cafe Moon');
  });

  it('leaves the bank wording of an exchange or a card label to the AI, collapsed or not', () => {
    expect(collapsed('Deposit Money: 360.00 EUR EXAMPLE CARD 15/01/2026')).toBeNull();
    expect(read({ body: 'Deposit Money: 360.00 EUR\nEXAMPLE CARD\n15/01/2026' })).toBeNull();
  });

  it('reads the one-line form with the amount first and the merchant after a comma', () => {
    expect(read({ body: '60.64 EUR, Cafe Moon, card payment' })?.classified.payment).toMatchObject({
      kind: 'debit',
      amount: '60.64',
      currencyCode: 'EUR',
      merchant: 'Cafe Moon',
    });
  });

  it('reads a balance line apart from the payment', () => {
    const payment = read({ body: 'Payment: USD 12.50\nShop Blue\nBalance: USD 1,204.30' })?.classified.payment;

    expect(payment).toMatchObject({
      amount: '12.5',
      currencyCode: 'USD',
      merchant: 'Shop Blue',
      balanceAfter: { amount: '1204.3', currencyCode: 'USD', scopeHint: 'unknown' },
    });
  });

  it('takes a minus sign as a debit and a plus sign as a credit', () => {
    expect(read({ body: '-15.00 EUR\nGrocery Hub' })?.classified.payment).toMatchObject({
      kind: 'debit',
      amount: '15',
    });
    expect(read({ body: '+250.00 EUR\nEmployer Ltd' })?.classified.payment).toMatchObject({
      kind: 'credit',
      amount: '250',
      merchant: 'Employer Ltd',
    });
  });

  it('reads a credit from its word', () => {
    expect(read({ body: 'Refund 9.99 EUR\nShop Blue' })?.classified.payment).toMatchObject({
      kind: 'credit',
      merchant: 'Shop Blue',
    });
  });

  it('keeps a shared symbol for the caller to settle and gives no currency code', () => {
    const result = read({ body: 'Purchase $9.99\nStreaming Co' });

    expect(result).toMatchObject({ symbol: '$', classified: { payment: { amount: '9.99', currencyCode: null } } });
  });

  it('does not take the bank name on the title line for the merchant', () => {
    expect(read({ title: 'Example Bank', body: 'Purchase 8.00 EUR\nBakery One' })?.classified.payment.merchant).toBe(
      'Bakery One',
    );
  });

  it.each([
    ['no direction stated', '60.64 EUR\nCafe Moon'],
    ['two amounts', 'Purchase 60.64 EUR and 12.00 EUR\nCafe Moon'],
    ['no currency', 'Purchase 60.64\nCafe Moon'],
    ['a declined payment', 'Payment of 60.64 EUR declined\nCafe Moon'],
    ['a hold', 'Purchase 60.64 EUR pending\nCafe Moon'],
    ['a transfer', 'Transfer 60.64 EUR\nJohn'],
    ['an exchange', 'Exchange 60.64 EUR\nCafe Moon'],
    ['two possible merchants', 'Purchase 60.64 EUR\nCafe Moon\nBakery One'],
    ['a long message', `Purchase 60.64 EUR\n${'Lorem ipsum dolor sit amet '.repeat(20)}`],
    ['an empty text', ''],
  ])('leaves %s to the AI', (_name, body) => {
    expect(read({ body })).toBeNull();
  });

  it('does not take a word that is not an ISO currency code for a currency', () => {
    expect(read({ body: 'Purchase 25.00 FOR\nStreaming Co' })).toBeNull();
    expect(read({ body: 'Purchase for 25.00\nStreaming Co' })).toBeNull();
    expect(read({ body: 'Purchase ABC 25.00\nStreaming Co' })).toBeNull();
  });

  it('takes the currency from a symbol and ignores a code written before it', () => {
    const payment = read({ body: 'Purchase EUR $25.00\nStreaming Co' })?.classified.payment;

    expect(payment?.currencyCode).toBeNull();
  });

  it('does not join the digits of a time with the amount after it', () => {
    const payment = read({ body: 'Purchase 09:15 125.00 USD\nStreaming Co' })?.classified.payment;

    expect(payment).toMatchObject({ amount: '125', currencyCode: 'USD' });
  });

  it('leaves a number printed before the amount to the AI instead of joining the two', () => {
    expect(read({ body: 'Purchase\nWALMART 512 125.00 USD' })).toBeNull();
    expect(read({ body: 'Purchase WALMART 512 125.00 USD' })).toBeNull();
  });

  it('leaves a payment from someone, a failed or reminder notice and a sentence to the AI', () => {
    expect(read({ body: 'Payment from John 500.00 USD' })).toBeNull();
    expect(read({ body: 'Purchase 25.00 USD unsuccessful\nShop Blue' })).toBeNull();
    expect(read({ body: 'Purchase 25.00 USD is due\nShop Blue' })).toBeNull();
    expect(read({ body: 'Card payment for $25.00 at Shop' })).toBeNull();
    expect(
      read({ body: 'Purchase 25.00 USD\nShop Blue and the big store next door that sells all kinds of things' }),
    ).toBeNull();
  });

  it('does not read the digits of a masked card as an amount', () => {
    const payment = read({ body: 'Purchase 5.00 EUR\nCard *4321\nKiosk 7' })?.classified.payment;

    expect(payment).toMatchObject({ amount: '5', cardLastDigits: '4321' });
  });
});
