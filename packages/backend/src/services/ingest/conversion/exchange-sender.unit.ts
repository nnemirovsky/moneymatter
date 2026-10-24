import { isBusinessSenderId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

describe('isBusinessSenderId', () => {
  it.each(['XCHANGE', 'EXCHBANK', 'AB12', 'ПРИКЛАД', 'EXAMPLE1'])('takes %p as a business sender ID', (sender) => {
    expect(isBusinessSenderId({ sender })).toBe(true);
  });

  it.each([
    '+15550100200',
    '15550100200',
    '555 0100',
    '0551234567',
    'Mom',
    'Alex2',
    'Shop24',
    '王小明',
    'محمد',
    'John',
    'John Smith',
    'Example Bank',
    'AB',
    'TOOLONGSENDERID',
    '12345',
    '',
    null,
    undefined,
  ])('does not take %p for one', (sender) => {
    expect(isBusinessSenderId({ sender })).toBe(false);
  });
});
