import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';

import { conversionDeviation, isPlausibleConversion } from './conversion-pair-rule';

describe('conversionDeviation', () => {
  it('is the share by which the incoming leg differs from the day-rate amount', () => {
    const deviation = conversionDeviation({
      expectedIncoming: Money.fromDecimal(810),
      actualIncoming: Money.fromDecimal(778.5),
    });

    expect(deviation).toBeCloseTo(0.0389, 3);
  });

  it('is zero on the day rate and symmetric above and below it', () => {
    const expectedIncoming = Money.fromDecimal(800);

    expect(conversionDeviation({ expectedIncoming, actualIncoming: Money.fromDecimal(800) })).toBe(0);
    expect(conversionDeviation({ expectedIncoming, actualIncoming: Money.fromDecimal(784) })).toBeCloseTo(0.02, 5);
    expect(conversionDeviation({ expectedIncoming, actualIncoming: Money.fromDecimal(816) })).toBeCloseTo(0.02, 5);
  });

  it('is never plausible when nothing was expected', () => {
    expect(conversionDeviation({ expectedIncoming: Money.zero(), actualIncoming: Money.fromDecimal(1) })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe('isPlausibleConversion', () => {
  it('allows three percent, inclusive', () => {
    expect(isPlausibleConversion({ deviation: 0.03 })).toBe(true);
    expect(isPlausibleConversion({ deviation: 0.0301 })).toBe(false);
  });
});
