import type { RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';

import { guessOwnTransferAccounts } from './guess-own-transfer-accounts';
import type { HistoryUse } from './history-account';

const A = 'account-a' as RecordId;
const B = 'account-b' as RecordId;
const C = 'account-c' as RecordId;
const E = 'account-eur' as RecordId;

const use = ({ accountId, currencyCode = 'USD' }: { accountId: RecordId; currencyCode?: string }): HistoryUse => ({
  accountId,
  accountCurrencyCode: currencyCode,
  paymentCurrencyCode: currencyCode,
  cardLastDigits: null,
});

const balances = new Map<RecordId, Money>([
  [A, Money.fromDecimal('1000')],
  [B, Money.fromDecimal('800')],
  [C, Money.fromDecimal('600')],
  [E, Money.fromDecimal('5000')],
]);

/** A newest first, then B: the order `loadHistoryUses` gives. */
const twoUses = [use({ accountId: A }), use({ accountId: B }), use({ accountId: A })];

const guess = (overrides: Partial<Parameters<typeof guessOwnTransferAccounts>[0]> = {}) =>
  guessOwnTransferAccounts({
    uses: twoUses,
    balances,
    usableAccountIds: new Set([A, B, C, E]),
    currencyCode: 'USD',
    amount: Money.fromDecimal('699.89'),
    kind: 'debit',
    ...overrides,
  });

describe('guessOwnTransferAccounts', () => {
  it('sends a debit notice from the most recently used of two accounts that both cover it', () => {
    expect(guess()).toEqual({ fromAccountId: A, toAccountId: B });
  });

  it('lands a credit notice on the most recently used of two accounts that both cover it', () => {
    expect(guess({ kind: 'credit' })).toEqual({ fromAccountId: B, toAccountId: A });
  });

  it('keeps the recency order when neither account covers the amount', () => {
    const amount = Money.fromDecimal('2000');

    expect(guess({ amount })).toEqual({ fromAccountId: A, toAccountId: B });
    expect(guess({ amount, kind: 'credit' })).toEqual({ fromAccountId: B, toAccountId: A });
  });

  it('sends from the only account whose balance covers the amount, whatever the direction and recency', () => {
    const amount = Money.fromDecimal('900');

    expect(guess({ amount })).toEqual({ fromAccountId: A, toAccountId: B });
    expect(guess({ amount, kind: 'credit' })).toEqual({ fromAccountId: A, toAccountId: B });
    expect(guess({ amount, uses: [use({ accountId: B }), use({ accountId: A })] })).toEqual({
      fromAccountId: A,
      toAccountId: B,
    });
  });

  it('treats an account with no known balance as one that cannot send', () => {
    const partial = new Map<RecordId, Money>([[B, Money.fromDecimal('800')]]);

    expect(guess({ balances: partial })).toEqual({ fromAccountId: B, toAccountId: A });
  });

  it('makes no guess with one account in the currency', () => {
    expect(guess({ uses: [use({ accountId: A }), use({ accountId: A })] })).toBeNull();
  });

  it('makes no guess without history', () => {
    expect(guess({ uses: [] })).toBeNull();
  });

  it('makes no guess with three accounts in the currency', () => {
    expect(guess({ uses: [...twoUses, use({ accountId: C })] })).toBeNull();
  });

  it('makes no guess without a currency', () => {
    expect(guess({ currencyCode: null })).toBeNull();
  });

  it('ignores accounts in other currencies', () => {
    expect(guess({ uses: [use({ accountId: E, currencyCode: 'EUR' }), ...twoUses] })).toEqual({
      fromAccountId: A,
      toAccountId: B,
    });
  });

  it('ignores accounts that take no manual payment (archived, loan, vehicle)', () => {
    const uses = [use({ accountId: C }), ...twoUses];

    expect(guess({ uses })).toBeNull();
    expect(guess({ uses, usableAccountIds: new Set([A, B]) })).toEqual({ fromAccountId: A, toAccountId: B });
    expect(guess({ usableAccountIds: new Set([A]) })).toBeNull();
  });
});
