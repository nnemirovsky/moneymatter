import type { Money } from '@common/types/money';

import { dedupConfig } from './constants';

/**
 * How far the incoming leg of a conversion is from what the day's rate gives for the outgoing leg, as a
 * share of the expected amount. The two legs were booked at the bank's own rate (which includes its
 * margin), so a plausible conversion is close to the day's rate but rarely on it.
 */
export const conversionDeviation = ({
  expectedIncoming,
  actualIncoming,
}: {
  expectedIncoming: Money;
  actualIncoming: Money;
}): number => {
  if (!expectedIncoming.isPositive()) return Number.POSITIVE_INFINITY;

  return actualIncoming.subtract(expectedIncoming).abs().divide(expectedIncoming.toNumber()).toNumber();
};

/** Whether the legs are at most `dedupConfig.conversionRateTolerance` apart at the day's rate. */
export const isPlausibleConversion = ({ deviation }: { deviation: number }): boolean =>
  deviation <= Number(dedupConfig.conversionRateTolerance);
