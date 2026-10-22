import type IngestRequests from '@models/ingest-requests.model';
import { withTransaction } from '@services/common/with-transaction';

import { readStoredParse, type StoredPayment } from '../event/stored-parse';
import { absorbParkedTwin } from './absorb-parked-twin';
import { findJoinedTwins, findParkedTwins, joinedSlots, probeOf } from './find-parked-twins';
import { lockTwins } from './lock-twins';

/**
 * The payments waiting on a card that are the same payment as this request's, absorbed into it: used
 * when the request is logged (or joins a logged row) and its twin, told by another source and parked on
 * an account nobody linked yet, would otherwise be logged a second time on the owner's yes. Nothing is
 * learned from them here: the owner has not chosen an account for their cards.
 */
const absorbWaitingTwinsImpl = async ({
  request,
  payment,
}: {
  request: IngestRequests;
  payment?: StoredPayment;
}): Promise<IngestRequests[]> => {
  await lockTwins({ userId: request.userId });

  const probe = await probeOf({ request, payment: payment ?? readStoredParse({ value: request.parsed })?.payment });
  if (!probe) return [];

  const joined = await findJoinedTwins({ userId: request.userId, requestId: request.id });
  const twins = await findParkedTwins({
    userId: request.userId,
    requestId: request.id,
    probe,
    takenSlots: await joinedSlots({ twins: joined }),
  });
  const absorbed: IngestRequests[] = [];
  for (const { request: twin } of twins) {
    if (await absorbParkedTwin({ twin, intoRequestId: request.id })) absorbed.push(twin);
  }

  return absorbed;
};

export const absorbWaitingTwins = withTransaction(absorbWaitingTwinsImpl);
