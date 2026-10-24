import { logger } from '@js/utils/logger';
import IngestRequests from '@models/ingest-requests.model';
import { refreshProposal } from '@services/chat/proposals/refresh';
import { withTransaction } from '@services/common/with-transaction';
import { Op } from 'sequelize';

import { absorbParkedTwin } from '../twins/absorb-parked-twin';
import { TWIN_PARK_REASONS } from '../twins/find-parked-twins';
import { lockTwins } from '../twins/lock-twins';
import { CONVERSION_WINDOW_MS } from './conversion-rule';
import { findConversionPartner } from './find-conversion-partner';

/** How far back the waiting requests are looked at: a pair is at most `CONVERSION_WINDOW_MS` apart. */
const LOOKBACK_MS = 6 * 60 * 60_000;
const WAITING_LIMIT = 50;

/**
 * Joins the two notifications of one currency exchange that wait on cards of their own into the card of the earlier
 * one, the way a notification does when it is parked next to its other side. It covers pairs that were parked before
 * the exchange was recognized, or whose sides did not see each other. The later side is closed into the earlier one
 * and the earlier card is refreshed to show both. Returns how many pairs were joined.
 */
const joinWaitingExchangesImpl = async ({ userId }: { userId: number }): Promise<IngestRequests['proposalId'][]> => {
  await lockTwins({ userId });

  const waiting = await IngestRequests.findAll({
    where: {
      userId,
      pipeline: 'notification',
      status: 'parked',
      reason: { [Op.in]: TWIN_PARK_REASONS },
      createdAt: { [Op.gte]: new Date(Date.now() - LOOKBACK_MS) },
    },
    order: [['createdAt', 'ASC']],
    limit: WAITING_LIMIT,
  });
  if (waiting.length < 2) return [];

  const joinedInto: IngestRequests['proposalId'][] = [];
  const closed = new Set<string>();
  for (const request of waiting) {
    if (closed.has(request.id)) continue;

    const partner = await findConversionPartner({ request });
    if (!partner || partner.joined || closed.has(partner.request.id)) continue;

    // The earlier request keeps its card; the later one joins it.
    const [primary, later] =
      partner.request.createdAt.getTime() < request.createdAt.getTime()
        ? [partner.request, request]
        : [request, partner.request];
    if (Math.abs(primary.createdAt.getTime() - later.createdAt.getTime()) > CONVERSION_WINDOW_MS * 2) continue;

    const absorbed = await absorbParkedTwin({
      twin: later,
      intoRequestId: primary.id,
      reason: 'conversionLeg',
      parkReason: later.reason ?? undefined,
    });
    if (!absorbed) continue;

    closed.add(later.id);
    closed.add(primary.id);
    joinedInto.push(primary.proposalId);
  }

  return joinedInto;
};

const joinWaitingExchanges = withTransaction(joinWaitingExchangesImpl);

/**
 * Pairs the waiting exchanges of the user (see `joinWaitingExchangesImpl`) and refreshes the cards that changed. It runs
 * when the Automation inbox is opened, so a pair that waits as two cards becomes one without the owner doing anything.
 * A failure is logged: opening the inbox must never fail for it.
 */
export const pairWaitingExchanges = async ({ userId }: { userId: number }): Promise<void> => {
  try {
    const proposalIds = await joinWaitingExchanges({ userId });
    for (const proposalId of proposalIds) {
      if (!proposalId) continue;

      try {
        await refreshProposal({ userId, proposalId });
      } catch {
        // A card that is settled or gone has nothing to refresh.
      }
    }
  } catch (error) {
    logger.error({ message: 'Failed to pair the waiting currency exchanges', error: error as Error });
  }
};
