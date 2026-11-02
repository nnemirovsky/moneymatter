import { describe, expect, it } from '@jest/globals';

import { containsWord } from './contains-word';

describe('containsWord', () => {
  it.each([
    ['SOCAR gas 12', 'gas'],
    ['GAS', 'gas'],
    ['APPLE.COM/BILL', 'apple'],
    ['Payment: netflix, monthly', 'NETFLIX'],
    ['apple music family', 'apple music'],
    ['Оплата за газ', 'газ'],
    ['AT&T wireless', 'at&t'],
  ])('finds the word in %j for %j', (text, word) => {
    expect(containsWord({ text, word })).toBe(true);
  });

  it.each([
    ['Gastroenterologist', 'gas'],
    ['DONA bake shop', 'McDONAld'],
    ["McDonald's", 'dona'],
    ['Биогаз', 'газ'],
    ['gas2go', 'gas'],
    ['anything', ''],
    ['anything', '   '],
  ])('finds no word in %j for %j', (text, word) => {
    expect(containsWord({ text, word })).toBe(false);
  });

  it('reads the regular expression characters of a word literally', () => {
    expect(containsWord({ text: 'plan a.b', word: 'a.b' })).toBe(true);
    expect(containsWord({ text: 'plan axb', word: 'a.b' })).toBe(false);
  });
});
