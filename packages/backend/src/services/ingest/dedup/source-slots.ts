import { buildSourceKey, WALLET_BUNDLE_ID, type IngestPipeline, type RecordId } from '@bt/shared/types';

/**
 * A row holds at most one request per slot, so a second notification of the same kind is a second
 * payment and not a repeat of the first:
 *
 * - `tap`: the Wallet Transaction trigger (the card-payment pipeline);
 * - `wallet-notification`: Wallet's own notification;
 * - `bank:<sourceKey>:<stage>`: a notification of one bank source at one stage of the payment
 *   (`authorization`, `settlement` or `payment`).
 */
export type IngestSlot = string;

export const TAP_SLOT: IngestSlot = 'tap';
export const WALLET_NOTIFICATION_SLOT: IngestSlot = 'wallet-notification';

const WALLET_SOURCE_KEY = buildSourceKey({ bundleId: WALLET_BUNDLE_ID, appName: null });

/** The slot a notification of this source and stage fills. Wallet has one slot whatever its stage. */
export const slotOfNotification = ({
  sourceKey,
  stage,
}: {
  sourceKey: string | null;
  stage: string | null;
}): IngestSlot =>
  !sourceKey || sourceKey === WALLET_SOURCE_KEY ? WALLET_NOTIFICATION_SLOT : `bank:${sourceKey}:${stage ?? 'payment'}`;

/** The bank slot of a source at a stage; the settlement rule looks for the authorization one. */
export const bankSlot = ({ sourceKey, stage }: { sourceKey: string; stage: string }): IngestSlot =>
  `bank:${sourceKey}:${stage}`;

/**
 * One source a logged payment holds, as `externalData.ingest.sources[]` keeps it. `balanceAfter` is the
 * balance the source stated (informational unless flagged authoritative); `occurredAt` is the time the
 * bank's text states, when it states one.
 */
export interface IngestSourceEntry {
  requestId: RecordId;
  pipeline: IngestPipeline;
  sourceKey: string | null;
  slot?: IngestSlot;
  balanceAfter?: unknown;
  occurredAt?: string | null;
  cardLastDigits?: string | null;
}

interface RowExternalData {
  cardPayment?: unknown;
  ingest?: { sources?: IngestSourceEntry[] } | null;
}

/**
 * The slots a row's sources fill. A row without `ingest.sources` (a card payment logged before the
 * slots existed) holds the `tap` slot when it carries the `cardPayment` marker.
 */
export const readTakenSlots = ({ externalData }: { externalData: Record<string, unknown> | null }): IngestSlot[] => {
  const data = (externalData ?? {}) as RowExternalData;
  const sources = Array.isArray(data.ingest?.sources) ? data.ingest.sources : [];

  const slots = sources.map((source) => {
    if (source.slot) return source.slot;
    if (source.pipeline === 'cardPayment') return TAP_SLOT;

    return slotOfNotification({ sourceKey: source.sourceKey, stage: null });
  });

  if (!slots.length && data.cardPayment) slots.push(TAP_SLOT);

  return slots;
};

/** Whether the row holds no source in `slot`. */
export const isSlotFree = ({
  externalData,
  slot,
}: {
  externalData: Record<string, unknown> | null;
  slot: IngestSlot;
}): boolean => !readTakenSlots({ externalData }).includes(slot);
