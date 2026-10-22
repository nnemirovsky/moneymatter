import type { RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { Op } from 'sequelize';

import { dedupConfig } from '../dedup/constants';
import { slotOfNotification } from '../dedup/source-slots';
import { readStoredParse, type StoredPayment } from '../event/stored-parse';
import { isParkedTwin, type TwinProbe } from './parked-twin-rule';

/** The park reasons whose payment the owner can log from a card; only these wait as a card. */
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

/**
 * The payments waiting on a card of the owner that are the same payment as this one told by another
 * source: parked requests of the user, other than this one, that the twin rule reads as its twin.
 * Newest first.
 */
export const findParkedTwins = async ({
  userId,
  requestId,
  probe,
}: {
  userId: number;
  requestId: RecordId;
  probe: TwinProbe;
}): Promise<IngestRequests[]> => {
  const candidates = await IngestRequests.findAll({
    where: {
      userId,
      pipeline: 'notification',
      status: 'parked',
      reason: { [Op.in]: TWIN_PARK_REASONS },
      id: { [Op.ne]: requestId },
      createdAt: { [Op.gte]: new Date(probe.time.getTime() - dedupConfig.twinWindowMs * 2) },
    },
    order: [['createdAt', 'DESC']],
    limit: 50,
  });

  const twins: IngestRequests[] = [];
  for (const candidate of candidates) {
    const other = await probeOf({ request: candidate });
    if (other && isParkedTwin({ left: probe, right: other, windowMs: dedupConfig.twinWindowMs })) twins.push(candidate);
  }

  return twins;
};
