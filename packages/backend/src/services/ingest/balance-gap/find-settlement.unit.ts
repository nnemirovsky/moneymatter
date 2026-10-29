import type { RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';

import { pickSettlement, type SettlementCandidate } from './find-settlement';

const AT = new Date('2026-03-10T12:00:00Z');
const DAY = 24 * 60 * 60_000;

const candidate = (overrides: Partial<SettlementCandidate> = {}): SettlementCandidate => ({
  id: 'tx-1' as RecordId,
  kind: 'debit',
  amount: Money.fromDecimal('50.00'),
  time: new Date(AT.getTime() - 4 * DAY),
  proposed: false,
  ...overrides,
});

const pick = ({ gap, candidates = [candidate()] }: { gap: string; candidates?: SettlementCandidate[] }) => {
  const result = pickSettlement({ gap: Money.fromDecimal(gap), candidates, at: AT });

  return result ? { id: result.candidate.id, amount: result.amount.toNumber() } : null;
};

describe('pickSettlement', () => {
  it('lowers a debit when the stated balance is higher than ours', () => {
    expect(pick({ gap: '0.80' })).toEqual({ id: 'tx-1', amount: 49.2 });
  });

  it('raises a debit when the stated balance is lower', () => {
    expect(pick({ gap: '-1.20' })).toEqual({ id: 'tx-1', amount: 51.2 });
  });

  it('moves a credit the other way', () => {
    expect(pick({ gap: '0.80', candidates: [candidate({ kind: 'credit' })] })).toEqual({ id: 'tx-1', amount: 50.8 });
  });

  it('leaves a gap larger than 5% of the payment to the missing-transaction card', () => {
    expect(pick({ gap: '2.60' })).toBeNull();
  });

  it('ignores a payment younger than a day or older than ten days', () => {
    expect(pick({ gap: '0.80', candidates: [candidate({ time: new Date(AT.getTime() - DAY / 2) })] })).toBeNull();
    expect(pick({ gap: '0.80', candidates: [candidate({ time: new Date(AT.getTime() - 11 * DAY) })] })).toBeNull();
  });

  it('is no answer when two payments fit', () => {
    const candidates = [candidate(), candidate({ id: 'tx-2' as RecordId, amount: Money.fromDecimal('40.00') })];

    expect(pick({ gap: '0.80', candidates })).toBeNull();
  });

  it('picks the one that fits when another is too small for the gap', () => {
    const candidates = [candidate(), candidate({ id: 'tx-2' as RecordId, amount: Money.fromDecimal('5.00') })];

    expect(pick({ gap: '0.80', candidates })).toEqual({ id: 'tx-1', amount: 49.2 });
  });

  it('never leaves a payment with no amount', () => {
    expect(pick({ gap: '2.00', candidates: [candidate({ amount: Money.fromDecimal('2.00') })] })).toBeNull();
  });

  it('returns a candidate already proposed, so the caller does not ask twice', () => {
    expect(
      pickSettlement({ gap: Money.fromDecimal('0.80'), candidates: [candidate({ proposed: true })], at: AT }),
    ).toMatchObject({
      candidate: { proposed: true },
    });
  });
});
