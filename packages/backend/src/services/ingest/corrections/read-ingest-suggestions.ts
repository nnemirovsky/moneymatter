import type { IngestShortBalanceCorrection, IngestTransferSuggestion } from '@bt/shared/types';

interface IngestExternalData {
  ingest?: { correction?: IngestShortBalanceCorrection } | null;
  /** Top level, not under `ingest`: the other leg of a conversion may be a row the ingest never wrote. */
  ingestTransferSuggestion?: IngestTransferSuggestion;
}

/** The short-balance correction stored on a logged payment, whatever its status. */
export const correctionOf = ({
  externalData,
}: {
  externalData: Record<string, unknown> | null;
}): IngestShortBalanceCorrection | null => (externalData as IngestExternalData | null)?.ingest?.correction ?? null;

/** The currency-conversion transfer suggestion stored on a leg of the pair. */
export const transferSuggestionOf = ({
  externalData,
}: {
  externalData: Record<string, unknown> | null;
}): IngestTransferSuggestion | null => (externalData as IngestExternalData | null)?.ingestTransferSuggestion ?? null;
