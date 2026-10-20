import type { Money } from '@common/types/money';

import type { BalanceScopeHint, ParsedBalanceAfter } from './classify-notification';

/**
 * The balance of another account at the same bank: the account's connection, group or source.
 *
 * @public read by the processing job, which loads the siblings.
 */
export interface SiblingBalance {
  currencyCode: string;
  balance: Money;
}

/**
 * `parsed.balanceAfter`: the balance a notification stated. Only an `authoritative` one may ever be
 * read as the account's real balance; the rest is information for the owner.
 *
 * @public stored by the processing job.
 */
export interface StoredBalanceAfter {
  amount: string;
  currency: string;
  authoritative: boolean;
  scopeHint: BalanceScopeHint;
}

/**
 * The currencies the same bank holds money in: those with a non-zero balance. The parser prompt names them, because a bank that holds several currencies often states
 * a total in a notification instead of the balance of the account that paid.
 */
export const listNonZeroCurrencies = ({ siblings }: { siblings: readonly SiblingBalance[] }): string[] => [
  ...new Set(siblings.filter((sibling) => !sibling.balance.isZero()).map((sibling) => sibling.currencyCode)),
];

/**
 * Whether a stated balance is the balance of the account the payment was logged on. All of these must
 * hold:
 *
 * - the text does not say it is a total (`scopeHint` is not `total`);
 * - it is in the account's own currency (a balance in another currency cannot be the account's);
 * - every other-currency account at the same bank is zero, so a total across currencies could not
 *   differ from it.
 *
 * With a single-currency bank, or several currencies where only this one holds money, the balance is
 * authoritative. Nothing reads an authoritative balance yet; the flag is stored for it.
 */
export const resolveBalanceAuthority = ({
  balance,
  accountCurrencyCode,
  siblings,
}: {
  balance: ParsedBalanceAfter;
  accountCurrencyCode: string;
  siblings: readonly SiblingBalance[];
}): StoredBalanceAfter => {
  const otherCurrencyHoldsMoney = siblings.some(
    (sibling) => sibling.currencyCode !== accountCurrencyCode && !sibling.balance.isZero(),
  );
  const authoritative =
    balance.scopeHint !== 'total' && balance.currencyCode === accountCurrencyCode && !otherCurrencyHoldsMoney;

  return {
    amount: balance.amount,
    currency: balance.currencyCode,
    authoritative,
    scopeHint: balance.scopeHint,
  };
};
