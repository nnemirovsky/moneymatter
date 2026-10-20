import { describe, expect, it } from '@jest/globals';

import { resolveCurrency, resolveStatedCurrency } from './resolve-currency';

const base = {
  explicitCurrency: null,
  textCode: null,
  textSymbol: null,
  userCurrencyCodes: ['GEL', 'EUR', 'USD'],
  accountCurrencyCode: 'GEL',
};

describe('resolveCurrency', () => {
  it('prefers an explicit currency over everything else', () => {
    expect(resolveCurrency({ ...base, explicitCurrency: 'eur', textCode: 'USD', textSymbol: '₾' })).toEqual({
      ok: true,
      currencyCode: 'EUR',
      source: 'explicit',
    });
  });

  it('rejects an explicit currency that is not shaped like a code', () => {
    expect(resolveCurrency({ ...base, explicitCurrency: 'dollars!' })).toEqual({
      ok: false,
      reason: 'invalidCurrency',
    });
    expect(resolveCurrency({ ...base, explicitCurrency: 'A' })).toEqual({ ok: false, reason: 'invalidCurrency' });
  });

  it('accepts a custom code up to the repo limit and refuses a longer one', () => {
    expect(resolveCurrency({ ...base, explicitCurrency: 'loyaltypoints' })).toEqual({
      ok: true,
      currencyCode: 'LOYALTYPOINTS',
      source: 'explicit',
    });
    expect(resolveCurrency({ ...base, explicitCurrency: 'A'.repeat(16) })).toMatchObject({ ok: true });
    expect(resolveCurrency({ ...base, explicitCurrency: 'A'.repeat(17) })).toEqual({
      ok: false,
      reason: 'invalidCurrency',
    });
  });

  it('takes a code written in the amount text', () => {
    expect(resolveCurrency({ ...base, textCode: 'usd' })).toEqual({
      ok: true,
      currencyCode: 'USD',
      source: 'text-code',
    });
  });

  it('accepts a symbol that agrees with the code next to it', () => {
    expect(resolveCurrency({ ...base, textCode: 'GEL', textSymbol: '₾' })).toEqual({
      ok: true,
      currencyCode: 'GEL',
      source: 'text-code',
    });
    expect(resolveCurrency({ ...base, textCode: 'USD', textSymbol: '$' })).toEqual({
      ok: true,
      currencyCode: 'USD',
      source: 'text-code',
    });
  });

  it('is an error when the code and the symbol name different currencies', () => {
    expect(resolveCurrency({ ...base, textCode: 'USD', textSymbol: '€' })).toEqual({
      ok: false,
      reason: 'currencyConflict',
    });
    expect(resolveCurrency({ ...base, textCode: 'GEL', textSymbol: '$' })).toEqual({
      ok: false,
      reason: 'currencyConflict',
    });
  });

  it('maps a symbol with one candidate to that currency', () => {
    expect(resolveCurrency({ ...base, textSymbol: '€', accountCurrencyCode: 'GEL' })).toEqual({
      ok: true,
      currencyCode: 'EUR',
      source: 'symbol',
    });
  });

  it('maps a symbol with one candidate even when the user does not hold that currency', () => {
    expect(resolveCurrency({ ...base, textSymbol: '₴', userCurrencyCodes: ['GEL'] })).toEqual({
      ok: true,
      currencyCode: 'UAH',
      source: 'symbol',
    });
  });

  it('maps a shared symbol to the one candidate the user holds', () => {
    expect(resolveCurrency({ ...base, textSymbol: '$', accountCurrencyCode: 'GEL' })).toEqual({
      ok: true,
      currencyCode: 'USD',
      source: 'symbol',
    });
    expect(resolveCurrency({ ...base, textSymbol: '¥', userCurrencyCodes: ['JPY', 'GEL'] })).toEqual({
      ok: true,
      currencyCode: 'JPY',
      source: 'symbol',
    });
  });

  it('falls back to the account currency for a shared symbol with two held candidates', () => {
    expect(
      resolveCurrency({
        ...base,
        textSymbol: '$',
        userCurrencyCodes: ['USD', 'CAD', 'GEL'],
        accountCurrencyCode: 'CAD',
      }),
    ).toEqual({ ok: true, currencyCode: 'CAD', source: 'account' });
  });

  it('falls back to the account currency for a shared symbol with no held candidate', () => {
    expect(resolveCurrency({ ...base, textSymbol: '$', userCurrencyCodes: ['GEL', 'EUR'] })).toEqual({
      ok: true,
      currencyCode: 'GEL',
      source: 'account',
    });
  });

  it('is case-insensitive about a symbol with letters', () => {
    expect(resolveCurrency({ ...base, textSymbol: 'ZŁ' })).toEqual({ ok: true, currencyCode: 'PLN', source: 'symbol' });
  });

  it('uses the account currency when the text names none', () => {
    expect(resolveCurrency({ ...base, accountCurrencyCode: 'EUR' })).toEqual({
      ok: true,
      currencyCode: 'EUR',
      source: 'account',
    });
  });

  it('uses the account currency for a symbol it does not know', () => {
    expect(resolveCurrency({ ...base, textSymbol: 'constructor' })).toEqual({
      ok: true,
      currencyCode: 'GEL',
      source: 'account',
    });
  });
});

describe('resolveStatedCurrency', () => {
  const stated = { explicitCurrency: null, textCode: null, textSymbol: null, userCurrencyCodes: ['GEL', 'USD'] };

  it('reads what the payment states without an account', () => {
    expect(resolveStatedCurrency({ ...stated, explicitCurrency: 'eur' })).toEqual({
      ok: true,
      currencyCode: 'EUR',
      source: 'explicit',
    });
    expect(resolveStatedCurrency({ ...stated, textCode: 'usd' })).toEqual({
      ok: true,
      currencyCode: 'USD',
      source: 'text-code',
    });
    expect(resolveStatedCurrency({ ...stated, textSymbol: '₾' })).toEqual({
      ok: true,
      currencyCode: 'GEL',
      source: 'symbol',
    });
  });

  it('states nothing when only the account can settle it', () => {
    expect(resolveStatedCurrency(stated)).toEqual({ ok: true, currencyCode: null, source: 'account' });
    // `$` stands for several currencies and the user holds two of them.
    expect(resolveStatedCurrency({ ...stated, textSymbol: '$', userCurrencyCodes: ['USD', 'CAD'] })).toEqual({
      ok: true,
      currencyCode: null,
      source: 'account',
    });
  });

  it('keeps the errors of resolveCurrency', () => {
    expect(resolveStatedCurrency({ ...stated, explicitCurrency: 'dollars!' })).toEqual({
      ok: false,
      reason: 'invalidCurrency',
    });
    expect(resolveStatedCurrency({ ...stated, textCode: 'USD', textSymbol: '€' })).toEqual({
      ok: false,
      reason: 'currencyConflict',
    });
  });
});
