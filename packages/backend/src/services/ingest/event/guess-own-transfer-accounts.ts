import type { RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';

import { loadHistoryUses, type HistoryUse } from './history-account';

/** The two sides an own-account transfer is guessed to have moved money between. */
export interface OwnTransferGuess {
  fromAccountId: RecordId;
  toAccountId: RecordId;
}

/**
 * The accounts a notice of a transfer between the owner's own accounts most likely moved money between, from the
 * accounts the same source has landed payments on. Only a guess for the inbox card: the owner swaps the sides or picks
 * others there.
 *
 * 1. The candidates are the accounts in the notice's currency the source used, newest use first, that take manual
 *    payments (`usableAccountIds`). Anything but exactly two is no guess.
 * 2. An account whose current balance is below the amount cannot have sent it: when exactly one of the two covers the
 *    amount, it is the sender.
 * 3. Otherwise the most recently used account is the notice's own side: the sender of a `debit`, the receiver of a
 *    `credit`.
 */
export const guessOwnTransferAccounts = ({
  uses,
  balances,
  usableAccountIds,
  currencyCode,
  amount,
  kind,
}: {
  /** The source's history, newest first (see `loadHistoryUses`). */
  uses: readonly HistoryUse[];
  /** The current balance of each used account. */
  balances: ReadonlyMap<RecordId, Money>;
  /** The used accounts that take manual payments: not archived, not a loan or a vehicle. */
  usableAccountIds: ReadonlySet<RecordId>;
  currencyCode: string | null;
  amount: Money;
  kind: 'debit' | 'credit';
}): OwnTransferGuess | null => {
  if (!currencyCode) return null;

  const candidates = [
    ...new Set(
      uses
        .filter((use) => use.accountCurrencyCode === currencyCode && usableAccountIds.has(use.accountId))
        .map((use) => use.accountId),
    ),
  ];
  const [recent, older] = candidates;
  if (candidates.length !== 2 || !recent || !older) return null;

  const covering = candidates.filter((accountId) => balances.get(accountId)?.gte(amount) ?? false);
  if (covering.length === 1) {
    const [sender] = covering;

    return sender === recent
      ? { fromAccountId: recent, toAccountId: older }
      : { fromAccountId: older, toAccountId: recent };
  }

  return kind === 'debit'
    ? { fromAccountId: recent, toAccountId: older }
    : { fromAccountId: older, toAccountId: recent };
};

/** The guess for an own-account transfer notice of `sourceId`, read from the source's logged payments. */
export const findOwnTransferGuess = async ({
  userId,
  sourceId,
  currencyCode,
  amount,
  kind,
}: {
  userId: number;
  sourceId: RecordId | null;
  currencyCode: string | null;
  amount: string;
  kind: 'debit' | 'credit';
}): Promise<OwnTransferGuess | null> => {
  if (!sourceId || !currencyCode) return null;

  const { uses, balances, usableAccountIds } = await loadHistoryUses({ userId, sourceId });

  return guessOwnTransferAccounts({
    uses,
    balances,
    usableAccountIds,
    currencyCode,
    amount: Money.fromDecimal(amount),
    kind,
  });
};
