import type { RecordId } from '@bt/shared/types';
import type { Money } from '@common/types/money';

/** An account of the same card that may have paid, with what the payment would have cost there. */
export interface ShortBalanceCandidate {
  accountId: RecordId;
  currencyCode: string;
  balance: Money;
  /** The payment's amount in this account's currency, at the payment day's rate. */
  estimatedAmount: Money;
  /** The card's default account. */
  isDefault: boolean;
}

/** Whether the account held less than the payment before it: the signal that the bank paid from elsewhere. */
export const isBalanceShort = ({ balanceBefore, amount }: { balanceBefore: Money; amount: Money }): boolean =>
  balanceBefore.lessThan(amount);

/**
 * The accounts that could have paid in the order they are tried: only those whose balance covers the
 * converted amount (a bank such as TBC takes the whole amount from one balance that covers it, never a
 * split), the card's default account first, then the fullest balance. Ties fall back to the currency
 * code so the order never depends on how the rows were read.
 */
export const rankByCoverage = ({
  candidates,
}: {
  candidates: readonly ShortBalanceCandidate[];
}): ShortBalanceCandidate[] =>
  candidates
    .filter((candidate) => candidate.balance.gte(candidate.estimatedAmount))
    .toSorted((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      if (!a.balance.equals(b.balance)) return a.balance.greaterThan(b.balance) ? -1 : 1;

      return a.currencyCode.localeCompare(b.currencyCode);
    });

/**
 * Applies the AI's ranking to the covering candidates. The model may only name accounts it was shown
 * (`knownIds`) and only the covering ones, in the order it prefers; anything it left out follows in the
 * deterministic order, so a partial or invented answer can neither drop a candidate nor add one.
 */
export const applyRanking = ({
  covering,
  ranking,
}: {
  covering: readonly ShortBalanceCandidate[];
  ranking: readonly RecordId[];
}): ShortBalanceCandidate[] => {
  const byId = new Map(covering.map((candidate) => [candidate.accountId, candidate]));
  const ordered = [...new Set(ranking)].flatMap((accountId) => byId.get(accountId) ?? []);
  const named = new Set(ordered.map((candidate) => candidate.accountId));

  return [...ordered, ...covering.filter((candidate) => !named.has(candidate.accountId))];
};
