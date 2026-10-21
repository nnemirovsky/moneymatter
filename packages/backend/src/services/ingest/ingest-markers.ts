import type { IngestPipeline, IngestShortBalanceCorrection, RecordId } from '@bt/shared/types';

import type { IngestSourceEntry } from './dedup/source-slots';

/** The values of a payment a confirm card offers for editing; also what the card was built from. */
export interface ConfirmBaseline {
  accountId: string;
  amount: number;
  payeeId: string | null;
  categoryId: string;
  /** Absent on a card posted before the note was part of it: the row's note stands in. */
  note?: string;
}

/**
 * What the ingest pipeline keeps under `Transactions.externalData.ingest`. Every field is optional:
 * a row that was never ingested has none, and a row logged by an older build lacks the newer ones.
 */
export interface IngestMarkers {
  /** The request that produced the row. */
  requestId?: RecordId;
  pipeline?: IngestPipeline;
  /** The row waits for the owner's decision on its confirm card. */
  unconfirmed?: boolean;
  cardLastDigits?: string;
  /** The logged account's balance before the payment, in that account's currency. */
  balanceBefore?: { amount: number; currencyCode: string };
  confirmBaseline?: ConfirmBaseline;
  sources?: IngestSourceEntry[];
  correction?: IngestShortBalanceCorrection;
  systemNote?: string;
  systemCategoryId?: string;
  /** A payee the payment's merchant created when the payment was logged. */
  createdPayeeId?: RecordId;
}

/** The ingest markers of a row, empty for a row the ingest did not write. */
export const ingestMarkersOf = ({ externalData }: { externalData: Record<string, unknown> | null }): IngestMarkers =>
  ((externalData as { ingest?: IngestMarkers | null } | null)?.ingest ?? {}) as IngestMarkers;

/** Whether the row still waits for the owner's confirmation. */
export const isUnconfirmedIngest = ({ externalData }: { externalData: Record<string, unknown> | null }): boolean =>
  ingestMarkersOf({ externalData }).unconfirmed === true;
