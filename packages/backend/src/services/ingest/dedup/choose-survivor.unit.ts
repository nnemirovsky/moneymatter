import type { RecordId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import { chooseSurvivor } from './choose-survivor';

const ingest = { cardPayment: { merchant: 'Wolt' }, ingest: { unconfirmed: true } };

const row = ({
  id,
  minutes = 0,
  isPlanned = false,
  externalData = {},
}: {
  id: string;
  minutes?: number;
  isPlanned?: boolean;
  externalData?: unknown;
}) => ({
  id: id as RecordId,
  time: new Date(Date.UTC(2026, 9, 20, 12, minutes)),
  isPlanned,
  externalData,
});

describe('chooseSurvivor', () => {
  it('keeps a booked bank row over the ingest rows, whatever their time', () => {
    const candidates = [
      row({ id: 'tap', minutes: 0, externalData: ingest }),
      row({ id: 'bank', minutes: 5 }),
      row({ id: 'push', minutes: 2, externalData: ingest }),
    ];

    expect(chooseSurvivor({ candidates })).toBe('bank');
  });

  it('keeps the earliest ingest row when no bank row is there', () => {
    const candidates = [
      row({ id: 'push', minutes: 2, externalData: ingest }),
      row({ id: 'tap', minutes: 0, externalData: ingest }),
    ];

    expect(chooseSurvivor({ candidates })).toBe('tap');
  });

  it('prefers a booked ingest row over an ingest plan, even a later one', () => {
    const candidates = [
      row({ id: 'plan', minutes: 0, isPlanned: true, externalData: ingest }),
      row({ id: 'booked', minutes: 9, externalData: ingest }),
    ];

    expect(chooseSurvivor({ candidates })).toBe('booked');
  });

  it('never keeps an ingest plan over a booked bank row', () => {
    const candidates = [
      row({ id: 'plan', minutes: 0, isPlanned: true, externalData: ingest }),
      row({ id: 'bank', minutes: 30 }),
    ];

    expect(chooseSurvivor({ candidates })).toBe('bank');
  });

  it('keeps the earliest of two ingest plans', () => {
    const candidates = [
      row({ id: 'b', minutes: 4, isPlanned: true, externalData: ingest }),
      row({ id: 'a', minutes: 1, isPlanned: true, externalData: ingest }),
    ];

    expect(chooseSurvivor({ candidates })).toBe('a');
  });

  it('breaks a tie on time by id, in any input order', () => {
    const a = row({ id: 'a', externalData: ingest });
    const b = row({ id: 'b', externalData: ingest });

    expect(chooseSurvivor({ candidates: [b, a] })).toBe('a');
    expect(chooseSurvivor({ candidates: [a, b] })).toBe('a');
  });

  it('throws on an empty set', () => {
    expect(() => chooseSurvivor({ candidates: [] })).toThrow();
  });
});
