import { describe, expect, it } from '@jest/globals';
import type Transactions from '@models/transactions.model';

import { nearestInTime, pickContextPayment } from './pick-context-payment';

const tx = ({ id, at }: { id: string; at: string }) => ({ id, time: new Date(at) }) as unknown as Transactions;

describe('pickContextPayment', () => {
  it('finds nothing without an open payment', () => {
    expect(pickContextPayment({ open: [], competingContexts: 0 })).toEqual({ kind: 'none' });
    expect(pickContextPayment({ open: [], competingContexts: 2 })).toEqual({ kind: 'none' });
  });

  it('is sure with one payment and no competing context', () => {
    const only = tx({ id: 'a', at: '2026-10-22T11:22:00Z' });

    expect(pickContextPayment({ open: [only], competingContexts: 0 })).toEqual({ kind: 'sure', transaction: only });
  });

  it('is a guess with several payments or a competing context', () => {
    const a = tx({ id: 'a', at: '2026-10-22T11:22:00Z' });
    const b = tx({ id: 'b', at: '2026-10-22T11:25:00Z' });

    expect(pickContextPayment({ open: [a, b], competingContexts: 0 })).toEqual({
      kind: 'ambiguous',
      candidates: [a, b],
    });
    expect(pickContextPayment({ open: [a], competingContexts: 1 })).toEqual({ kind: 'ambiguous', candidates: [a] });
  });
});

describe('nearestInTime', () => {
  it('takes the nearest payment, the earlier one on a tie', () => {
    const a = tx({ id: 'a', at: '2026-10-22T11:20:00Z' });
    const b = tx({ id: 'b', at: '2026-10-22T11:26:00Z' });

    expect(nearestInTime({ candidates: [a, b], time: new Date('2026-10-22T11:25:00Z') })).toBe(b);
    expect(nearestInTime({ candidates: [a, b], time: new Date('2026-10-22T11:23:00Z') })).toBe(a);
  });
});
