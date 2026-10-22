/**
 * A stretch of the stored timeline spent in one zone. `windows` are half-open `[from, to)` ranges
 * of the instants as they are stored today (not the corrected ones); a `null` bound is open.
 */
export interface BackfillWindow {
  from: Date | null;
  to: Date | null;
}

export interface BackfillGroup {
  key: string;
  zone: string;
  windows: BackfillWindow[];
  /** Rows the selection must find in the group; a different count aborts the run. */
  expectedRows: number;
}

/** The import wrote its rows on this day; nothing logged later by the app or ingest is eligible. */
export const DEFAULT_IMPORT_CREATED_FROM = new Date('2026-10-17T00:00:00.000Z');
export const DEFAULT_IMPORT_CREATED_TO = new Date('2026-10-17T14:00:00.000Z');

/**
 * The sheet stored every wall clock as Istanbul time, so each imported instant is the local wall
 * clock read at this fixed offset.
 */
export const SHEET_ANCHOR_OFFSET_MINUTES = 180;

const at = (iso: string) => new Date(iso);

/**
 * The approved periods. Zones are where the owner was when the row was entered; the cuts sit in the
 * gaps between the last row at one place and the first at the next.
 */
export const DEFAULT_GROUPS: BackfillGroup[] = [
  {
    key: 'thailand',
    zone: 'Asia/Bangkok',
    windows: [{ from: null, to: at('2026-02-01T08:00:00.000Z') }],
    expectedRows: 401,
  },
  {
    key: 'vietnam',
    zone: 'Asia/Ho_Chi_Minh',
    windows: [{ from: at('2026-02-01T08:00:00.000Z'), to: at('2026-03-01T08:00:00.000Z') }],
    expectedRows: 178,
  },
  {
    key: 'bali',
    zone: 'Asia/Makassar',
    windows: [
      { from: at('2026-03-01T08:00:00.000Z'), to: at('2026-04-25T00:00:00.000Z') },
      { from: at('2026-04-26T18:00:00.000Z'), to: at('2026-06-24T19:30:00.000Z') },
      { from: at('2026-06-27T16:00:00.000Z'), to: at('2026-08-03T12:00:00.000Z') },
    ],
    expectedRows: 946,
  },
  {
    key: 'malaysia-april',
    zone: 'Asia/Kuala_Lumpur',
    windows: [{ from: at('2026-04-25T00:00:00.000Z'), to: at('2026-04-26T18:00:00.000Z') }],
    expectedRows: 16,
  },
  {
    key: 'malaysia-june',
    zone: 'Asia/Kuala_Lumpur',
    windows: [{ from: at('2026-06-24T19:30:00.000Z'), to: at('2026-06-27T16:00:00.000Z') }],
    expectedRows: 29,
  },
  {
    key: 'russia',
    zone: 'Europe/Moscow',
    windows: [{ from: at('2026-08-03T12:00:00.000Z'), to: at('2026-08-30T05:00:00.000Z') }],
    expectedRows: 146,
  },
  {
    key: 'turkey',
    zone: 'Europe/Istanbul',
    windows: [{ from: at('2026-08-30T05:00:00.000Z'), to: at('2026-09-12T11:00:00.000Z') }],
    expectedRows: 64,
  },
  {
    // 173 rows live in this stretch today; 19 of them were logged after the import and stay as they are.
    key: 'georgia',
    zone: 'Asia/Tbilisi',
    windows: [{ from: at('2026-09-12T11:00:00.000Z'), to: null }],
    expectedRows: 154,
  },
];
