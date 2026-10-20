import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';

import { dedupConfig } from './constants';
import { pickJudgeCandidates, type JudgePoolRow } from './find-judge-candidates';

const T0 = new Date('2026-10-20T14:38:00.000Z');
const at = ({ seconds }: { seconds: number }) => new Date(T0.getTime() + seconds * 1000);
const figures = ({ amount, original }: { amount: number; original?: [number, string] }) => [
  { amount: Money.fromDecimal(amount), currencyCode: 'GEL' },
  ...(original ? [{ amount: Money.fromDecimal(original[0]), currencyCode: original[1] }] : []),
];

const subject = { id: 'new' as never, time: T0, figures: figures({ amount: 29.41 }), slots: ['tap'] };
const row = (id: string, overrides: Partial<JudgePoolRow> = {}): JudgePoolRow => ({
  id: id as never,
  time: at({ seconds: -120 }),
  figures: figures({ amount: 29.41 }),
  slots: ['wallet-notification'],
  ...overrides,
});
const pick = ({ pool, excludeIds }: { pool: JudgePoolRow[]; excludeIds?: Set<string> }) =>
  pickJudgeCandidates({ subject, pool, excludeIds });

describe('pickJudgeCandidates', () => {
  it('takes a row of the same amount inside the window', () => {
    expect(pick({ pool: [row('a')] })).toEqual(['a']);
  });

  it('never takes the row itself or one already ruled on', () => {
    expect(pick({ pool: [row('new'), row('a'), row('b')], excludeIds: new Set(['b']) })).toEqual(['a']);
  });

  it('takes a near amount (a tip) but not a far one', () => {
    expect(pick({ pool: [row('tip', { figures: figures({ amount: 33 }) })] })).toEqual(['tip']);
    expect(pick({ pool: [row('far', { figures: figures({ amount: 60 }) })] })).toEqual([]);
  });

  it('takes a row that states the same charged amount whatever its own amount says', () => {
    const converted = pickJudgeCandidates({
      subject: { ...subject, figures: figures({ amount: 29.41, original: [10, 'USD'] }) },
      pool: [row('fx', { figures: figures({ amount: 80, original: [10, 'USD'] }) })],
    });

    expect(converted).toEqual(['fx']);
  });

  it('stops at the judge window, either way', () => {
    const edge = dedupConfig.judgeWindowMs / 1000;

    expect(
      pick({ pool: [row('before', { time: at({ seconds: -edge }) }), row('after', { time: at({ seconds: edge }) })] }),
    ).toEqual(['before', 'after']);
    expect(
      pick({
        pool: [row('before', { time: at({ seconds: -edge - 1 }) }), row('after', { time: at({ seconds: edge + 1 }) })],
      }),
    ).toEqual([]);
  });

  describe('taken slots', () => {
    it('leaves out a row that holds the same slot: two coffees through one channel are two payments', () => {
      expect(pick({ pool: [row('tap-row', { slots: ['tap'] })] })).toEqual([]);
    });

    it('keeps such a row when it is seconds away: one run that fired twice', () => {
      const seconds = dedupConfig.judgeSameSlotWindowMs / 1000;

      expect(pick({ pool: [row('twice', { slots: ['tap'], time: at({ seconds: -(seconds - 5) }) })] })).toEqual([
        'twice',
      ]);
      expect(pick({ pool: [row('late', { slots: ['tap'], time: at({ seconds: -(seconds + 5) }) })] })).toEqual([]);
    });

    it('keeps a row that came by another channel, or by hand', () => {
      expect(pick({ pool: [row('wallet', { slots: ['wallet-notification'] }), row('hand', { slots: [] })] })).toEqual([
        'wallet',
        'hand',
      ]);
    });

    it('compares the whole slot, so another bank is another channel', () => {
      const incoming = { ...subject, slots: ['bank:name:tbc:payment'] };

      expect(
        pickJudgeCandidates({
          subject: incoming,
          pool: [row('same', { slots: ['bank:name:tbc:payment'] }), row('other', { slots: ['bank:name:bog:payment'] })],
        }),
      ).toEqual(['other']);
    });
  });

  it('puts exact amounts first, then the closest in time, and caps the list', () => {
    const pool = [
      row('near-close', { figures: figures({ amount: 31 }), time: at({ seconds: -10 }) }),
      row('exact-far', { time: at({ seconds: -3600 }) }),
      row('exact-close', { time: at({ seconds: -60 }) }),
    ];

    expect(pick({ pool })).toEqual(['exact-close', 'exact-far', 'near-close']);

    const many = Array.from({ length: 9 }, (_, index) =>
      row(`r${index}`, { time: at({ seconds: -(index + 1) * 60 }) }),
    );
    expect(pick({ pool: many })).toHaveLength(dedupConfig.judgeMaxCandidates);
  });
});
