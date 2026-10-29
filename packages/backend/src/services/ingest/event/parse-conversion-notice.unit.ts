import { describe, expect, it } from '@jest/globals';

import { parseConversionNotice } from './parse-conversion-notice';

const read = ({ body, title = 'Example Bank', raw = null }: { body: string; title?: string; raw?: string | null }) =>
  parseConversionNotice({ text: { title, subtitle: '', body, raw } });

describe('parseConversionNotice', () => {
  it('reads both sides of an exchange from a notice with the rate, by line', () => {
    const result = read({
      body: 'x',
      raw: 'Example Bank\nCurrency exchange\nSold 100.00 USD\nBought 90.00 EUR\nRate 0.9',
    });

    expect(result).toMatchObject({
      debit: { kind: 'debit', amount: '100', currencyCode: 'USD', merchant: null, occurredAt: null },
      credit: { kind: 'credit', amount: '90', currencyCode: 'EUR', merchant: null, occurredAt: null },
    });
  });

  it('reads a notice worded as an arrow between the two amounts', () => {
    expect(read({ body: 'Exchanged 100.00 USD → 90.00 EUR' })).toMatchObject({
      debit: { kind: 'debit', amount: '100', currencyCode: 'USD' },
      credit: { kind: 'credit', amount: '90', currencyCode: 'EUR' },
    });
  });

  it('reads the same notice with its line breaks collapsed', () => {
    expect(read({ body: 'Currency exchange: sold 100.00 USD, bought 90.00 EUR at 0.9' })).toMatchObject({
      debit: { amount: '100', currencyCode: 'USD' },
      credit: { amount: '90', currencyCode: 'EUR' },
    });
  });

  it('recognises an exchange by a printed rate that matches the amounts, whatever the wording', () => {
    expect(read({ body: 'Neue Mitteilung 100.00 USD 90.00 EUR 0.9' })).not.toBeNull();
    // The rate may be printed the other way round.
    expect(read({ body: 'Mi 100.00 USD 90.00 EUR 1.1111' })).not.toBeNull();
  });

  it('recognises an exchange by its wording when no rate is printed', () => {
    expect(read({ body: 'Currency exchange 100.00 USD 90.00 EUR' })).not.toBeNull();
    expect(read({ body: 'Обмен валюты 100.00 USD 90.00 EUR' })).not.toBeNull();
  });

  it.each([
    ['one amount', 'Conversion 100.00 USD'],
    ['two amounts in one currency', 'Conversion 100.00 USD 90.00 USD'],
    ['a third amount, such as a balance', 'Conversion 100.00 USD 90.00 EUR Balance 1,000.00 EUR'],
    ['no exchange evidence', 'Purchase 100.00 USD 90.00 EUR'],
    ['a printed number that is not the rate', 'Offer 100.00 USD 90.00 EUR 7.5'],
    ['money received', 'Conversion received 100.00 USD 90.00 EUR'],
    ['a refusal', 'Conversion declined 100.00 USD 90.00 EUR'],
    ['a pending exchange', 'Conversion pending 100.00 USD 90.00 EUR'],
    ['signed amounts', 'Conversion -100.00 USD +90.00 EUR'],
    ['an amount without a currency', 'Conversion 100.00 USD 90.00'],
    ['spaced digits that may join two numbers', 'Conversion 100.00 USD 1 090.00 EUR'],
    ['a long text', `Conversion 100.00 USD 90.00 EUR ${'padding '.repeat(60)}`],
  ])('leaves %s to the other readers', (_name, body) => {
    expect(read({ body })).toBeNull();
  });
});
