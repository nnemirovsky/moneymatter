/**
 * The ingest tokens whose requests are traced: `INGEST_DEBUG_TOKEN_IDS`, a comma-separated list of
 * `IngestTokens` ids. Empty or unset is off. Read from the environment on every request (so a test can set it); an operator change needs the
 * process restarted. The parse is cheap and skipped when the variable is empty.
 */
export const getDebugTokenIds = (): ReadonlySet<string> => {
  const raw = process.env.INGEST_DEBUG_TOKEN_IDS;
  if (!raw) return new Set();

  return new Set(
    raw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
};

/** How long a trace row is kept. */
export const INGEST_DEBUG_RETENTION_DAYS = 7;
