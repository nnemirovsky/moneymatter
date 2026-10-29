import { normalizePayeeName } from '../../payees/normalize-name';

/** A past payment to the payee, as far as the note suggestion reads it. */
interface NoteHistoryRow {
  note: string | null;
  amount: number;
  time: Date;
}

/**
 * The note of a past payment as history, which is none for a note a context notification wrote ("<store> order from
 * <service>"): it names one order's venue, so it says nothing of the next payment to the same payee.
 */
export const historyNoteOf = ({
  note,
  externalData,
}: {
  note: string | null;
  externalData: Record<string, unknown> | null;
}): string | null => {
  const context = (externalData as { ingest?: { context?: { noteApplied?: boolean } } } | null)?.ingest?.context;

  return context?.noteApplied === true ? null : note;
};

/** A note the owner wrote before, with the payments it was on (newest first). */
export interface NoteCandidate {
  note: string;
  count: number;
  occurrences: { time: Date; amount: number }[];
}

export type NoteSuggestion =
  | { kind: 'note'; note: string }
  /** The history has notes but none settles it: the AI picks one of them, or none. */
  | { kind: 'ask'; candidates: NoteCandidate[] }
  | { kind: 'none' };

/** Parts of the day a note can depend on ("Breakfast" in the morning, "Lunch" at midday), by local hour. */
type DayPart = 'morning' | 'midday' | 'evening' | 'night';

const DOMINANT_SHARE = 0.6;
const MIN_DOMINANT_COUNT = 2;
/** Below this share of noted payments the owner usually writes no note there, so none is suggested. */
const NOTED_SHARE = 0.5;
const CANDIDATES_LIMIT = 8;
const OCCURRENCES_SHOWN = 5;

const MINUTE_MS = 60_000;

/** The local hour of a time, at the payment's UTC offset. */
export const localHour = ({ time, offsetMinutes }: { time: Date; offsetMinutes: number }): number =>
  new Date(time.getTime() + offsetMinutes * MINUTE_MS).getUTCHours();

const dayPartOf = ({ hour }: { hour: number }): DayPart => {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 16) return 'midday';
  if (hour >= 16 && hour < 22) return 'evening';
  return 'night';
};

const keyOf = ({ note }: { note: string }) => note.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The note the most rows carry, when it is on at least two of them and on 60% of all of them (rows
 * without a note count against it), and no other note is as frequent.
 */
const dominantNote = ({ rows, usable }: { rows: NoteHistoryRow[]; usable: (row: NoteHistoryRow) => string | null }) => {
  const counts = new Map<string, { note: string; count: number }>();
  for (const row of rows) {
    const note = usable(row);
    if (!note) continue;
    const key = keyOf({ note });
    const entry = counts.get(key);
    // Rows come newest first, so the first spelling seen is the latest one.
    counts.set(key, { note: entry?.note ?? note, count: (entry?.count ?? 0) + 1 });
  }

  const ranked = [...counts.values()].toSorted((a, b) => b.count - a.count);
  const [top, second] = ranked;
  if (!top || top.count < MIN_DOMINANT_COUNT || top.count / rows.length < DOMINANT_SHARE) return null;
  if (second && second.count === top.count) return null;

  return top.note;
};

/**
 * The note to suggest for a new payment to a payee, from the owner's past payments there (newest
 * first). It is only ever a note the owner wrote before, never the merchant's name:
 *
 * - notes that only repeat the payee's name, one of its spellings or the merchant (`excludedNames`) do
 *   not count, so a history of bank descriptions suggests nothing;
 * - with two or more past payments at the same part of the day (morning, midday, evening, night, at
 *   the payment's local time) those decide, so "Breakfast" in the morning and "Lunch" at midday each
 *   come back at their time; with fewer the whole history decides;
 * - a note on at least two of those payments and on 60% of them (payments without a note count
 *   against it) wins;
 * - when most of them carry notes but none wins, the AI picks (`ask`), with every note of the history
 *   as a candidate and when and for how much it was used;
 * - when most of them carry no note, or there is no history, nothing is suggested.
 */
export const suggestNoteFromHistory = ({
  history,
  time,
  offsetMinutes,
  excludedNames,
}: {
  history: readonly NoteHistoryRow[];
  /** When the new payment was made. */
  time: Date;
  /** The payment's local offset from UTC, which places every time in the owner's day. */
  offsetMinutes: number;
  excludedNames: readonly string[];
}): NoteSuggestion => {
  if (!history.length) return { kind: 'none' };

  const excluded = new Set(excludedNames.map((name) => normalizePayeeName({ raw: name })).filter(Boolean));
  const usable = (row: NoteHistoryRow): string | null => {
    const note = row.note?.trim();
    if (!note) return null;
    const normalized = normalizePayeeName({ raw: note });

    return normalized && !excluded.has(normalized) ? note : null;
  };

  const rows = [...history];
  const part = dayPartOf({ hour: localHour({ time, offsetMinutes }) });
  const sameTime = rows.filter((row) => dayPartOf({ hour: localHour({ time: row.time, offsetMinutes }) }) === part);

  // Enough payments at this part of the day decide on their own; otherwise the whole history does.
  const scope = sameTime.length >= MIN_DOMINANT_COUNT ? sameTime : rows;
  const dominant = dominantNote({ rows: scope, usable });
  if (dominant) return { kind: 'note', note: dominant };

  const notedInScope = scope.filter((row) => usable(row)).length;
  if (!notedInScope || notedInScope / scope.length < NOTED_SHARE) return { kind: 'none' };

  const byKey = new Map<string, NoteCandidate>();
  for (const row of rows.filter((candidate) => usable(candidate))) {
    const note = usable(row)!;
    const key = keyOf({ note });
    const candidate = byKey.get(key) ?? { note, count: 0, occurrences: [] };
    candidate.count += 1;
    if (candidate.occurrences.length < OCCURRENCES_SHOWN) {
      candidate.occurrences.push({ time: row.time, amount: row.amount });
    }
    byKey.set(key, candidate);
  }

  const candidates = [...byKey.values()].toSorted((a, b) => b.count - a.count).slice(0, CANDIDATES_LIMIT);

  return { kind: 'ask', candidates };
};

/** The UTC offset an ISO time states (`+04:00`, `Z`), in minutes; `0` when it states none. */
export const offsetMinutesOf = ({ time }: { time: unknown }): number => {
  if (typeof time !== 'string') return 0;

  const match = /([+-])(\d{2}):?(\d{2})$/.exec(time.trim());
  if (!match) return 0;

  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
};
