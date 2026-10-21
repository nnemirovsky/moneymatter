import { getCurrencyDecimals } from '@common/lib/currency-precision';

import { formatSummary, type SummaryAmount } from '../card-payment/format-summary';

/**
 * The line a payment that needs the owner's OK shows. It names the amount only when a currency is
 * known, and the merchant when one was read; otherwise it names the app or sender.
 */
export const buildNeedsOkSummary = async ({
  userId,
  amount,
  currencyCode,
  merchant,
  source,
  locale,
}: {
  userId: number;
  /** The amount as the notification printed it; ignored without a currency. */
  amount: string | null;
  currencyCode: string | null;
  merchant: string | null;
  source: string;
  locale: string;
}): Promise<string> => {
  let payment: SummaryAmount | null = null;
  if (amount !== null && currencyCode) {
    let decimals = 2;
    try {
      decimals = await getCurrencyDecimals({ userId, code: currencyCode });
    } catch {
      // A code the user cannot price keeps the common two decimals in the line that names it.
    }
    payment = { amount: Number(amount), currencyCode, decimals };
  }

  return formatSummary({
    summary: { type: 'notificationParked', reason: 'needsOk', payment, merchant, source },
    locale,
  });
};
