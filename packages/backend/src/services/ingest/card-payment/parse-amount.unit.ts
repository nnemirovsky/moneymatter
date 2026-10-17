import { describe, expect, it } from '@jest/globals';

import { parseAmount } from './parse-amount';

const NBSP = ' ';
const NARROW_NBSP = ' ';

const ok = ({
  amount,
  currencyCode = null,
  symbol = null,
}: {
  amount: string;
  currencyCode?: string | null;
  symbol?: string | null;
}) => ({
  ok: true,
  amount,
  currencyCode,
  symbol,
});

describe('parseAmount', () => {
  describe('plain numbers', () => {
    it.each([
      ['an integer', 47, '47'],
      ['a decimal number', 47.5, '47.5'],
      ['a number JSON would write with an exponent', 1e-7, '0.0000001'],
      ['a three-decimal number, read as a decimal, not as thousands (KWD)', 1.234, '1.234'],
      ['a larger three-decimal number', 1234.567, '1234.567'],
      ['a number that looks like a grouped integer', 12.345, '12.345'],
      ['an integer string', '47', '47'],
      ['a dot decimal', '47.00', '47'],
      ['a comma decimal', '47,00', '47'],
      ['a fraction that is not zero', '47,50', '47.5'],
      ['a leading separator', '.5', '0.5'],
      ['a leading zero', '007.25', '7.25'],
      ['surrounding whitespace', '  47.00  ', '47'],
    ])('%s', (_name, input, amount) => {
      expect(parseAmount({ input })).toEqual(ok({ amount }));
    });
  });

  describe('thousands and decimal separators', () => {
    it('still reads a three-digit group in a string as thousands', () => {
      expect(parseAmount({ input: '1.234' })).toEqual(ok({ amount: '1234' }));
    });

    it.each([
      ['comma thousands, dot decimal', '1,234.56', '1234.56'],
      ['dot thousands, comma decimal', '1.234,56', '1234.56'],
      ['a space thousands separator', '1 234,56', '1234.56'],
      ['a non-breaking space', `1${NBSP}234,56`, '1234.56'],
      ['a narrow non-breaking space', `1${NARROW_NBSP}234,56`, '1234.56'],
      ['a thin space', '1 234.56', '1234.56'],
      ['an apostrophe (Swiss)', "1'234.56", '1234.56'],
      ['a typographic apostrophe', '1’234.56', '1234.56'],
      ['repeated comma thousands', '1,234,567', '1234567'],
      ['repeated dot thousands', '1.234.567', '1234567'],
      ['repeated thousands with a decimal', '1,234,567.89', '1234567.89'],
      ['the Indian grouping', '12,34,567.00', '1234567'],
      ['Arabic-Indic digits', '٤٧٫٥٠', '47.5'],
      ['Persian digits with Arabic separators', '۱٬۲۳۴٫۵۶', '1234.56'],
      ['full-width digits', '４７', '47'],
    ])('%s', (_name, input, amount) => {
      expect(parseAmount({ input })).toEqual(ok({ amount }));
    });

    it.each([
      // Exactly 3 digits after a lone separator, 1-3 digits before it and no other separator: thousands.
      ['1,234 reads as thousands', '1,234', '1234'],
      ['1.234 reads as thousands', '1.234', '1234'],
      ['12,345 reads as thousands', '12,345', '12345'],
      ['123,456 reads as thousands', '123,456', '123456'],
      // Anything else is a decimal separator.
      ['two digits after the separator read as decimal', '1,23', '1.23'],
      ['one digit after the separator reads as decimal', '1,2', '1.2'],
      ['four digits after the separator read as decimal', '1,2345', '1.2345'],
      ['a zero integer part reads as decimal', '0,500', '0.5'],
      ['a long integer part reads as decimal', '1234,567', '1234.567'],
      ['another separator in play reads as decimal', '1 234,567', '1234.567'],
    ])('%s', (_name, input, amount) => {
      expect(parseAmount({ input })).toEqual(ok({ amount }));
    });
  });

  describe('currency symbols and codes', () => {
    it.each([
      ['a leading symbol', '₾47.00', '47', null, '₾'],
      ['a trailing symbol', '47,00 ₾', '47', null, '₾'],
      ['a symbol with a space', '€ 12,50', '12.5', null, '€'],
      ['a euro symbol after a grouped amount', `1${NBSP}234,56${NBSP}€`, '1234.56', null, '€'],
      ['a dollar symbol', '$1,234.56', '1234.56', null, '$'],
      ['a prefixed dollar symbol', 'US$12.00', '12', null, 'US$'],
      ['a letter symbol', '47 zł', '47', null, 'zł'],
      ['a full-width yen', '￥1,200', '1200', null, '¥'],
      ['a trailing code', '47.00 GEL', '47', 'GEL', null],
      ['a leading code', 'GEL 47', '47', 'GEL', null],
      ['a lower-case code', '47 eur', '47', 'EUR', null],
      ['a code glued to the number', 'USD47.50', '47.5', 'USD', null],
      ['a symbol and a code', '₾47.00 GEL', '47', 'GEL', '₾'],
      ['invisible direction marks around the text', '‎₾47.00‏', '47', null, '₾'],
    ])('%s', (_name, input, amount, currencyCode, symbol) => {
      expect(parseAmount({ input })).toEqual(ok({ amount, currencyCode, symbol }));
    });
  });

  describe('signs', () => {
    it.each([
      ['a leading minus', '-47'],
      ['a Unicode minus', '−47.00'],
      ['a minus before the symbol', '-₾47.00'],
      ['a minus after the symbol', '₾-47.00'],
      ['a trailing minus', '47.00-'],
      ['accounting parentheses', '(47.00)'],
      ['a negative number', -47],
    ])('%s is negative', (_name, input) => {
      expect(parseAmount({ input })).toEqual({ ok: false, reason: 'negative' });
    });

    it('ignores a plus sign', () => {
      expect(parseAmount({ input: '+47.00' })).toEqual(ok({ amount: '47' }));
    });
  });

  describe('zero', () => {
    it.each([
      ['the number 0', 0],
      ['the text 0', '0'],
      ['the text 0.00', '0.00'],
      ['a comma zero', '0,00'],
      ['a symbol and zero', '₾0.00'],
      ['a negative zero', '-0'],
    ])('%s is zero', (_name, input) => {
      expect(parseAmount({ input })).toEqual({ ok: false, reason: 'zero' });
    });
  });

  describe('unreadable input', () => {
    it.each([
      ['an empty string', ''],
      ['whitespace', '   '],
      ['letters', 'abc'],
      ['a missing value', undefined],
      ['null', null],
      ['an object', { amount: 47 }],
      ['an array', [47]],
      ['a boolean', true],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['two numbers', '47 12'],
      ['a number with words around it', 'Total 47 only'],
      ['two currency codes', 'USD GEL 47'],
      ['two symbols', '₾ € 47'],
      ['a symbol and a word that is not a currency', '₾47 apples'],
      ['a trailing separator', '47.'],
      ['a thousands group of the wrong size', '12,34.56'],
      ['mixed group separators', '1,234 567'],
      ['a decimal separator used twice', '1,234.56.7'],
      ['both separators in the wrong layout', '1.234.567,89,1'],
      ['a space inside the number that is not a thousands group', '47 00'],
      ['an unbalanced parenthesis', '(47.00'],
      ['two minus signs', '--47'],
      ['more than 15 integer digits', '1234567890123456'],
      ['more than 8 fraction digits', '1.123456789'],
      ['an overlong string', `${'1'.repeat(70)}`],
      ['a word that is also an Object property', 'constructor 47'],
    ])('%s is invalid', (_name, input) => {
      expect(parseAmount({ input })).toEqual({ ok: false, reason: 'invalid' });
    });
  });
});
