import type { RecordId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import { pickAccountByName } from './resolve-notification-account';

const accounts = (...names: string[]) => names.map((name, index) => ({ id: `account-${index}` as RecordId, name }));

describe('pickAccountByName', () => {
  it('picks the account named like the app', () => {
    const list = accounts('Kristina Gazprom CC', 'Raiffeisen', 'Bereke', 'Forte');

    expect(pickAccountByName({ accounts: list, appName: 'Raiffeisen' })).toBe(list[1]);
  });

  it('ignores case and diacritics', () => {
    const list = accounts('Raiffeisen', 'Bereke');

    expect(pickAccountByName({ accounts: list, appName: 'RAIFFÉISEN' })).toBe(list[0]);
    expect(pickAccountByName({ accounts: accounts('Škoda Fund'), appName: 'skoda' })).toMatchObject({
      name: 'Škoda Fund',
    });
  });

  it('lets the app name be a prefix of the account name, or the other way round', () => {
    expect(pickAccountByName({ accounts: accounts('Raiffeisen Savings'), appName: 'Raiffeisen' })).toMatchObject({
      name: 'Raiffeisen Savings',
    });
    expect(pickAccountByName({ accounts: accounts('Raiffeisen'), appName: 'Raiffeisen Bank' })).toMatchObject({
      name: 'Raiffeisen',
    });
  });

  it('picks nothing when two accounts match', () => {
    expect(
      pickAccountByName({ accounts: accounts('Raiffeisen', 'Raiffeisen Savings'), appName: 'Raiffeisen' }),
    ).toBeNull();
  });

  it('picks nothing when no account matches', () => {
    expect(pickAccountByName({ accounts: accounts('Bereke', 'Forte'), appName: 'Raiffeisen' })).toBeNull();
  });

  it('does not match on a short or empty name', () => {
    expect(pickAccountByName({ accounts: accounts('R', 'Raiffeisen'), appName: 'Ra' })).toBeNull();
    expect(pickAccountByName({ accounts: accounts('Raiffeisen'), appName: null })).toBeNull();
    expect(pickAccountByName({ accounts: accounts('AB'), appName: 'ABC Bank' })).toBeNull();
  });

  it('does not match a word inside the name', () => {
    expect(pickAccountByName({ accounts: accounts('My Raiffeisen'), appName: 'Raiffeisen' })).toBeNull();
  });
});
