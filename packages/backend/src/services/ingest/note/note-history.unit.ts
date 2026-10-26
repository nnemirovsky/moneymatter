import { describe, expect, it } from '@jest/globals';

import { localHour, offsetMinutesOf, suggestNoteFromHistory } from './note-history';

const LISBON = 4 * 60;

/** A UTC time for a local time in Lisbon (UTC+4) on a day of October 2026. */
const at = ({ day, local }: { day: number; local: string }) => {
  const [hours, minutes] = local.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, hours! - 4, minutes));
};

const row = ({
  note,
  day,
  local,
  amount = 12,
}: {
  note: string | null;
  day: number;
  local: string;
  amount?: number;
}) => ({
  note,
  amount,
  time: at({ day, local }),
});

const suggest = ({
  history,
  local = '08:30',
  excludedNames = ['Blue Coffee'],
}: {
  history: ReturnType<typeof row>[];
  local?: string;
  excludedNames?: string[];
}) => suggestNoteFromHistory({ history, time: at({ day: 21, local }), offsetMinutes: LISBON, excludedNames });

describe('suggestNoteFromHistory', () => {
  it('suggests the note that dominates the payee history', () => {
    expect(
      suggest({
        history: [
          row({ note: 'Breakfast', day: 20, local: '08:10' }),
          row({ note: 'breakfast ', day: 19, local: '09:00' }),
          row({ note: 'Breakfast', day: 17, local: '13:00' }),
          row({ note: null, day: 15, local: '18:00' }),
        ],
      }),
    ).toEqual({ kind: 'note', note: 'Breakfast' });
  });

  it('picks the note of the same part of the day when notes vary by time', () => {
    const history = [
      row({ note: 'Breakfast', day: 20, local: '08:10' }),
      row({ note: 'Lunch', day: 20, local: '13:20' }),
      row({ note: 'Breakfast', day: 19, local: '09:00' }),
      row({ note: 'Lunch', day: 18, local: '12:45' }),
      row({ note: 'Lunch', day: 17, local: '14:05' }),
    ];

    expect(suggest({ history, local: '08:40' })).toEqual({ kind: 'note', note: 'Breakfast' });
    expect(suggest({ history, local: '12:38' })).toEqual({ kind: 'note', note: 'Lunch' });
  });

  it('asks the AI with every past note, when and for how much, when none dominates', () => {
    const result = suggest({
      history: [
        row({ note: 'Breakfast', day: 20, local: '08:10', amount: 18 }),
        row({ note: 'Coffee to go', day: 19, local: '09:00', amount: 6 }),
        row({ note: 'Team treat', day: 18, local: '08:20', amount: 95 }),
      ],
    });

    expect(result).toEqual({
      kind: 'ask',
      candidates: expect.arrayContaining([
        { note: 'Breakfast', count: 1, occurrences: [{ time: at({ day: 20, local: '08:10' }), amount: 18 }] },
        { note: 'Coffee to go', count: 1, occurrences: [{ time: at({ day: 19, local: '09:00' }), amount: 6 }] },
        { note: 'Team treat', count: 1, occurrences: [{ time: at({ day: 18, local: '08:20' }), amount: 95 }] },
      ]),
    });
  });

  it('suggests nothing without history', () => {
    expect(suggest({ history: [] })).toEqual({ kind: 'none' });
  });

  it('suggests nothing when most past payments carry no note', () => {
    expect(
      suggest({
        history: [
          row({ note: 'Breakfast', day: 20, local: '08:10' }),
          row({ note: null, day: 19, local: '08:30' }),
          row({ note: null, day: 18, local: '09:30' }),
        ],
      }),
    ).toEqual({ kind: 'none' });
  });

  it('never suggests a note that only repeats the payee or the merchant', () => {
    expect(
      suggest({
        history: [
          row({ note: 'Blue Coffee', day: 19, local: '11:26' }),
          row({ note: 'Blue Coffee', day: 9, local: '13:43' }),
          row({ note: 'BLUE COFFEE', day: 8, local: '12:06' }),
          row({ note: 'Blue Cofee Company Ltd', day: 7, local: '12:38' }),
        ],
        local: '12:38',
        excludedNames: ['Blue Coffee', 'Blue', 'Blue Cofee Company Ltd'],
      }),
    ).toEqual({ kind: 'none' });
  });
});

describe('offsetMinutesOf', () => {
  it('reads the offset an ISO time states', () => {
    expect(offsetMinutesOf({ time: '2026-10-21T12:38:10+04:00' })).toBe(240);
    expect(offsetMinutesOf({ time: '2026-10-21T12:38:10-0530' })).toBe(-330);
    expect(offsetMinutesOf({ time: '2026-10-21T08:38:10Z' })).toBe(0);
    expect(offsetMinutesOf({ time: undefined })).toBe(0);
  });
});

describe('localHour', () => {
  it('places a UTC time in the local day', () => {
    expect(localHour({ time: new Date('2026-10-21T08:38:10Z'), offsetMinutes: LISBON })).toBe(12);
    expect(localHour({ time: new Date('2026-10-21T22:30:00Z'), offsetMinutes: LISBON })).toBe(2);
  });
});
