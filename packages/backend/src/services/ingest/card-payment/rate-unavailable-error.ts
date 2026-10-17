import { ExchangeRateUnavailableError } from '@js/errors';

/** The day a rate is asked for, as it appears in the parked summary (`yyyy-MM-dd`, UTC). */
export const formatRateDate = ({ date }: { date: Date }) => date.toISOString().slice(0, 10);

/**
 * An `ExchangeRateUnavailableError` that also names the pair and the day the payment needed, so
 * the request can be parked with "no EUR→GEL rate for 2026-10-17" even though the rate lookup
 * that failed sat deep inside `createTransaction`.
 */
export class CardPaymentRateUnavailableError extends ExchangeRateUnavailableError {
  fromCurrencyCode: string;

  toCurrencyCode: string;

  date: string;

  constructor({
    cause,
    fromCurrencyCode,
    toCurrencyCode,
    date,
  }: {
    cause: ExchangeRateUnavailableError;
    fromCurrencyCode: string;
    toCurrencyCode: string;
    date: Date;
  }) {
    super({ code: cause.code, message: cause.message });
    this.fromCurrencyCode = fromCurrencyCode;
    this.toCurrencyCode = toCurrencyCode;
    this.date = formatRateDate({ date });
  }
}
