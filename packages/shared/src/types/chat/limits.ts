/**
 * Chat limits shared by the backend (enforcement) and the frontend (composer counters, hints).
 * Rate budgets (`CHAT_MESSAGE_LIMIT`, `CHAT_ATTACHMENT_LIMIT`, `CHAT_APPROVAL_LIMIT`) live next to the
 * rate limiter that enforces them; everything here is a size or count bound.
 */

/** Model steps per message. */
export const CHAT_MAX_STEPS = 25;
/** Tool calls per message, on every runner. */
export const CHAT_MAX_TOOL_CALLS = 60;
/** Proposed cards per message. */
export const CHAT_MAX_PROPOSALS = 100;
/** Third-party read calls per message. */
export const CHAT_MAX_THIRD_PARTY_READS = 10;
/** Sandbox analyses per message. */
export const CHAT_MAX_ANALYSES = 5;
/** Characters of one read result sent to the model; the full result stays available for the run. */
export const CHAT_READ_RESULT_MAX_CHARS = 40_000;
/** Wall time of one run. */
export const CHAT_RUN_MAX_MS = 10 * 60 * 1000;
/** Characters of one user message. */
export const CHAT_MESSAGE_MAX_CHARS = 8_000;
/** Characters of a thread title. */
export const CHAT_THREAD_TITLE_MAX_CHARS = 120;

/** Attachments per message. */
export const CHAT_ATTACHMENTS_PER_MESSAGE = 5;
/** Bytes of one attachment. */
export const CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Bytes of all attachments of one message. */
export const CHAT_ATTACHMENTS_MAX_BYTES_PER_MESSAGE = 25 * 1024 * 1024;
/** Extracted text kept per attachment. */
export const CHAT_ATTACHMENT_TEXT_MAX_CHARS = 200_000;
/** Extracted text sent per message. */
export const CHAT_ATTACHMENT_TEXT_MAX_CHARS_PER_MESSAGE = 300_000;

/** Concurrent runs: one per thread (409), three per user (429). */
export const CHAT_MAX_RUNS_PER_THREAD = 1;
export const CHAT_MAX_RUNS_PER_USER = 3;

/** An unapproved card expires this long after it was proposed, pinned threads included. */
export const CHAT_PROPOSAL_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Sandbox bounds for `run_analysis` (Phase 3). */
export const CHAT_SANDBOX_LIMITS = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  cpuMs: 2_000,
  wallMs: 5_000,
  inputBytes: 8 * 1024 * 1024,
  outputBytes: 256 * 1024,
} as const;

/** Bounds of the display tools (`render_chart`, `render_table`, `render_kpis`). */
export const CHAT_VISUAL_LIMITS = {
  /** Title of a chart or table. */
  titleMaxChars: 120,
  /** Points on a chart's x axis. */
  maxPoints: 400,
  /** Series on a line, area or bar chart. */
  maxSeries: 12,
  /** Series name, slice label, category label. */
  seriesNameMaxChars: 60,
  /** Slices of a donut; the frontend folds the rest into "Others". */
  maxSlices: 12,
  /** Columns of a table. */
  maxColumns: 8,
  /** Table column label. */
  columnLabelMaxChars: 60,
  /** Table rows. */
  maxRows: 200,
  /** Characters of a text cell. */
  textCellMaxChars: 500,
  /** KPI tiles. */
  maxKpis: 6,
  /** KPI label. */
  kpiLabelMaxChars: 40,
  /** Serialized size of one visual. */
  maxBytes: 64 * 1024,
  /** Visuals per message. */
  maxPerMessage: 8,
} as const;

/** Bounds of a clarification card, whose question and option labels are the only model text on a card. */
export const CHAT_CLARIFICATION_LIMITS = {
  questionMaxChars: 300,
  maxOptions: 8,
  optionLabelMaxChars: 80,
  freeTextMaxChars: 500,
} as const;
