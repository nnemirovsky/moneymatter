import type { RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { Op } from 'sequelize';

import { dedupConfig } from '../dedup/constants';
import { slotOfNotification } from '../dedup/source-slots';
import { readStoredParse, type StoredPayment } from '../event/stored-parse';
import { isParkedTwin, type TwinProbe } from './parked-twin-rule';

/** The park reasons whose payment the owner can log from a card; only these wait as a card, join a twin or are approved. */
export const TWIN_PARK_REASONS = ['unknownAccount', 'ownTransfer', 'lowConfidence', 'unverifiedParse'];

/** The request's payment as the twin rule reads it, or `null` when it holds none. */
export const probeOf = async ({
  request,
  payment,
}: {
  request: IngestRequests;
  payment?: StoredPayment;
}): Promise<TwinProbe | null> => {
  const stored = payment ?? readStoredParse({ value: request.parsed })?.payment;
  if (!stored) return null;

  const source = request.sourceId
    ? await NotificationSources.findOne({ where: { id: request.sourceId }, attributes: ['sourceKey'] })
    : null;
  const time = new Date(typeof request.payload.time === 'string' ? request.payload.time : request.createdAt);

  return {
    payment: stored,
    time,
    slot: slotOfNotification({ sourceKey: source?.sourceKey ?? null, stage: stored.stage }),
  };
};

/** The requests that joined this one as its twin, oldest first. */
export const findJoinedTwins = ({ userId, requestId }: { userId: number; requestId: RecordId }) =>
  IngestRequests.findAll({
    where: { userId, pipeline: 'notification', status: 'dismissed', reason: 'parkedTwin', duplicateOfId: requestId },
    order: [['createdAt', 'ASC']],
  });

/** The slots the requests that joined this one hold, so a second request of a slot never joins. */
export const joinedSlots = async ({ twins }: { twins: IngestRequests[] }): Promise<string[]> => {
  const slots: string[] = [];
  for (const twin of twins) {
    const probe = await probeOf({ request: twin });
    if (probe) slots.push(probe.slot);
  }

  return slots;
};

/** A waiting request that is the twin of another, with the reading the rule used. */
export interface ParkedTwin {
  request: IngestRequests;
  probe: TwinProbe;
}

/**
 * The payments waiting on a card of the owner that are the same payment as this one told by another
 * source: parked requests of the user, other than this one, that the twin rule reads as its twin. Oldest
 * first, and at most one per source slot (a payment holds one request per slot, so a second request of a
 * slot is another payment: two coffees). `takenSlots` are the slots the payment already holds, its own
 * and those of the twins that joined it.
 */
export const findParkedTwins = async ({
  userId,
  requestId,
  probe,
  takenSlots = [],
}: {
  userId: number;
  requestId: RecordId;
  probe: TwinProbe;
  takenSlots?: readonly string[];
}): Promise<ParkedTwin[]> => {
  const candidates = await IngestRequests.findAll({
    where: {
      userId,
      pipeline: 'notification',
      status: 'parked',
      reason: { [Op.in]: TWIN_PARK_REASONS },
      id: { [Op.ne]: requestId },
      createdAt: { [Op.gte]: new Date(probe.time.getTime() - dedupConfig.twinWindowMs * 2) },
    },
    order: [['createdAt', 'ASC']],
    limit: 50,
  });

  const taken = new Set([probe.slot, ...takenSlots]);
  const twins: ParkedTwin[] = [];
  for (const candidate of candidates) {
    const other = await probeOf({ request: candidate });
    if (!other || taken.has(other.slot)) continue;
    // A request of a slot the candidate already holds through a twin is another payment.
    const candidateHeld = await joinedSlots({ twins: await findJoinedTwins({ userId, requestId: candidate.id }) });
    if (candidateHeld.includes(probe.slot)) continue;
    if (!isParkedTwin({ left: probe, right: other, windowMs: dedupConfig.twinWindowMs })) continue;

    twins.push({ request: candidate, probe: other });
    taken.add(other.slot);
  }

  return twins;
};
