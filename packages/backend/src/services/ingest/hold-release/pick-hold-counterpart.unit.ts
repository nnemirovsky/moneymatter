import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';

import { pickHoldCounterpart, type HoldCandidate, type HoldFacts } from './pick-hold-counterpart';

const AT = new Date('2026-10-21T08:42:36Z');
const secondsBefore = (seconds: number) => new Date(AT.getTime() - seconds * 1000);

const facts = (overrides: Partial<HoldFacts> = {}): HoldFacts => ({
  direction: 'credit',
  amount: Money.fromDecimal(1),
  currencyCode: 'GEL',
  time: AT,
  accountId: 'acc-1',
  sourceId: null,
  cardLastDigits: null,
  ...overrides,
});

const candidate = (id: string, overrides: Partial<HoldCandidate> = {}): HoldCandidate => ({
  ...facts({ direction: 'debit', time: secondsBefore(12) }),
  id,
  ...overrides,
});

describe('pickHoldCounterpart', () => {
  it('pairs the release with the hold 12 seconds before it', () => {
    expect(
      pickHoldCounterpart({
        incoming: facts(),
        candidates: [candidate('hold')],
      })?.id,
    ).toBe('hold');
  });

  it('pairs a hold with a release that came first', () => {
    const release = candidate('release', { direction: 'credit' });

    expect(
      pickHoldCounterpart({
        incoming: facts({ direction: 'debit' }),
        candidates: [release],
      })?.id,
    ).toBe('release');
  });

  it.each([
    ['the same direction', { direction: 'credit' as const }],
    ['another amount', { amount: Money.fromDecimal(1.5) }],
    ['another currency', { currencyCode: 'USD' }],
    ['another account', { accountId: 'acc-2' }],
    ['a time outside the window', { time: secondsBefore(11 * 60) }],
  ])('does not pair with %s', (_label, overrides) => {
    expect(
      pickHoldCounterpart({
        incoming: facts(),
        candidates: [candidate('hold', overrides)],
      }),
    ).toBeNull();
  });

  it('pairs at the edge of the window and not a second after it', () => {
    const windowMs = 10 * 60_000;

    expect(
      pickHoldCounterpart({
        incoming: facts(),
        candidates: [candidate('edge', { time: new Date(AT.getTime() - windowMs) })],
        windowMs,
      })?.id,
    ).toBe('edge');
    expect(
      pickHoldCounterpart({
        incoming: facts(),
        candidates: [candidate('late', { time: new Date(AT.getTime() - windowMs - 1000) })],
        windowMs,
      }),
    ).toBeNull();
  });

  it('picks the nearest in time among several', () => {
    const candidates = [
      candidate('far', { time: secondsBefore(300) }),
      candidate('near', { time: secondsBefore(20) }),
      candidate('mid', { time: secondsBefore(90) }),
    ];

    expect(pickHoldCounterpart({ incoming: facts(), candidates })?.id).toBe('near');
  });

  describe('a payment with no account yet', () => {
    const parked = (overrides: Partial<HoldFacts> = {}) =>
      facts({
        accountId: null,
        sourceId: 'src-1',
        cardLastDigits: '0000',
        ...overrides,
      });

    it('pairs by source and card digits', () => {
      const other = candidate('hold', {
        accountId: null,
        sourceId: 'src-1',
        cardLastDigits: '0000',
      });

      expect(pickHoldCounterpart({ incoming: parked(), candidates: [other] })?.id).toBe('hold');
    });

    it('pairs by source and currency when neither names digits', () => {
      const other = candidate('hold', {
        accountId: null,
        sourceId: 'src-1',
        cardLastDigits: null,
      });

      expect(
        pickHoldCounterpart({
          incoming: parked({ cardLastDigits: null }),
          candidates: [other],
        })?.id,
      ).toBe('hold');
    });

    it.each([
      ['another source', { sourceId: 'src-2' }],
      ['other digits', { cardLastDigits: '1111' }],
      ['digits on one side only', { cardLastDigits: null }],
    ])('does not pair with %s', (_label, overrides) => {
      const other = candidate('hold', {
        accountId: null,
        sourceId: 'src-1',
        cardLastDigits: '0000',
        ...overrides,
      });

      expect(pickHoldCounterpart({ incoming: parked(), candidates: [other] })).toBeNull();
    });

    it('does not pair with a payment that has an account', () => {
      expect(
        pickHoldCounterpart({
          incoming: parked(),
          candidates: [candidate('hold')],
        }),
      ).toBeNull();
    });
  });
});
