import type { RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import { Op } from 'sequelize';

import { readStoredParse, type StoredPayment } from '../event/stored-parse';
import { TWIN_PARK_REASONS } from '../twins/find-parked-twins';
import { CONVERSION_WINDOW_MS, hasNoMerchant, isConversionPair, type ConversionLeg } from './conversion-rule';

const timeOf = ({ request }: { request: IngestRequests }): Date =>
  new Date(typeof request.payload.time === 'string' ? request.payload.time : request.createdAt);

/** The request as the conversion rule reads it, or `null` when it holds no payment. */
export const legOf = ({
  request,
  payment,
}: {
  request: IngestRequests;
  payment?: StoredPayment;
}): ConversionLeg | null => {
  const stored = payment ?? readStoredParse({ value: request.parsed })?.payment;

  return stored ? { payment: stored, time: timeOf({ request }), sourceId: request.sourceId } : null;
};

/** The request that joined this one as the other side of its exchange, if one did. */
export const findJoinedConversionLeg = ({
  userId,
  requestId,
  lock = false,
}: {
  userId: number;
  requestId: RecordId;
  lock?: boolean;
}) =>
  IngestRequests.findOne({
    where: { userId, pipeline: 'notification', status: 'dismissed', reason: 'conversionLeg', duplicateOfId: requestId },
    lock,
  });

/** The other side of an exchange: a request, and whether it already joined (`joined`) or still waits on a card of its own. */
export interface ConversionPartner {
  request: IngestRequests;
  joined: boolean;
}

/**
 * The waiting parked requests of the same source that the conversion rule reads as the opposite side of `leg`,
 * other than `requestId`; a request that is itself the primary of another exchange is not a candidate.
 */
const findCandidates = async ({
  userId,
  sourceId,
  requestId,
  leg,
}: {
  userId: number;
  sourceId: RecordId;
  requestId: RecordId;
  leg: ConversionLeg;
}): Promise<IngestRequests[]> => {
  const rows = await IngestRequests.findAll({
    where: {
      userId,
      pipeline: 'notification',
      status: 'parked',
      reason: { [Op.in]: TWIN_PARK_REASONS },
      sourceId,
      id: { [Op.ne]: requestId },
      createdAt: { [Op.gte]: new Date(leg.time.getTime() - CONVERSION_WINDOW_MS * 2) },
    },
    order: [['createdAt', 'ASC']],
    limit: 20,
  });

  const matches: IngestRequests[] = [];
  for (const row of rows) {
    const other = legOf({ request: row });
    if (!other || !isConversionPair({ left: leg, right: other })) continue;
    if (await findJoinedConversionLeg({ userId, requestId: row.id })) continue;

    matches.push(row);
  }

  return matches;
};

/**
 * The other side of the currency exchange this request is one side of: the request that joined it, else
 * the one waiting parked request of the same source that the conversion rule reads as the opposite
 * side. Two or more candidates are no answer (two exchanges at once), seen from either side: a candidate
 * that has another candidate of its own is not paired either. Null when the request is no side of an exchange.
 */
export const findConversionPartner = async ({
  request,
  payment,
}: {
  request: IngestRequests;
  payment?: StoredPayment;
}): Promise<ConversionPartner | null> => {
  const leg = legOf({ request, payment });
  if (!leg) return null;

  // A side that joined by the owner's word (a lone notice logged as a transfer) is the other side whatever the notice names.
  const joined = await findJoinedConversionLeg({ userId: request.userId, requestId: request.id });
  if (joined) return { request: joined, joined: true };

  if (!hasNoMerchant(leg.payment) || !request.sourceId) return null;

  const { userId, sourceId } = request;
  const matches = await findCandidates({ userId, sourceId, requestId: request.id, leg });
  const [match] = matches;
  if (matches.length !== 1 || !match) return null;

  // The match must have no other candidate than this request (which may not be parked yet, so it is not found).
  const matchLeg = legOf({ request: match });
  const rivals = matchLeg ? await findCandidates({ userId, sourceId, requestId: match.id, leg: matchLeg }) : [];

  return rivals.every((rival) => rival.id === request.id) ? { request: match, joined: false } : null;
};
