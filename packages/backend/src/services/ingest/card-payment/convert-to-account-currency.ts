import { roundToCurrency } from '@common/lib/currency-precision';
import type { Money } from '@common/types/money';
import { ExchangeRateUnavailableError } from '@js/errors';
import { calculateRefAmount } from '@services/calculate-ref-amount.service';

type ConvertToAccountCurrencyResult = { amount: Money } | { parked: 'rateUnavailable' };

/**
 * A payment amount in the currency of the account it is logged on, converted at the rate of the
 * payment's day and rounded half-even to the account currency's decimals. A pair with no rate
 * (an ISO code no provider prices, a custom currency without a rate) is a returned `parked`
 * outcome, never a stored guess: the account amount is a required column.
 */
export const convertToAccountCurrency = async ({
  ownerUserId,
  amount,
  from,
  to,
  date,
}: {
  ownerUserId: number;
  amount: Money;
  from: string;
  to: string;
  date: Date;
}): Promise<ConvertToAccountCurrencyResult> => {
  if (from === to) return { amount };

  try {
    const converted = await calculateRefAmount({
      userId: ownerUserId,
      amountOwnerUserId: ownerUserId,
      amount,
      baseCode: from,
      quoteCode: to,
      date,
    });

    return {
      amount: await roundToCurrency({ money: converted, userId: ownerUserId, currencyCode: to, mode: 'half-even' }),
    };
  } catch (error) {
    if (error instanceof ExchangeRateUnavailableError) return { parked: 'rateUnavailable' };

    throw error;
  }
};
