import type { RecordId } from '@bt/shared/types';
import { getCurrencyDecimals } from '@common/lib/currency-precision';
import Categories from '@models/categories.model';
import { findOneTransaction } from '@models/transactions-query';
import { getUserDefaultCategory } from '@models/users.model';

import { formatSummary } from './format-summary';

interface LoggedSummary {
  summary: string;
  planned: boolean;
}

/**
 * The one-line answer for a payment that sits in a transaction. It reads the stored row, so the
 * first answer and every replay say the same thing about the same payment: the amount as the card
 * charged it (with the account amount when it was converted), the merchant the shortcut sent, and
 * the category, or "Uncategorized" while the row is still in the user's default category.
 *
 * Returns `null` when the transaction no longer exists.
 */
export const buildLoggedSummary = async ({
  userId,
  transactionId,
  duplicate,
  categoryPending,
  locale,
}: {
  userId: number;
  transactionId: RecordId;
  duplicate: boolean;
  categoryPending: boolean;
  locale: string;
}): Promise<LoggedSummary | null> => {
  const transaction = await findOneTransaction({
    where: { id: transactionId },
    planned: 'include',
    access: { creator: userId },
    balanceAdjustments: 'include',
  });
  if (!transaction) return null;

  const defaultCategoryId = await getUserDefaultCategory({ id: userId });
  const category =
    transaction.categoryId === defaultCategoryId
      ? null
      : await Categories.findOne({ where: { id: transaction.categoryId }, attributes: ['name'] });

  const account = {
    amount: transaction.amount.toNumber(),
    currencyCode: transaction.currencyCode,
    decimals: await getCurrencyDecimals({ userId, code: transaction.currencyCode }),
  };
  const original =
    transaction.originalAmount && transaction.originalCurrencyCode
      ? {
          amount: transaction.originalAmount.toNumber(),
          currencyCode: transaction.originalCurrencyCode,
          decimals: await getCurrencyDecimals({ userId, code: transaction.originalCurrencyCode }),
        }
      : null;

  const merchant = (transaction.externalData?.cardPayment as { merchant?: string } | undefined)?.merchant ?? '';

  const summary = formatSummary({
    summary: {
      type: 'logged',
      payment: original ?? account,
      accountAmount: original ? account : undefined,
      merchant,
      categoryName: category?.name ?? null,
      categoryPending,
      planned: transaction.isPlanned,
      duplicate,
    },
    locale,
  });

  return { summary, planned: transaction.isPlanned };
};
